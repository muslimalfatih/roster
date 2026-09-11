# Design notes

The long version of how roster stays correct under concurrency: the seat-row model, the two
transactions, what was measured, what the tests actually defend, and how each requirement in
[REQUIREMENTS.md](REQUIREMENTS.md) is met. The [README](../README.md) has the short version.

---

## Verify from the shell


With the API running (`pnpm dev`) and the DB freshly seeded (`pnpm db:reset`). Needs `jq`.

```sh
API=http://localhost:3000          # match PORT in apps/api/.env

FULL=$(curl -s $API/api/classes | jq -r '.[]|select(.seatsAvailable==0)|.id')   # English Trial, 4/4
LAST=$(curl -s $API/api/classes | jq -r '.[]|select(.seatsAvailable==1)|.id')   # Math Trial, 3/4
KID=$( curl -s $API/api/students | jq -r '[.[]|select(.name|startswith("Load Test Child"))][0].id')
KID2=$(curl -s $API/api/students | jq -r '[.[]|select(.name|startswith("Load Test Child"))][1].id')
POST() { curl -s -X POST $API/api/$1 -H 'content-type: application/json' -d "$2"; echo; }
```

**1. Overbooking is rejected** — book into the class that is already 4/4:

```sh
POST bookings "{\"studentId\":\"$KID\",\"classId\":\"$FULL\"}"
# {"error":"class_full","message":"This class has no seats left."}     HTTP 409
```

**2. Duplicate booking is rejected** — take the last seat, then try the same child again:

```sh
BID=$(curl -s -X POST $API/api/bookings -H 'content-type: application/json' \
        -d "{\"studentId\":\"$KID\",\"classId\":\"$LAST\"}" | jq -r .id)
POST bookings "{\"studentId\":\"$KID\",\"classId\":\"$LAST\"}"
# {"error":"duplicate_booking",...}                                    HTTP 409
```

**3. A failed payment never reaches the roster** — decline, then look at the seat counts:

```sh
POST payments/complete "{\"bookingId\":\"$BID\",\"mockSuccess\":false}"
# {"status":"PAYMENT_FAILED","outcome":"payment_declined",...,"seatNo":null}
curl -s $API/api/classes | jq -c '.[]|{name,confirmedCount,seatsAvailable}'
# Math Trial is back to confirmedCount 3, seatsAvailable 1 — the seat was released
curl -s $API/api/classes/$LAST/roster | jq length      # still 3
```

**4. Payment is idempotent** — pay twice with the same booking id:

```sh
BID=$(curl -s -X POST $API/api/bookings -H 'content-type: application/json' \
        -d "{\"studentId\":\"$KID2\",\"classId\":\"$LAST\"}" | jq -r .id)
POST payments/complete "{\"bookingId\":\"$BID\",\"mockSuccess\":true}"   # outcome: confirmed
POST payments/complete "{\"bookingId\":\"$BID\",\"mockSuccess\":true}"   # outcome: already_processed
```

**5. The last-seat race** — the two commands that matter:

```sh
cd apps/api && bun test -t "storm the last seat"   # 12 parents, one seat, over real HTTP
./tests/load/run.sh booking-last-seat              # 20 k6 VUs, one seat; echo $? -> 0
```

---

---

## The last-seat race


### The approach

Each class has exactly `capacity` rows in `class_seats`, created once with
`generate_series(1, capacity)`. Booking **counts nothing**. It claims a *row*:

```sql
SELECT id, seat_no FROM class_seats
 WHERE class_id = $1
   AND (status = 'available' OR (status = 'locked' AND pending_until < now()))
 ORDER BY seat_no LIMIT 1
 FOR UPDATE SKIP LOCKED;
```

`createBooking` runs one transaction: INSERT the booking first (so a duplicate is rejected by the
index before any seat is touched), claim a seat row, lock it, attach `seat_id`. `completePayment`
runs a second transaction: lock the booking → replay guard → lock the seat → **"is this seat still
mine?"** (`status='locked' AND held_by_booking_id = booking.id`) → confirm / decline / seat-lost.
Lock order is always `bookings → class_seats`, in both functions, so they cannot deadlock against
each other.

### Why

Counting confirmed bookings and comparing to capacity has a window between the count and the
insert. Every fix for that window is a lock somewhere. Since a lock is unavoidable, put it on the
thing being sold: the seat row *is* the inventory, the mutex, and the audit record of who holds it.
There is then no count to get wrong and no window to race through — `capacity` seat rows plus
"one confirmed booking per seat" gives `confirmed ≤ capacity` as an arithmetic consequence.

The ownership re-check at payment time exists because a hold can lapse between booking and payment.
Without it, a parent who came back after the hold expired would confirm a seat somebody else now
owns.

### SKIP LOCKED vs NOWAIT — measured, not assumed

NFR6 asks for `FOR UPDATE NOWAIT` "or similar patterns". Both were implemented and benchmarked
against this Postgres:

| scenario | `FOR UPDATE SKIP LOCKED` | `FOR UPDATE NOWAIT` |
|---|---|---|
| empty 4-seat class, 4 concurrent parents | **4 seats claimed** (seats 1,2,3,4) | 1 claimed, **3 × 55P03** while 3 seats sat empty |
| last seat, 20 concurrent parents | 1 claimed, **19 clean `class_full`** | 1 claimed, **19 × 55P03** |

`ORDER BY seat_no LIMIT 1` makes every concurrent transaction aim at the *same* first free row.
`SKIP LOCKED` steps over rows a rival holds and takes the next free one inside the same scan;
`NOWAIT` aborts the whole statement. `55P03` (`lock_not_available`) is a lock error, not a business
error, which violates NFR7's "distinguishable failure modes". SKIP LOCKED wins on both counts.
The decision is recorded in `apps/api/src/services/booking.ts` at the claim query.

### Where losers lose, and what that costs

Under this model **most losers are rejected at booking time**, not at payment time: the single free
row is either held by the winner's lock (skipped → 0 rows) or already committed as `locked` with a
live `pending_until` (predicate false → 0 rows). Either way, a 409 comes back immediately without
parking an HTTP connection on a lock — the fail-fast behaviour NFR6 asks for. That is asserted by
`rejected_at_booking == VUS-1` and `rejected_at_payment == 0` in `tests/load/booking-last-seat.js`.

The payment-time loss path (UC3-A3: *my hold lapsed and someone else took my seat*) is still real,
just not reachable in a sub-second k6 run — it needs clock control, so it is covered by the bun
suite: `UC3-A3: A holds the last seat, A's hold lapses, B pays and wins it, A loses cleanly`.

### Tradeoffs this design accepts

| tradeoff | consequence |
|---|---|
| A booking transaction holds a pooled connection for its whole duration | pool size (`max: 10` in `src/db.ts`) bounds concurrent bookings; past that, requests queue in the driver. |
| A lapsed hold is reclaimed **lazily**, at the next claim | a stale `PENDING_PAYMENT` booking can outlive the seat it names. Its parent is not stuck (the next booking attempt settles it to `CANCELLED`), but nothing marks it dead until someone acts. |
| No sweeper | the count of stale `PENDING_PAYMENT` bookings only shrinks when the same parent or another one touches that class. This is a leak I chose to accept and monitor, not one I missed. |
| `ORDER BY seat_no LIMIT 1` | seat numbers are handed out low-first, so under low load parents cluster on seat 1 and contend more than a random pick would. Predictable seat numbers were worth more than that. |

### Alternatives considered and rejected

| alternative | why not |
|---|---|
| `SERIALIZABLE` isolation | needs a retry-on-40001 loop in every write path, and turns a race loss into a serialisation error that must be translated back into "class full". More machinery, same outcome. |
| Advisory locks (`pg_advisory_xact_lock(class_id)`) | the lock is not tied to the data. Nothing stops a future code path writing seats without taking it, and it serialises the whole class rather than one seat. |
| `seats_taken` counter with `CHECK (seats_taken <= capacity)` | still needs a row lock on the parent `classes` row (same serialisation, coarser), and loses per-seat identity — no seat numbers, no "who holds this seat". |
| `FOR UPDATE NOWAIT` | measured above: spurious "class full" on a class with free seats, and lock errors instead of business errors. |

---

---

## Backend and data model


### Data model

| table | columns that matter | role |
|---|---|---|
| `parents` | `id, name, email UNIQUE` | who books |
| `students` | `id, parent_id, name` | who sits |
| `classes` | `id, name, starts_at, capacity` (4) | the class |
| **`class_seats`** | `id, class_id, seat_no, status, pending_until, held_by_booking_id` | **the inventory AND the mutex.** One row per physical seat. |
| `bookings` | `id, student_id, class_id, seat_id, status, created_at, updated_at` | a parent's claim on a seat |
| `payment_attempts` | `id, booking_id, status, amount_cents, provider_ref, failure_code` | audit trail of every mock charge |

Full DDL with the reasoning in [`apps/api/db/schema.sql`](../apps/api/db/schema.sql).

### The three invariants

| # | Statement | Enforced by |
|---|---|---|
| **I1** | a class has exactly `capacity` seat rows | `generate_series(1, capacity)` at creation (`db/seed.sql`, `tests/helpers.ts`) + `UNIQUE (class_id, seat_no)` keeping them distinct. No class-admin API exists, so nothing adds seats later. |
| **I2** | a seat backs at most one `CONFIRMED` booking | partial unique index `bookings_one_confirmed_per_seat` |
| **I3** | at most one *active* booking per `(student, class)` | partial unique index `bookings_one_active_per_student_class`, covering only `PENDING_PAYMENT` and `CONFIRMED` — so a parent whose payment failed may try again |

**I1 + I2 ⇒ confirmed bookings ≤ capacity.** No application code counts anything.

Three CHECK constraints keep a seat row internally consistent: an `available` seat carries no hold
and no owner, a `locked` seat must carry a deadline, a `booked` seat must not.

### Seat state machine

```
                 claim (FOR UPDATE SKIP LOCKED)          payment ok
    available ─────────────────────────────────▶ locked ─────────────▶ booked
        ▲                                          │
        └──────────── payment declined ────────────┘
                                                   │
        (hold lapses: pending_until < now() ──▶ the row matches the claim
         predicate again and the NEXT parent takes it, no cron job)
```

### Booking state machine

```
                              pay ok            ┌── CONFIRMED         (seat booked)
    PENDING_PAYMENT ──────────────────────────▶ │
        │  │                                    └── PAYMENT_FAILED    (declined: seat released,
        │  │  pay declined ─────────────────────────▶                  charge recorded 2900c)
        │  └─ seat lost (hold lapsed, reclaimed) ──▶ PAYMENT_FAILED   (outcome class_full,
        │                                                              charge recorded 0c)
        └──── same parent re-books after the hold lapsed ──▶ CANCELLED
```

`PAYMENT_FAILED` and `CANCELLED` are outside I3, which is what lets a parent retry.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | liveness: `{"ok":true}`. Does not touch the database — this is what the Docker healthcheck polls |
| `GET` | `/api/ready` | readiness: `SELECT 1`, `200` if the database answers and `503` if it does not. Point uptime monitoring here |
| `GET` | `/api/students` | students with their parent's name |
| `GET` | `/api/classes` | UC1: each class + `confirmedCount`, `seatsAvailable`, `seatsLocked`, read straight off the seat rows |
| `GET` | `/api/classes/:classId/roster` | UC4: `CONFIRMED` bookings only, in seat order |
| `POST` | `/api/bookings` | UC2: `201` + booking with `seatNo`; `409 class_full`; `409 duplicate_booking`; `404 not_found` |
| `POST` | `/api/payments/complete` | UC3: always `200` for a known booking; the verdict is `outcome` in the body (`confirmed` / `payment_declined` / `class_full` / `already_processed`) |

Errors are `{ error, message }` with `error ∈ {duplicate_booking, class_full, not_found,
invalid_request, internal_error}`. Schema-validation failures are Elysia's own `422`.

### Which check lives where

| Layer | What it does | Is it a guarantee? |
|---|---|---|
| **UI** (`apps/web`) | greys out a "FULL" class, disables Book, shows the backend's error code verbatim | **No — cosmetic.** `seatsAvailable` is a stale render; seats move between the render and the request. The UI never re-derives a verdict. |
| **Backend** (`apps/api/src/services/booking.ts`) | transaction boundaries, lock order, status transitions, the seat-ownership re-check, payment records, error mapping | Correct *sequencing*, not the invariant. It owns "who may transition what, when". |
| **Database** (`db/schema.sql`) | `capacity` seat rows, `FOR UPDATE SKIP LOCKED` on the claim, two partial unique indexes, four CHECK constraints, FKs | **Yes. Only these are guarantees.** They hold even if the application is wrong, restarted mid-flight, or run in N processes. |
| **Background job** | *nothing* | There is no sweeper. Hold expiry is lazy, inside the claim predicate. See "what I'd do next". |

---

---

## Testing and verification


**19 integration tests**, one file, over **real HTTP against real Postgres** — no mocks, no
in-memory DB, no `app.handle()` (which silently 404s in Elysia 1.4.30, so the suite binds a real
ephemeral port). Schema + seed are re-applied before every test, so the file is order-independent.

```
cd apps/api && bun test     ->  19 pass / 0 fail / 136 expect() calls
```

**Three k6 scripts**, where every invariant is a `threshold`, so a violation exits non-zero instead
of printing a number nobody reads: `booking-last-seat` (20 VUs on one seat), `booking-duplicate`
(15 VUs, same child, same class), `payment-failure` (declines must return their seats). Detail per
threshold in [tests/load/README.md](../tests/load/README.md). Latency under full contention, measured
across runs against NFR8's 200–300 ms budget: booking p95 **20–45 ms**, payment p95 **4–14 ms**.

### Mutation testing — the part that matters

Passing tests prove nothing about tests. Each of these was applied to the real code, both suites
re-run, then reverted:

| Mutation | Result |
|---|---|
| delete `FOR UPDATE SKIP LOCKED` from the seat claim | **caught** — bun: the headline race test and the parallel-fill test fail (3/3 runs); k6 `booking-last-seat` exits **99** on `rejected_at_booking` / `rejected_at_payment` |
| `SKIP LOCKED` → `NOWAIT` | **caught** — the same two bun tests fail, 3/3 runs |
| remove the payment replay guard | **caught** — the UC3-A2 idempotency test fails |
| decline stops releasing the seat | **caught** — two bun tests fail; k6 `payment-failure` exits 99 |
| swallow the duplicate `23505` | **caught** — k6 `booking-duplicate` exits 99 |
| widen `bookings_one_active_per_student_class` to also cover `PAYMENT_FAILED` | **caught** — the re-book-after-decline test fails |
| `SKIP LOCKED` → plain `FOR UPDATE` | **survives, correctly** — under READ COMMITTED the waiter re-evaluates the predicate after acquiring the lock (EvalPlanQual), the row no longer qualifies, and it gets a clean `class_full`. Same observable behaviour, only serialised. This is the honest ceiling of the suite: it tests behaviour, and the behaviour is genuinely identical. |
| drop the `bookings_one_confirmed_per_seat` index | **survives** — it is defence in depth, unreachable while the seat row lock holds. Kept as a backstop that would catch a future code path claiming a seat without the lock; acknowledged as untested by construction. |

### Two false passes that were found and fixed

Both were *test* bugs, not implementation bugs, and both were the same class of bug: **a correct end
state reached through a broken path.**

1. **The bun headline race test** asserted only the end state (`confirmed == 1`, roster == 4). With
   the row lock deleted, ten parents each got a `201` for the *same* seat, and `completePayment`'s
   ownership check then narrowed them back to one confirmation. Final tally correct; nine parents
   shown a payment screen for a seat that was never theirs. **Fix:** a strictly stronger assertion —
   exactly one parent may ever be *handed* the seat (one 201, one distinct `seatNo`).
2. **`booking-last-seat.js`** had the identical hole: `confirmed: count==1` and
   `rejected_cleanly: count==19` both stayed green with the lock removed. **Fix:** added
   `rejected_at_booking == VUS-1` and `rejected_at_payment == 0`. Re-verified while writing this
   README: with the lock deleted, `confirmed=1` and `rejected_cleanly=19` still pass, while
   `rejected_at_booking=14` and `rejected_at_payment=5` fail and k6 exits 99.

The pool priming in `tests/helpers.ts` and in each k6 `setup()` is load-bearing for the same reason:
cold Bun-fetch and postgres.js pools grow one connection at a time, so a first burst runs nearly
serially — and a serial run satisfies the invariant *even with the locking removed*. Removing the
priming would make every race test vacuous.

---

---

## Requirements traceability


Against [docs/REQUIREMENTS.md](REQUIREMENTS.md). Test names are as they appear in
`apps/api/tests/booking.test.ts`.

| Req | Where | Status |
|---|---|---|
| **UC1** view classes | `src/routes/classes.ts` `GET /api/classes`; `apps/web/src/routes/classes.tsx`; test *UC1: a lapsed hold counts as available, a live hold counts as locked* | met |
| **UC2** create booking | `src/services/booking.ts` `createBooking`; `src/routes/bookings.ts`; tests *NFR4: four parents fill an empty 4-seat class…*, *UC2-A1: booking into an already-full class…* | met |
| **UC3** complete payment | `src/services/booking.ts` `completePayment`; `src/routes/payments.ts`; tests *UC3-A1 …decline…*, *UC3-A2/NFR13 …idempotent…*, *UC3-A3 …A loses cleanly* | met |
| **UC4** view roster | `src/routes/classes.ts` `GET /api/classes/:classId/roster`; `apps/web/src/routes/roster.tsx` | met |
| **UC5** no duplicates | index `bookings_one_active_per_student_class`; `createBooking` catch → 409; 4 tests in *I3 duplicate prevention*; k6 `booking-duplicate` | met |
| **NFR1** no overbooking | I1 + I2 in `db/schema.sql`; tests *…12 parents storm the last seat…*, *NFR1: structurally, every class has confirmed ≤ capacity…*; k6 `confirmed: count==1` | met |
| **NFR2** no duplicate confirmed | I3; same tests as UC5 | met |
| **NFR3** payment-failure safety | `completePayment` decline branch; tests *UC3-A1 …releases the seat…*, *MONEY SAFETY…*; k6 `payment-failure` | met |
| **NFR4** last-seat race | headline bun test + k6 `booking-last-seat` | met |
| **NFR5** row-level locking | `FOR UPDATE SKIP LOCKED` on the seat claim; `FOR UPDATE` on the booking and on the seat in `completePayment` | met |
| **NFR6** minimal blocking | `SKIP LOCKED` ("or similar patterns"); losers get 409 without waiting on a lock; k6 `rejected_at_booking == 19`. Deviation from the literal `NOWAIT` is measured and documented above. | met |
| **NFR7** clear failure modes | `src/errors.ts` + `ApiError` codes: `class_full` vs `duplicate_booking` vs `not_found`; k6 `http_5xx: count==0` | met |
| **NFR8** < 200–300 ms | k6 thresholds `p(95)<300` on the `endpoint:booking` and `endpoint:payment` sub-metrics of `http_req_duration`, all green under contention | met |
| **NFR9** 10–20 concurrent | k6 20 VUs on one seat; bun test with 12 concurrent parents | met |
| **NFR10** no premature optimisation | no cache, no sharding, no distributed lock; one pool | met |
| **NFR11** transactional integrity | `sql.begin(...)` in both service functions; test *UC2-A1 …moves no seat* asserts the rollback leaves no orphan booking | met |
| **NFR12** graceful degradation | single `onError` in `src/app.ts`; test *NFR12/NFR17: no error body leaks a driver message, a stack trace, or the connection string* | met |
| **NFR13** basic idempotency | replay guard in `completePayment` (mutates nothing); test *UC3-A2/NFR13*. Idempotency **keys** are explicitly a future improvement in the requirement itself. | met |
| **NFR14** logging | `src/log.ts`; `booking.created` / `booking.rejected` / `payment.completed` one-line JSON | met |
| **NFR15** walkable in 5–8 min | [docs/slides.html](slides.html); critical sections carry comments | met |
| **NFR16** k6 + manual steps | `tests/load/*` + [tests/load/README.md](../tests/load/README.md); "Verify the interesting behaviour" above | met |
| **NFR17** no sensitive data | `src/log.ts` logs ids and outcomes only; the leak test above | met |
| **NFR18** input validation | `t.Object` schemas on every route incl. the uuid path param; `PARSE` → `400 invalid_request`; 4 tests in *boundaries* | met |
| **NFR19** CORS | `@elysiajs/cors` pinned to `CORS_ORIGIN` in `src/app.ts`; unset means "reflect any origin", acceptable locally only — [docs/DEPLOYMENT.md](DEPLOYMENT.md) covers the deployed handshake | met |
| **NFR20** Docker container | `apps/api/Dockerfile` (repo-root build context, pnpm workspace) + `docker-compose.yml`; builds unmodified and runs healthy under `docker compose up` | met |
| **NFR21** env config | `src/env.ts` (fails fast on a missing `DATABASE_URL`); `.env.example` | met |
| **NFR22** simple local setup | `pnpm db:reset`, `pnpm dev:api`, `pnpm dev:web` (or `pnpm dev` for both) | met |
| **NFR23** README covers local / deploy / k6 | this file + [docs/DEPLOYMENT.md](DEPLOYMENT.md) + [tests/load/README.md](../tests/load/README.md) | met |
| **3.8** out of scope | auth, real gateway, notifications, UI polish, sweeper, metrics/tracing | deliberate cuts, listed below |

---

---

## What I would monitor after release


| Signal | Query / source | Why |
|---|---|---|
| **Rate of `outcome='class_full'` at payment time** | `payment.completed` log events | this is the race actually firing in production. Near zero is expected; a rise means holds are lapsing before parents pay — shorten the checkout or lengthen `SEAT_HOLD_MINUTES`. |
| **Payment decline rate** | `payment_attempts` where `failure_code='card_declined'` | business health, and it separates "declined" from "lost the seat" — two very different user experiences that both end `PAYMENT_FAILED`. |
| **Stale `PENDING_PAYMENT` bookings older than the hold window** | query below | the leak this design knowingly accepts. Trending up means the lazy-expiry assumption ("someone will book that class again") is not holding and the sweeper is now worth building. |
| **Seat-claim contention and transaction duration** | `pg_stat_activity`, `pg_locks`, plus API request duration | a booking transaction holds a pooled connection; if p95 climbs, the pool is the next bottleneck, not the lock. |
| **409 `duplicate_booking` rate** | `booking.rejected` log events | a UX signal, not an error: a spike usually means double-submit on a slow connection, which is an argument for disabling the button, not for changing the index. |
| **The invariant itself — alert if it ever returns a row** | query below | everything else is a proxy. This is the actual promise. |

Stale holds:

```sql
SELECT count(*)
FROM bookings b
JOIN class_seats s ON s.id = b.seat_id
WHERE b.status = 'PENDING_PAYMENT'
  AND (s.held_by_booking_id IS DISTINCT FROM b.id OR s.pending_until < now());
```

**The invariant alert. This must always return zero rows:**

```sql
SELECT c.id, c.name,
       (SELECT count(*) FROM bookings b    WHERE b.class_id = c.id AND b.status = 'CONFIRMED') AS confirmed,
       (SELECT count(*) FROM class_seats s WHERE s.class_id = c.id)                            AS seats
FROM classes c
WHERE (SELECT count(*) FROM bookings b    WHERE b.class_id = c.id AND b.status = 'CONFIRMED')
    > (SELECT count(*) FROM class_seats s WHERE s.class_id = c.id);
```

If that ever returns a row, the storage-layer guarantee has been violated and bookings should be
halted, not patched around.

---

---
