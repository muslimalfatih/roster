# k6 load tests — concurrency evidence (NFR9, NFR16)

Three scripts. Each one is an **assertion**, not a demo: every invariant is a k6
`threshold`, so a violation makes `k6 run` exit non-zero and `run.sh` propagates that code.
A script that only printed and always exited 0 would be worthless as evidence.

## Run

```sh
./tests/load/run.sh booking-last-seat
./tests/load/run.sh booking-duplicate
./tests/load/run.sh payment-failure
echo $?          # 0 = invariants held, non-zero = a threshold failed
```

`run.sh` resets `roster_load`, starts the API against it on **:3999** (never :3000),
waits for `/api/health`, runs k6, then kills the API from an `EXIT` trap and exits with
k6's code. Override the port with `LOAD_PORT=…`, the target with `BASE_URL=…` if you run
`k6 run` by hand. Every script must be run against a freshly reset DB — the seeded state
is what puts exactly one seat on the race target.

**No hardcoded UUIDs.** `setup()` discovers the target class and the student pool from
`GET /api/classes`, `GET /api/students` and `GET /api/classes/:id/roster`, and throws
(aborting the run) if the DB is not in a state that can prove anything.

## booking-last-seat.js — the headline

20 VUs, one distinct child each, all POST `/api/bookings` at the same instant for the
class with exactly **1** seat left; a 201 is followed by a successful mock payment.

| threshold | what its failure means |
|---|---|
| `confirmed: count==1` | **overbooking or underbooking.** >1 means I1+I2 failed and two parents got the same seat; 0 means nobody could book a free seat. |
| `rejected_cleanly: count==19` | a loser got something other than a clean `class_full` — a timeout, a 422, a lock error. |
| `rejected_at_booking: count==19` | **several parents were handed the same seat.** One free seat means exactly one 201. |
| `rejected_at_payment: count==0` | same failure seen from the other side: a parent reached a payment screen for a seat that was never theirs. |
| `http_5xx: count==0` | a lock conflict or pg error escaped as a 500 instead of a business error (NFR7, NFR12). |
| `checks: rate==1.00` | includes the teardown read-back: roster has exactly `capacity` entries with distinct seat numbers, and the class reports `confirmedCount == capacity`, `seatsAvailable == 0`, `seatsLocked == 0`. |

*Every* loser is rejected at **booking** time, not at payment time: the single free seat
row is locked by the winner, `FOR UPDATE SKIP LOCKED` skips it, the SELECT returns zero
rows and the other 19 get 409 immediately without parking an HTTP connection on a lock —
that is the fail-fast behaviour NFR6 asks for.

`confirmed: count==1` on its own is **not** enough, and that is measured, not theorised.
With the row lock deleted from the seat-claim query, six parents were handed a 201 for the
same seat; `completePayment`'s `held_by_booking_id` check then narrowed them back to one
confirmation, so `confirmed=1`, `rejected_cleanly=19` and every teardown check still passed
— a correct final tally reached by showing five parents a payment screen for a seat that
was never theirs. The `rejected_at_booking==19` / `rejected_at_payment==0` pair is what
makes the deletion fail (exit 99, 3 runs out of 3). The payment-time loss path (UC3-A3, hold
lapsed and seat reclaimed) needs clock control and is covered by the bun suite instead.

## booking-duplicate.js — UC5

15 VUs book **the same student** into **the same class** simultaneously.

| threshold | what its failure means |
|---|---|
| `created: count==1` | the `bookings_one_active_per_student_class` index (I3) did not hold under interleaving. |
| `duplicate_rejected: count==14` | a duplicate got something other than 409 `duplicate_booking`. |
| `http_5xx: count==0` | a raw pg 23505 leaked as a 500 instead of being mapped to `duplicate_booking`. |
| `checks: rate==1.00` | teardown: the class lost **exactly one** seat (`seatsAvailable-1`, `seatsLocked+1`, `confirmedCount` unchanged) — proof that the 14 rejected attempts leaked no seat, because the booking INSERT happens before any seat is touched. |

## payment-failure.js — UC3-A1

N VUs (default 4, `-e VUS=…`) each claim a seat, then pay with `mockSuccess:false`.

| threshold | what its failure means |
|---|---|
| `booked: count==N` | a VU never got a seat, so it had nothing to release. |
| `declined: count==N` | a decline did not come back `payment_declined` / `PAYMENT_FAILED`. |
| `http_5xx: count==0` | a decline crashed the API. |
| `checks: rate==1.00` | teardown: `seatsAvailable` is back to its starting value, `seatsLocked` and `confirmedCount` unchanged, the roster is untouched, **and** a fresh booking on a released seat still returns 201 — the seats are genuinely reusable, not just reported as free. |

## NFR8 latency

The aggregate `http_req_duration` in the summary mixes in the `GET /api/classes` calls that
`setup()` and `teardown()` make, so it is not the number NFR8 is about. The POSTs carry an
`endpoint` tag and each script asserts `http_req_duration{endpoint:booking}` and
`{endpoint:payment}` at `p(95)<300`. Measured on this machine, all under contention:

| script | booking p95 | payment p95 |
|---|---|---|
| booking-last-seat (20 VUs on 1 seat) | 21.63 ms | 7.52 ms |
| booking-duplicate (15 VUs, same student) | 13.19 ms | — |
| payment-failure (4 VUs, decline) | 10.30 ms | 3.83 ms |

(`booking-last-seat`'s payment p95 comes from a single sample — only one VU ever reaches the
payment step, which is the whole point of the test. `payment-failure` is the payment number
with several samples behind it.)

Comfortably inside NFR8's 200-300 ms local budget, with an order of magnitude of headroom.

## Why every counter is written on every path

k6 skips a threshold on a metric that received no samples. A counter left untouched by a
broken run would therefore **pass silently**. Each script writes `counter.add(0 or 1)` on
every branch so the thresholds always have data to judge.

## Why `setup()` primes the pools

A first burst against cold pools runs near-serially — the API's postgres.js pool grows one
connection at a time — and a serial run satisfies the invariant *even with the row locking
removed*. That is a false pass, and it is the easiest way to ship a load test that proves
nothing. Each `setup()` fires a parallel `http.batch` of `GET /api/classes` first to force
the pool open. **Do not delete it.**

## Out of scope

No sweeper for lapsed holds: lazy expiry lives in the seat-claim query
(`status='locked' AND pending_until < now()`), so a lapsed hold is reclaimed by the next
booking without a background job.
