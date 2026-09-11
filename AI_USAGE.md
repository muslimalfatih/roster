# AI usage

How this project was built with AI, what was delegated and what was not, and where the model was
wrong. Written because a take-home that used AI should say so precisely — and because the useful
part is not that AI was used, but where it had to be overruled.


## Tools

| Tool | Role |
|---|---|
| Claude Code (VS Code extension), Claude Opus 5 | all code, tests, k6 scripts and docs |
| Claude Code multi-agent workflows | parallel build fan-out and adversarial review |
| `ponytail` skill | standing instruction to prefer the smallest thing that works — no speculative abstraction, no dependency for what a few lines can do |
| `interfaces:better-writing` | pass over user-facing copy, error messages, and these docs |
| `interfaces:better-ui`, `interfaces:better-layout` | building `docs/slides.html` |
| Postgres 14 via `psql`, k6, headless Chrome | verification — every claim in the README was executed, not asserted |

**MCP servers were connected but not used.** The session had database, Figma, Sanity and issue-tracker
servers available. None were reached for: this is one local Postgres, and `psql` through the shell was
more direct than a tool call. Worth recording, because "available" and "useful" are different things.

### How the work was actually organised

1. **A frozen contract, written by hand first.** `packages/types/src/index.ts` and
   `apps/api/db/schema.sql` were specified and applied to a live database before any agent ran, then
   treated as immutable. Every parallel agent agreed through that contract instead of with each other.
2. **A parallel build fan-out** — four agents on disjoint paths: API, integration tests, k6 scripts,
   frontend. No shared files, so no merge conflicts and no coordination cost.
3. **Adversarial review lenses** — separate passes for concurrency, requirements coverage, runtime
   behaviour and stale code. Every finding then had to survive a **refutation agent** whose only job
   was to reproduce the claim against the running system and reject it if it could not.

That last step matters more than it sounds. An unreproduced finding is a guess, and acting on guesses
costs more than ignoring them.

### The architecture was rewritten once

The first implementation enforced capacity by locking the parent class row and counting confirmed
bookings. It worked and its tests passed. I replaced it with the seat-row model — a fixed set of
`class_seats` rows, one confirmed booking per seat by unique index — because counting is something you
can get wrong, and a row you have to take is not. The second version has no capacity check anywhere in
the application code.

## What I used it for

| Used AI for | Wrote / specified by hand |
|---|---|
| Project scaffolding, workspace wiring, config | the schema and the three invariants (I1/I2/I3) |
| Elysia routes, error mapping, the logger | `createBooking`'s ordering (booking INSERT before seat claim) |
| The React UI (three pages, TanStack Router + Query, Tailwind) | `completePayment`'s ordering (lock → replay guard → seat → ownership check) |
| The k6 scripts and their thresholds | the lock order rule (`bookings → class_seats`, always) |
| Dockerfile, compose file, deployment notes | the money rule: a race loser is never charged |
| Test scaffolding and factories | the mutations to run against the finished suite |

The division is deliberate. Generated code is cheap to review and cheap to replace. The parts I
specified myself are the parts where a plausible-looking wrong answer would still pass every test —
which is exactly where a language model is least trustworthy and where I would be reviewing it
line-by-line anyway.

## Where it helped most

**Parallelism.** The frontend, the load tests and the container/deploy setup were built at the same
time as the backend, on separate paths, merging without conflict because the contract was frozen
first. In a 3–4 hour timebox that is the difference between "the concurrency is thoroughly proven"
and "there was no time left to prove it". Nearly all of the saved time went into the mutation pass.

**Empirical probing of library behaviour.** Several small facts were established by running code
rather than by trusting docs or model memory, and each one would have cost real debugging time:

- `app.handle(new Request(...))` — the documented way to test an Elysia app in-process — silently
  404s in 1.4.30 even after `.compile()`. Caught by a probe, not by reading.
- postgres.js resolves queries to an `Array` *subclass*, and Elysia routes a subclass through a
  different response path that drops `set.headers` — which is where `@elysiajs/cors` writes
  `access-control-allow-origin`. The body looked correct while every browser GET was blocked.
  Fixed by spreading to a plain array in `src/db.ts`.
- The field carrying a constraint name on a `23505` error has moved between postgres.js versions,
  so `isUniqueViolation` checks several fields. Getting that wrong turns a 409 into a 500 silently.
- `createdb a b c` does not create three databases; it creates one and reads the rest as the
  description. The docs say `for db in …; do createdb "$db"; done` because that was checked.

## Where it was wrong

### The generated race tests were false passes — the big one

Both the bun headline race test and the k6 last-seat thresholds were green. Both **stayed green**
when the row lock was deleted from the seat claim.

The reason is subtle and is the most valuable thing I learned building this: the end state was
correct, but it was reached through a broken path. Without the lock, ten parents each read the same
free seat row and each got a `201` for it; `completePayment`'s `held_by_booking_id` ownership check
then narrowed them back to exactly one confirmation. `confirmed == 1`. Roster correct. Seat counts
correct. Every assertion passed — while nine parents had been shown a payment screen for a seat that
was never theirs.

Only mutation testing exposed it. The fix was strictly stronger assertions in both places:

- bun: exactly one parent may ever be *handed* the seat — one `201`, one distinct `seatNo` — not
  just one confirmation at the end.
- k6: `rejected_at_booking == VUS-1` and `rejected_at_payment == 0` alongside `confirmed == 1`.

Re-verified: with the lock deleted, `confirmed=1` and `rejected_cleanly=19` still pass, while the
new pair reports `rejected_at_booking=14`, `rejected_at_payment=5`, and k6 exits 99.

Trusting the green suite here would have shipped an unproven invariant and, worse, a confident and
wrong claim about it in the walkthrough video.

### `FOR UPDATE NOWAIT` was in the spec; measurement said no

NFR6 asks for `NOWAIT` "or similar patterns". Both were implemented and benchmarked against the real
database. `NOWAIT` gives four parents booking an **empty four-seat class** one success and three
spurious "class full" errors, because `ORDER BY seat_no LIMIT 1` points them all at the same row and
`NOWAIT` aborts instead of moving on. It also reports every race loss as `55P03`
(`lock_not_available`) — a lock error, not a business error, which is exactly what NFR7 says must not
happen. Switched to `SKIP LOCKED`, and put the measurement in the README rather than the assertion.

### An earlier iteration charged the race loser

One version recorded the `payment_attempt` **before** checking whether the seat was still held. A
parent who lost the race would have been charged and then refused. Reordered so the ownership check
comes first and nothing is ever charged for a seat that cannot be delivered; the lost-seat attempt
is recorded with `amount_cents = 0` and `failure_code = 'seat_lost'` purely as an audit record.
Locked in by a test that asserts no `SUCCESS` attempt exists on any booking that ended
`PAYMENT_FAILED` (*MONEY SAFETY: losing the seat records a 0-cent failure and never a SUCCESS
charge*).

### The documented Elysia testing approach does not work in 1.4.30

`app.handle(new Request(...))` 404s silently, even after `.compile()`. An empirical probe caught it
before the test suite was built on top of it. The tests bind a real ephemeral port and speak real
HTTP instead — which turned out to be better evidence anyway, since it exercises the actual server,
CORS headers, status codes and JSON serialisation.

## What I would do differently

- **Write the mutation before trusting the test.** Never accept a generated test until it has been
  shown to fail against a deliberately broken implementation. A test that has never failed is not
  evidence, it is decoration. This would now be the first thing I do, not the last.
- **Freeze the data contract before any parallel generation.** That single step is what let four
  agents work simultaneously and merge without conflict. Without it, parallelism produces four
  incompatible views of the same domain and costs more time than it saves.
- **Probe library behaviour empirically rather than trusting docs or model memory.** Every one of
  the four issues in §3 was a confident, plausible, wrong assumption that ten seconds of running
  code disproved.
- **Treat "all green" as the start of verification, not the end of it.** The suite was green before
  the false pass was found, and it was green after. Only the delta under mutation carried
  information.
- **Make refutation a separate role.** Review agents generate findings enthusiastically; a second
  agent whose only job is to reproduce or reject them kept the fix budget on real defects.

## How I verified the final implementation

| Verification | Result |
|---|---|
| **Mutation testing on both suites** — 8 mutations applied to real code, both suites re-run, then reverted | 6 caught; 2 survive for understood reasons (plain `FOR UPDATE` is behaviourally identical under READ COMMITTED via EvalPlanQual; the `bookings_one_confirmed_per_seat` index is an unreachable backstop). Both documented in the README rather than hidden. |
| **19 integration tests** over real HTTP against real Postgres, schema + seed re-applied per test | 19 pass / 0 fail / 136 `expect()` calls |
| **Repeated runs** to catch flake in the concurrent tests | green on consecutive runs, before and after the final changes |
| **Three k6 scenarios**, every invariant expressed as a `threshold` | all exit 0 — **and each was proven to exit non-zero (99) against a deliberately broken server**, which is what makes an exit code worth reporting |
| **Live curl smoke of every endpoint and error path** | `class_full`, `duplicate_booking`, `not_found`, `invalid_request` (400 on an unparseable body), Elysia's 422 on a schema failure, `payment_declined`, `confirmed`, `already_processed` |
| **Cold-start verification of the documented setup** | the README quick start was executed against a scratch database created for the purpose and then dropped |
| **`pnpm typecheck` and `pnpm build`** | clean across all three packages; production web build succeeds |
| **Verified last** | the container build. Docker was unavailable during the build itself, so the Dockerfile was written from the workspace layout and only run afterwards — it built unmodified and came up healthy on the first `docker compose up`. |
