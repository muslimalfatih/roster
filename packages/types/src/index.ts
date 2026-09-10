/**
 * Shared API contract between @roster/api and @roster/web.
 *
 * TYPE-ONLY BY DESIGN: exports zero runtime values, so consumers use
 * `import type { ... } from '@roster/types'` and the import is erased at build time.
 * That keeps this workspace package out of Vite's dependency graph entirely.
 */

// --- domain ----------------------------------------------------------------

/** Booking lifecycle. A seat is held from PENDING_PAYMENT and owned from CONFIRMED. */
export type BookingStatus =
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'PAYMENT_FAILED'
  | 'CANCELLED';

/** Seat lifecycle: available --claim--> locked --pay ok--> booked (and back on failure). */
export type SeatStatus = 'available' | 'locked' | 'booked';

/** Outcome of a single mock charge. */
export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export type Parent = {
  id: string;
  name: string;
  email: string;
};

export type Student = {
  id: string;
  parentId: string;
  name: string;
  parentName: string;
};

export type Class = {
  id: string;
  name: string;
  startsAt: string; // ISO 8601
  capacity: number;
};

/** What `GET /api/classes` returns: the class plus live seat inventory. */
export type ClassWithAvailability = Class & {
  confirmedCount: number;
  seatsAvailable: number;
  seatsLocked: number;
};

export type Booking = {
  id: string;
  studentId: string;
  classId: string;
  seatId: string | null;
  /** Seat number the parent holds, 1..capacity. Null only if the seat was released. */
  seatNo: number | null;
  status: BookingStatus;
  createdAt: string;
};

export type RosterEntry = {
  bookingId: string;
  studentId: string;
  studentName: string;
  parentName: string;
  seatNo: number;
  confirmedAt: string;
};

// --- requests / responses --------------------------------------------------

export type CreateBookingRequest = {
  studentId: string;
  classId: string;
};

export type CreateBookingResponse = Booking;

export type CompletePaymentRequest = {
  bookingId: string;
  /** Mock payment switch: `true` simulates an authorised charge, `false` a decline. */
  mockSuccess: boolean;
};

/**
 * Machine-readable result of a payment completion. `already_processed` is the
 * idempotent replay path; `class_full` means the seat was lost before the charge.
 */
export type PaymentOutcome =
  | 'confirmed'
  | 'payment_declined'
  | 'class_full'
  | 'already_processed';

export type CompletePaymentResponse = {
  bookingId: string;
  status: BookingStatus;
  outcome: PaymentOutcome;
  message: string;
  /** Present only when the booking ended CONFIRMED. */
  seatNo: number | null;
};

/**
 * Shape of every non-2xx response, EXCEPT Elysia's own schema validation failures,
 * which return 422 with `{ type: 'validation', on, property, message }`.
 */
export type ApiError = {
  error:
    | 'duplicate_booking'
    | 'class_full'
    | 'not_found'
    | 'invalid_request'
    | 'internal_error';
  message: string;
};
