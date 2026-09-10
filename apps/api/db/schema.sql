-- =============================================================================
-- roster — schema
--
-- The design idea: A SEAT IS A ROW, AND A ROW IS A MUTEX.
--
-- Each class has exactly `capacity` rows in class_seats. Because seats are
-- physical rows rather than a number to be counted, overbooking is not something
-- the application has to check — it is structurally impossible:
--
--   I1  A class has exactly `capacity` seat rows. Established once at creation by
--       `generate_series(1, capacity)` (db/seed.sql, tests/helpers.ts); UNIQUE
--       (class_id, seat_no) then keeps those rows distinct. There is no class-admin
--       API, so nothing can add or remove seats afterwards.
--   I2  A seat backs at most ONE confirmed booking
--       (partial unique index `bookings_one_confirmed_per_seat`).
--   I1 + I2  =>  confirmed bookings per class <= capacity.  No counting, ever.
--
--   I3  At most one ACTIVE booking per (student, class)
--       (partial unique index `bookings_one_active_per_student_class`).
--       It covers only PENDING_PAYMENT and CONFIRMED, so a parent whose payment
--       failed, or who cancelled, may legitimately try again.
--
-- Seat lifecycle:  available --claim--> locked --pay ok--> booked
--                       ^                  |
--                       +---- decline / hold expiry ----+
--
-- Concurrency: seats are claimed with SELECT ... FOR UPDATE SKIP LOCKED, so two
-- parents booking at the same moment take DIFFERENT seat rows instead of fighting
-- over one. See apps/api/src/services/booking.ts for why SKIP LOCKED and not NOWAIT.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS parents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  email      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS classes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  starts_at  timestamptz NOT NULL,
  capacity   int  NOT NULL DEFAULT 4 CHECK (capacity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per physical seat. This table IS the inventory and IS the lock target.
CREATE TABLE IF NOT EXISTS class_seats (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id           uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  seat_no            int  NOT NULL CHECK (seat_no > 0),
  status             text NOT NULL DEFAULT 'available'
                       CHECK (status IN ('available', 'locked', 'booked')),
  -- When a seat is `locked`, the hold expires at this time. A lapsed hold is
  -- reclaimable by the next parent — lazy expiry, so no cron job is required.
  pending_until      timestamptz,
  -- Which booking currently owns this seat. This is how payment completion can
  -- tell "my hold is still mine" from "my hold lapsed and someone else took it".
  held_by_booking_id uuid,
  UNIQUE (class_id, seat_no),
  -- A released seat must be fully released: no stale hold, no stale owner.
  CONSTRAINT class_seats_available_is_clean CHECK (
    status <> 'available' OR (pending_until IS NULL AND held_by_booking_id IS NULL)
  ),
  -- A held seat must name its owner.
  CONSTRAINT class_seats_held_has_owner CHECK (
    status = 'available' OR held_by_booking_id IS NOT NULL
  ),
  -- A `locked` seat MUST carry a deadline. Without this, a row could sit at
  -- status='locked' with pending_until NULL: it would never match the claim
  -- predicate (NULL < now() is NULL, not true) and never be counted as available
  -- or locked by GET /api/classes — a seat silently deleted from inventory.
  CONSTRAINT class_seats_locked_has_deadline CHECK (
    status <> 'locked' OR pending_until IS NOT NULL
  ),
  -- A `booked` seat is settled: no hold deadline should survive confirmation.
  CONSTRAINT class_seats_booked_has_no_deadline CHECK (
    status <> 'booked' OR pending_until IS NULL
  )
);

CREATE TABLE IF NOT EXISTS bookings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id   uuid NOT NULL REFERENCES classes(id)  ON DELETE CASCADE,
  -- Nullable only for the instant between INSERT and seat claim inside one
  -- transaction; externally, every booking has a seat.
  seat_id    uuid REFERENCES class_seats(id) ON DELETE SET NULL,
  status     text NOT NULL DEFAULT 'PENDING_PAYMENT'
               CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  status       text NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  amount_cents int  NOT NULL DEFAULT 0,
  provider_ref text,
  failure_code text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- I3: at most one active booking per student per class.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active_per_student_class
  ON bookings (student_id, class_id)
  WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED');

-- I2: a seat backs at most one confirmed booking. Together with the fixed
-- number of seat rows, this makes overbooking impossible at the storage layer.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_seat
  ON bookings (seat_id)
  WHERE status = 'CONFIRMED';

CREATE INDEX IF NOT EXISTS class_seats_claimable_idx ON class_seats (class_id, status, seat_no);
CREATE INDEX IF NOT EXISTS bookings_class_status_idx ON bookings (class_id, status);
CREATE INDEX IF NOT EXISTS payment_attempts_booking_idx ON payment_attempts (booking_id);
