import type { ClassWithAvailability, RosterEntry } from '@roster/types';
import { Elysia, t } from 'elysia';
import { rows, sql } from '../db';

export const classRoutes = new Elysia({ prefix: '/api' })
  .get('/classes', () =>
    // Availability is read straight off the seat rows — the seats are the inventory,
    // so there is nothing to count against a capacity number. A `locked` seat whose
    // pending_until has lapsed counts as available: that is the same lazy-expiry rule the
    // claim query in booking.ts uses, so the UI and the claim agree.
    rows(sql<ClassWithAvailability[]>`
      SELECT c.id, c.name, c.starts_at, c.capacity,
             (count(*) FILTER (WHERE cs.status = 'booked'))::int AS confirmed_count,
             (count(*) FILTER (WHERE cs.status = 'available'
                                  OR (cs.status = 'locked' AND cs.pending_until < now())))::int
               AS seats_available,
             (count(*) FILTER (WHERE cs.status = 'locked' AND cs.pending_until >= now()))::int
               AS seats_locked
      FROM classes c
      JOIN class_seats cs ON cs.class_id = c.id
      GROUP BY c.id
      ORDER BY c.starts_at`),
  )
  .get(
    '/classes/:classId/roster',
    ({ params }) =>
      // The roster is exactly the confirmed bookings; pending or failed payments never
      // appear. Ordered by seat number because that is how a teacher reads a room.
      rows(sql<RosterEntry[]>`
        SELECT b.id AS booking_id, s.id AS student_id, s.name AS student_name,
               p.name AS parent_name, cs.seat_no, b.updated_at AS confirmed_at
        FROM bookings b
        JOIN students s     ON s.id = b.student_id
        JOIN parents p      ON p.id = s.parent_id
        JOIN class_seats cs ON cs.id = b.seat_id
        WHERE b.class_id = ${params.classId} AND b.status = 'CONFIRMED'
        ORDER BY cs.seat_no`),
    // Without the uuid format check a malformed path param reaches Postgres and
    // comes back as a 500 (22P02) instead of a 422.
    { params: t.Object({ classId: t.String({ format: 'uuid' }) }) },
  );
