import type { Booking, BookingStatus, CompletePaymentResponse, SeatStatus } from '@roster/types';
import type postgres from 'postgres';
import { isUniqueViolation, sql } from '../db';
import { env } from '../env';
import { AppError, ConflictError, NotFoundError } from '../errors';
import { log } from '../log';

/** Mock price of a trial seat, in cents. */
const TRIAL_PRICE_CENTS = 2900;

type Tx = postgres.TransactionSql;

/**
 * Booking and payment. Each function is a single transaction, and both take their locks in
 * the same order — bookings, then class_seats — so they cannot deadlock against each other.
 *
 * Capacity is not enforced here. A class has a fixed set of rows in class_seats and a partial
 * unique index permits one confirmed booking per seat, so nothing below ever counts bookings.
 * The constraints that do the work are in db/schema.sql.
 */

/** Creates a pending booking holding a real, locked seat. */
export async function createBooking(studentId: string, classId: string): Promise<Booking> {
  try {
    const booking = await sql.begin(async (tx): Promise<Booking> => {
      // Release a hold this parent abandoned earlier. The duplicate index has no time bound,
      // so without this an abandoned booking would lock the child out of the class forever:
      // the seat gets reclaimed, the booking never does. A live hold matches nothing here and
      // still gets rejected below.
      await tx`
        UPDATE bookings b SET status = 'CANCELLED', updated_at = now()
         WHERE b.student_id = ${studentId} AND b.class_id = ${classId}
           AND b.status = 'PENDING_PAYMENT'
           AND NOT EXISTS (
             SELECT 1 FROM class_seats cs
              WHERE cs.id = b.seat_id AND cs.held_by_booking_id = b.id
                AND cs.status = 'locked' AND cs.pending_until >= now())`;

      // Insert first, so a duplicate hits the unique index before any seat is touched.
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO bookings (student_id, class_id, status)
        VALUES (${studentId}, ${classId}, 'PENDING_PAYMENT')
        RETURNING id`;

      // Claiming the seat is the point where concurrent bookings serialise.
      //
      // SKIP LOCKED rather than NOWAIT: ORDER BY ... LIMIT 1 points every concurrent
      // transaction at the same free row, so NOWAIT aborts all but one with 55P03 even when
      // other seats are empty. SKIP LOCKED steps over the held row and takes the next.
      //
      // The pending_until clause reclaims lapsed holds, which is why there is no sweeper job.
      const [seat] = await tx<{ id: string; seatNo: number }[]>`
        SELECT id, seat_no FROM class_seats
         WHERE class_id = ${classId}
           AND (status = 'available' OR (status = 'locked' AND pending_until < now()))
         ORDER BY seat_no
         LIMIT 1
         FOR UPDATE SKIP LOCKED`;

      // Rolling back here also undoes the insert above, so a full class leaves no orphan.
      if (!seat) throw ConflictError('class_full', 'This class has no seats left.');

      // One statement, so the class_seats CHECK constraints never see a half-written row.
      await tx`
        UPDATE class_seats
           SET status = 'locked',
               pending_until = now() + (${env.seatHoldMinutes}::int || ' minutes')::interval,
               held_by_booking_id = ${created.id}
         WHERE id = ${seat.id}`;

      const [row] = await tx<Booking[]>`
        UPDATE bookings
           SET seat_id = ${seat.id}, updated_at = now()
         WHERE id = ${created.id}
        RETURNING id, student_id, class_id, seat_id, status, created_at`;

      return { ...row, seatNo: seat.seatNo };
    });

    log('booking.created', {
      bookingId: booking.id,
      studentId,
      classId,
      seatNo: booking.seatNo,
    });
    return booking;
  } catch (err) {
    // The index is the duplicate check; there is no SELECT above it.
    if (isUniqueViolation(err, 'bookings_one_active_per_student_class')) {
      log('booking.rejected', { studentId, classId, reason: 'duplicate_booking' });
      throw ConflictError(
        'duplicate_booking',
        'This student already has an active booking for this class.',
      );
    }
    // 23503: unknown student or class.
    if ((err as { code?: string }).code === '23503') {
      log('booking.rejected', { studentId, classId, reason: 'not_found' });
      throw NotFoundError('Unknown student or class.');
    }
    if (err instanceof AppError) {
      log('booking.rejected', { studentId, classId, reason: err.error });
    }
    throw err;
  }
}

/**
 * Settles a booking that lost its seat. Capacity is checked before the charge, so no money
 * moved and the attempt is recorded at zero. The seat is left alone — it is someone else's.
 */
async function recordSeatLost(tx: Tx, bookingId: string): Promise<void> {
  await tx`
    INSERT INTO payment_attempts (booking_id, status, amount_cents, failure_code)
    VALUES (${bookingId}, 'FAILED', 0, 'seat_lost')`;
  await tx`
    UPDATE bookings SET status = 'PAYMENT_FAILED', updated_at = now() WHERE id = ${bookingId}`;
}

// A locked seat only becomes claimable once pending_until passes, so an expired hold is the
// one thing true in every case that reaches this message. The `outcome` field stays
// 'class_full' for the API contract.
const SEAT_LOST_MESSAGE =
  'Your seat hold expired and the seat is no longer yours. You were not charged — please book again.';

/** Settles a mock payment and gives the booking its final status. */
export async function completePayment(
  bookingId: string,
  mockSuccess: boolean,
): Promise<CompletePaymentResponse> {
  let result: CompletePaymentResponse;

  try {
    result = await sql.begin(async (tx): Promise<CompletePaymentResponse> => {
      // The subquery carries the seat number so the replay path needs no second lock.
      const [booking] = await tx<
        { id: string; seatId: string | null; status: BookingStatus; seatNo: number | null }[]
      >`
        SELECT b.*, (SELECT seat_no FROM class_seats WHERE id = b.seat_id) AS seat_no
        FROM bookings b
        WHERE b.id = ${bookingId}
        FOR UPDATE`;

      if (!booking) throw NotFoundError('Booking not found.');

      // Anything not pending has already settled: report it and change nothing. This early
      // return is what makes a double-submitted payment safe.
      if (booking.status !== 'PENDING_PAYMENT') {
        return {
          bookingId,
          status: booking.status,
          outcome: 'already_processed',
          message: `This booking was already processed and is ${booking.status}.`,
          // A failed booking keeps seat_id for audit, but the seat itself was released and
          // may belong to someone else by now, so report none.
          seatNo: booking.status === 'CONFIRMED' ? booking.seatNo : null,
        };
      }

      // A null seat_id returns no rows, which the check below reads as "not mine" — correct.
      const [seat] = await tx<
        { id: string; seatNo: number; status: SeatStatus; heldByBookingId: string | null }[]
      >`SELECT * FROM class_seats WHERE id = ${booking.seatId} FOR UPDATE`;

      // A lapsed hold nobody reclaimed is still held_by_booking_id = me, so it still counts
      // as mine. Deliberate: don't fail a parent whose seat is demonstrably still free.
      const stillMine = seat && seat.status === 'locked' && seat.heldByBookingId === booking.id;

      if (!stillMine) {
        // Lost the race: the hold lapsed and another parent claimed the seat.
        await recordSeatLost(tx, bookingId);
        return {
          bookingId,
          status: 'PAYMENT_FAILED',
          outcome: 'class_full',
          message: SEAT_LOST_MESSAGE,
          seatNo: null,
        };
      }

      // Declined. The charge was attempted, so the attempt carries the amount, and the seat
      // goes straight back to available.
      if (!mockSuccess) {
        await tx`
          INSERT INTO payment_attempts (booking_id, status, amount_cents, failure_code)
          VALUES (${bookingId}, 'FAILED', ${TRIAL_PRICE_CENTS}, 'card_declined')`;
        await tx`
          UPDATE bookings SET status = 'PAYMENT_FAILED', updated_at = now() WHERE id = ${bookingId}`;
        await tx`
          UPDATE class_seats
             SET status = 'available', pending_until = NULL, held_by_booking_id = NULL
           WHERE id = ${seat.id}`;

        return {
          bookingId,
          status: 'PAYMENT_FAILED',
          outcome: 'payment_declined',
          message: 'Payment was declined. The seat was released and nobody was added to the class.',
          seatNo: null,
        };
      }

      await tx`
        INSERT INTO payment_attempts (booking_id, status, amount_cents, provider_ref)
        VALUES (${bookingId}, 'SUCCESS', ${TRIAL_PRICE_CENTS},
                ${`mock_${Date.now()}_${bookingId.slice(0, 8)}`})`;
      // A 23505 here means the seat is already confirmed elsewhere; caught below.
      await tx`
        UPDATE bookings SET status = 'CONFIRMED', updated_at = now() WHERE id = ${bookingId}`;
      // held_by_booking_id is kept — on a booked seat it records the owner.
      await tx`
        UPDATE class_seats SET status = 'booked', pending_until = NULL WHERE id = ${seat.id}`;

      return {
        bookingId,
        status: 'CONFIRMED',
        outcome: 'confirmed',
        message: `Payment succeeded. Seat ${seat.seatNo} is confirmed.`,
        seatNo: seat.seatNo,
      };
    });
  } catch (err) {
    // Unreachable while the seat lock holds, but this index is the last guarantee against
    // overbooking. If it ever fires, treat it as losing the seat rather than a 500. The
    // failed transaction has rolled back, so settle the booking in a fresh one.
    if (!isUniqueViolation(err, 'bookings_one_confirmed_per_seat')) throw err;

    await sql.begin((tx) => recordSeatLost(tx, bookingId));
    result = {
      bookingId,
      status: 'PAYMENT_FAILED',
      outcome: 'class_full',
      message: SEAT_LOST_MESSAGE,
      seatNo: null,
    };
  }

  log('payment.completed', {
    bookingId,
    outcome: result.outcome,
    status: result.status,
    seatNo: result.seatNo,
  });
  return result;
}
