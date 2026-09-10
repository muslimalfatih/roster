# roster — Requirements

## 1. Overview

`roster` is a minimal class-based booking system that lets a parent book a seat for their child
in a class with limited capacity (4 seats). It focuses on correct handling of concurrency, the
payment flow, and edge cases, with a simple frontend to demonstrate the flow.

Scope is intentionally small to prioritise correctness, testability, and clarity.

---

## 2. Functional Requirements

### 2.1 Users and roles

**Parent** — view available classes; book a seat for a student; complete a mock payment; see the
result of the booking (confirmed / failed).

**Admin / Teacher** — view the confirmed roster for a class (students with confirmed bookings and
seat numbers).

No authentication or authorization is implemented in this version; roles are conceptual only.

### 2.2 Core use cases

#### UC1 — View available classes
*Actor:* Parent, Admin · *Trigger:* user opens the app · *Precondition:* classes and seats seeded.

1. System displays each class with name, start time, capacity (4), and number of confirmed bookings.

*Postcondition:* user can select a class to book or to view its roster.

#### UC2 — Create a booking (reserve a seat)
*Actor:* Parent · *Trigger:* parent selects a class and student and clicks "Create booking".
*Preconditions:* the student exists; the class exists.

1. Parent selects a student and a class.
2. System attempts to claim an available seat, using a row-level lock on a `class_seats` row.
3. On success the seat goes `available → locked` and a booking is created as `PENDING_PAYMENT`.
4. System returns the booking, including the seat number.

*A1 — no seat available:* return "Class is full". No booking is created.

*Postcondition:* on success exactly one seat is locked and one `PENDING_PAYMENT` booking exists;
on failure neither.

#### UC3 — Complete payment for a booking
*Actor:* Parent · *Trigger:* "Pay (success)" or "Pay (fail)" on a `PENDING_PAYMENT` booking.
*Preconditions:* the booking is `PENDING_PAYMENT`; its seat is `locked`.

1. Parent triggers payment with `mockSuccess = true`.
2. In one transaction the system verifies the booking is still `PENDING_PAYMENT`, verifies the seat
   is still `locked` and still held by this booking, moves the seat `locked → booked`, moves the
   booking `PENDING_PAYMENT → CONFIRMED`, and records a `SUCCESS` payment attempt.
3. Returns "Booking confirmed".

*A1 — payment failure:* booking → `PAYMENT_FAILED`, seat `locked → available`, a `FAILED` payment
attempt is recorded, returns "Payment failed".

*A2 — booking already processed:* status is not `PENDING_PAYMENT`; return the existing status and
change nothing. This is the basic idempotency guarantee for retries.

*A3 — class full at payment time (last-seat race):* between booking creation and payment the hold
lapsed and another parent took the seat. The booking goes to `PAYMENT_FAILED`, the seat is left
with its new owner, no charge is recorded, and the response says "Class is full".

*Postcondition:* on success one seat `booked` and one booking `CONFIRMED`; on failure the seat is
`available` again (unless another booking now owns it) and the booking is `PAYMENT_FAILED`.

#### UC4 — View class roster
*Actor:* Admin / Teacher · *Trigger:* user opens the roster view.

1. System returns all `CONFIRMED` bookings for the class with student name and seat number.

#### UC5 — Prevent duplicate bookings for the same student + class
*Actor:* System · *Trigger:* any attempt to create a second active booking for the same pair.

1. Uniqueness is enforced at the database level (partial unique index).
2. Any second active booking for the same `(student, class)` fails with a clear error.

*Postcondition:* at most one active booking per student per class.

### 2.3 Data and seed requirements

Seed data must demonstrate: a class with available seats; a class with exactly 3 confirmed bookings
(1 seat left) for last-seat race testing; the ability to attempt a duplicate booking for the same
student + class; and the ability to simulate a payment failure.

---

## 3. Non-Functional Requirements

### 3.1 Correctness and consistency

| # | Requirement |
|---|---|
| **NFR1** | **No overbooking.** Never more than `capacity` confirmed bookings for a class, including under concurrent requests. |
| **NFR2** | **No duplicate confirmed bookings.** At most one active (`PENDING_PAYMENT` or `CONFIRMED`) booking per `(student, class)`. |
| **NFR3** | **Payment failure safety.** A failed payment must never produce a `CONFIRMED` booking or a `booked` seat. |
| **NFR4** | **Last-seat race correctness.** With multiple users competing for the last seat, exactly one ends `CONFIRMED`; the rest fail with a clear "Class is full". |

These invariants must be guaranteed by the backend and database, **not** by frontend checks.

### 3.2 Concurrency and locking

| # | Requirement |
|---|---|
| **NFR5** | **Row-level locking.** Seat claims and payment completions use `SELECT ... FOR UPDATE` to serialise conflicting writes. |
| **NFR6** | **Minimal blocking.** Where practical use `FOR UPDATE NOWAIT` *or similar patterns* to fail fast instead of holding HTTP connections open waiting for locks. |
| **NFR7** | **Clear failure modes.** Lock conflicts and race losses must produce distinguishable errors ("Class is full" vs "Booking not found"). |

### 3.3 Performance and scalability (within scope)

| # | Requirement |
|---|---|
| **NFR8** | Typical API responses complete in < 200–300 ms locally. |
| **NFR9** | Handle at least 10–20 concurrent requests competing for the last seat without violating NFR1–NFR4, demonstrated by k6. |
| **NFR10** | No premature optimisation — sharding, caching and distributed locks are out of scope. |

### 3.4 Reliability and fault tolerance

| # | Requirement |
|---|---|
| **NFR11** | **Transactional integrity.** All booking/seat state changes happen in transactions; partial updates are never externally visible. |
| **NFR12** | **Graceful degradation.** Database errors return 5xx with a generic message; internal details never leak to the client. |
| **NFR13** | **Basic idempotency.** Repeated payment completion for the same booking must not corrupt state; status transitions are the minimum mechanism. Full idempotency-key support is a documented future improvement. |

### 3.5 Observability and maintainability

| # | Requirement |
|---|---|
| **NFR14** | Booking creation, payment completion, and failures (class full, duplicate) are logged at an appropriate level. |
| **NFR15** | The implementation is small enough to walk through in a 5–8 minute video; critical sections are commented. |
| **NFR16** | k6 load tests verify last-seat race behaviour and duplicate booking prevention; manual verification steps are documented for payment failure and basic flows. |

### 3.6 Security (minimal but sensible)

| # | Requirement |
|---|---|
| **NFR17** | No sensitive data exposed or logged beyond what the mock flow needs. |
| **NFR18** | All API inputs validated (types, required fields) before use in queries. |
| **NFR19** | CORS configured to allow only the frontend origin in a deployed setting. |

### 3.7 Deployment and operations

| # | Requirement |
|---|---|
| **NFR20** | Backend deployable as a Docker container (for Dokploy). |
| **NFR21** | Database URL, CORS origin and other config supplied via environment variables. |
| **NFR22** | Simple local setup: one command for the DB, one for the API, one for the frontend. |
| **NFR23** | README covers running locally, deploying, and running the k6 tests. |

### 3.8 Out of scope (explicitly)

No authentication or authorization · no real payment gateway · no email/SMS notifications ·
no complex UI or design polish · no background job for lock expiry (described as a future
improvement; at claim time a lapsed hold is instead reclaimed lazily — both the seat, which
becomes claimable again, and the stale `PENDING_PAYMENT` booking behind it, which is settled
so it stops blocking that parent under I3) · no advanced observability
(metrics, tracing) beyond basic logging.

These are deferred to "what I would do next with more time".

---

## 4. Success criteria

The implementation is successful if:

- All functional use cases (UC1–UC5) work as described.
- NFR1–NFR16 are met at a level sufficient to pass manual testing of the core flows and the k6
  load tests for concurrency and duplicate booking.
- The codebase and architecture can be clearly explained in a 5–8 minute walkthrough.
