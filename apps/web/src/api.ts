import type {
  Booking,
  ClassWithAvailability,
  CompletePaymentRequest,
  CompletePaymentResponse,
  CreateBookingRequest,
  RosterEntry,
  Student,
} from '@roster/types';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

/**
 * Carries the backend's machine-readable `error` code alongside the message so the
 * UI can show the real reason ("duplicate_booking", "class_full") instead of a
 * generic failure. The backend is authoritative; we never re-derive its verdict.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    // Two error shapes: our ApiError { error, message }, and Elysia's own schema
    // validation failure, which is 422 with { type: 'validation', message, ... }.
    const code = payload?.error ?? payload?.type ?? `http_${res.status}`;
    throw new ApiRequestError(code, payload?.message ?? res.statusText);
  }
  return payload as T;
}

export const getStudents = () => request<Student[]>('/api/students');

export const getClasses = () => request<ClassWithAvailability[]>('/api/classes');

export const getRoster = (classId: string) =>
  request<RosterEntry[]>(`/api/classes/${classId}/roster`);

export const createBooking = (req: CreateBookingRequest) =>
  request<Booking>('/api/bookings', req);

// Always 200 for a known booking — the verdict is in the body's `outcome`, not the status code.
export const completePayment = (req: CompletePaymentRequest) =>
  request<CompletePaymentResponse>('/api/payments/complete', req);

/**
 * One source of truth for react-query keys. A key typo between useQuery and
 * invalidateQueries silently stops the live seat counts refreshing and typecheck
 * would never catch it, so both sides import these instead of spelling them out.
 */
export const keys = {
  students: ['students'] as const,
  classes: ['classes'] as const,
  roster: (classId: string) => ['roster', classId] as const,
  allRosters: ['roster'] as const,
};

/** Shows the backend's own code + message ("duplicate_booking — ...") rather than swallowing it. */
export const errorText = (err: unknown) =>
  err instanceof ApiRequestError ? `${err.code} — ${err.message}` : String(err);
