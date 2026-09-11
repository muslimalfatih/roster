-- =============================================================================
-- roster — synthetic seed data          DESTRUCTIVE: truncates every table.
-- Run with:  pnpm db:reset      (or)   psql -d roster -f apps/api/db/seed.sql
--
-- Demonstrates every case the requirements ask for:
--   * a class with available seats        -> "Science Trial"  (4 free)
--   * a class with exactly 3 confirmed    -> "Math Trial"     (1 seat left)  <- race target
--   * an already-full class               -> "English Trial"  (0 free)
--   * a duplicate booking attempt         -> Aisha is already CONFIRMED in Math Trial,
--                                            so re-booking her there must be rejected
--   * a payment failure case              -> Bilal has a PAYMENT_FAILED booking on
--                                            Science Trial and its seat was RELEASED
--                                            (seat 1 is available again)
--
-- 24 students, not 4-6: the k6 last-seat test runs 10-20 concurrent virtual users and
-- the one-active-booking-per-student index means each VU needs its OWN child, or the
-- race would be decided by the duplicate index instead of by seat contention.
-- =============================================================================

TRUNCATE payment_attempts, bookings, class_seats, students, classes, parents RESTART IDENTITY CASCADE;

INSERT INTO parents (name, email) VALUES
  ('Nadia Rahman', 'nadia@example.com'),
  ('Peter Lim',    'peter@example.com'),
  ('Grace Tan',    'grace@example.com'),
  ('Omar Haddad',  'omar@example.com');

-- Six named children used by the UI demo...
INSERT INTO students (parent_id, name)
SELECT p.id, s.name
FROM (VALUES
  ('nadia@example.com', 'Aisha Rahman'),
  ('nadia@example.com', 'Bilal Rahman'),
  ('peter@example.com', 'Chen Lim'),
  ('peter@example.com', 'Dara Lim'),
  ('grace@example.com', 'Elif Tan'),
  ('grace@example.com', 'Farid Tan')
) AS s(email, name)
JOIN parents p ON p.email = s.email;

-- ...plus 18 clearly-labelled children so k6 can field 20 distinct concurrent users.
INSERT INTO students (parent_id, name)
SELECT p.id, 'Load Test Child ' || lpad(n::text, 2, '0')
FROM generate_series(7, 24) AS n
JOIN LATERAL (
  SELECT id FROM parents ORDER BY email OFFSET (n % 4) LIMIT 1
) p ON true;

-- Real dates that match the names: next week's Saturday 10:00, Sunday 15:00, Monday 17:00.
-- date_trunc('week') is Monday, so +5 / +6 / +7 land on the right days, always in the future.
INSERT INTO classes (name, starts_at, capacity) VALUES
  ('Science Trial - Sat 10:00', date_trunc('week', now() + interval '1 week')::date + 5 + interval '10 hours', 4),
  ('Math Trial - Sun 15:00',    date_trunc('week', now() + interval '1 week')::date + 6 + interval '15 hours', 4),
  ('English Trial - Mon 17:00', date_trunc('week', now() + interval '1 week')::date + 7 + interval '17 hours', 4);

-- Every class gets exactly `capacity` seat rows. This is invariant I1: the number of
-- seats a class can ever sell is fixed here, at creation, not checked at booking time.
INSERT INTO class_seats (class_id, seat_no)
SELECT c.id, s FROM classes c, LATERAL generate_series(1, c.capacity) AS s;

-- ---------------------------------------------------------------------------
-- Math Trial: 3 of 4 seats confirmed. This is the last-seat race target.
-- ---------------------------------------------------------------------------
WITH cls AS (SELECT id FROM classes WHERE name = 'Math Trial - Sun 15:00'),
     seat AS (
       SELECT cs.id, row_number() OVER (ORDER BY cs.seat_no) AS rn
       FROM class_seats cs JOIN cls ON cs.class_id = cls.id
     ),
     stud AS (
       SELECT s.id, row_number() OVER (ORDER BY s.name) AS rn
       FROM students s WHERE s.name IN ('Aisha Rahman', 'Bilal Rahman', 'Chen Lim')
     ),
     ins AS (
       INSERT INTO bookings (student_id, class_id, seat_id, status)
       SELECT stud.id, cls.id, seat.id, 'CONFIRMED'
       FROM stud JOIN seat ON seat.rn = stud.rn CROSS JOIN cls
       RETURNING id, seat_id
     )
UPDATE class_seats cs
SET status = 'booked', held_by_booking_id = ins.id
FROM ins WHERE cs.id = ins.seat_id;

-- ---------------------------------------------------------------------------
-- English Trial: all 4 seats confirmed. Booking here must fail fast.
-- ---------------------------------------------------------------------------
WITH cls AS (SELECT id FROM classes WHERE name = 'English Trial - Mon 17:00'),
     seat AS (
       SELECT cs.id, row_number() OVER (ORDER BY cs.seat_no) AS rn
       FROM class_seats cs JOIN cls ON cs.class_id = cls.id
     ),
     stud AS (
       SELECT s.id, row_number() OVER (ORDER BY s.name) AS rn
       FROM students s WHERE s.name IN ('Chen Lim', 'Dara Lim', 'Elif Tan', 'Farid Tan')
     ),
     ins AS (
       INSERT INTO bookings (student_id, class_id, seat_id, status)
       SELECT stud.id, cls.id, seat.id, 'CONFIRMED'
       FROM stud JOIN seat ON seat.rn = stud.rn CROSS JOIN cls
       RETURNING id, seat_id
     )
UPDATE class_seats cs
SET status = 'booked', held_by_booking_id = ins.id
FROM ins WHERE cs.id = ins.seat_id;

INSERT INTO payment_attempts (booking_id, status, amount_cents, provider_ref)
SELECT id, 'SUCCESS', 2900, 'mock_seed_' || left(id::text, 8)
FROM bookings WHERE status = 'CONFIRMED';

-- ---------------------------------------------------------------------------
-- Payment failure case: Bilal tried Science Trial and the card was declined.
-- The booking keeps seat_id for audit, but the SEAT WAS RELEASED — Science is
-- still 4/4 available. That is the invariant a failed payment must preserve.
-- ---------------------------------------------------------------------------
WITH cls AS (SELECT id FROM classes WHERE name = 'Science Trial - Sat 10:00'),
     seat AS (SELECT cs.id FROM class_seats cs JOIN cls ON cs.class_id = cls.id
              WHERE cs.seat_no = 1),
     stud AS (SELECT id FROM students WHERE name = 'Bilal Rahman'),
     failed AS (
       INSERT INTO bookings (student_id, class_id, seat_id, status)
       SELECT stud.id, cls.id, seat.id, 'PAYMENT_FAILED' FROM stud, cls, seat
       RETURNING id
     )
INSERT INTO payment_attempts (booking_id, status, amount_cents, provider_ref, failure_code)
SELECT id, 'FAILED', 2900, 'mock_seed_declined', 'card_declined' FROM failed;
