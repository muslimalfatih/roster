import postgres from 'postgres';
import { createApp } from '../src/app';
import { sql as appSql } from '../src/db';

/**
 * A test-only connection, separate from the one the server uses, so assertions read
 * committed state through their own session rather than piggybacking on app internals.
 */
export const sql = postgres(process.env.DATABASE_URL!, {
  transform: postgres.camel,
  onnotice: () => {},
});

const schemaSql = await Bun.file(new URL('../db/schema.sql', import.meta.url)).text();
const seedSql = await Bun.file(new URL('../db/seed.sql', import.meta.url)).text();

/** Re-applies schema + seed. `.simple()` is required: the extended protocol rejects multi-statement SQL. */
export async function resetDb() {
  await sql.unsafe(schemaSql).simple();
  await sql.unsafe(seedSql).simple();
}

let baseUrl = '';

/**
 * How many connections/sockets to pre-open. Must be >= the widest Promise.all any test
 * fires (12, the headline last-seat race) AND >= the api pool's `max` (10 in src/db.ts),
 * or the burst would still ramp up mid-test.
 */
const RACE_WIDTH = 16;

/**
 * Binds a real ephemeral port. `app.handle(new Request(...))` always 404s in Elysia
 * 1.4.30 even after .compile(), so integration tests must speak real HTTP.
 *
 * Then WARMS BOTH POOLS, which every race test depends on for its validity.
 * DO NOT DELETE THIS. Cold, neither pool is wide: Bun's fetch client grows its
 * per-origin socket pool one socket at a time, and postgres.js only opens a second
 * backend connection once the first is already reserved. A burst of N `Promise.all`
 * requests against cold pools therefore executes almost SERIALLY — and a serial run
 * satisfies the seat invariant even with the row lock removed, so the test would pass
 * against a knowingly broken implementation. That is the FALSE PASS this priming exists
 * to prevent.
 *
 * This is priming, not a sleep or a retry: it removes a source of accidental
 * serialisation so the assertions measure the database's behaviour, not Bun's I/O.
 */
export async function startServer() {
  const app = createApp();
  app.listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;

  await Promise.all([
    // Opens backend connections in the API's OWN pool. `begin` is required: plain
    // queries are pipelined down a single connection and would only ever open one.
    ...Array.from({ length: RACE_WIDTH }, () => appSql.begin((tx) => tx`SELECT 1`)),
    // Opens keep-alive sockets in Bun's fetch client for this origin.
    ...Array.from({ length: RACE_WIDTH }, () => api.get('/api/health')),
  ]);

  return {
    url: baseUrl,
    stop: async () => {
      await app.stop();
      await sql.end();
    },
  };
}

type Res<T> = { status: number; body: T };

async function send<T>(path: string, init?: RequestInit): Promise<Res<T>> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export const api = {
  get: <T>(path: string) => send<T>(path),
  post: <T>(path: string, body: unknown) =>
    send<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** Bypasses JSON.stringify so a test can send a body the parser must reject. */
  postRaw: <T>(path: string, body: string) =>
    send<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
};

// --- factories -------------------------------------------------------------
// Every factory tags its rows with a unique suffix, so fresh fixtures can never
// collide with the demo seed or with each other.

let uniq = 0;
const nextTag = () => `${Date.now().toString(36)}-${uniq++}`;

export type TestStudent = { id: string; name: string };

/** n students under one fresh parent, none of them holding any booking. */
export async function makeStudents(n: number): Promise<TestStudent[]> {
  const tag = nextTag();
  const [parent] = await sql`
    INSERT INTO parents (name, email)
    VALUES (${`Test Parent ${tag}`}, ${`parent-${tag}@test.local`})
    RETURNING id`;

  const students = await sql`
    INSERT INTO students (parent_id, name)
    SELECT ${parent.id}::uuid, 'Test Student ' || ${tag} || '-' || i
    FROM generate_series(1, ${n}::int) AS i
    RETURNING id, name`;

  return students as unknown as TestStudent[];
}

/**
 * A fresh class with exactly `capacity` seat rows (invariant I1, applied the same way
 * the seed does) and `booked` seats already sold to their own students.
 */
export async function makeClass(opts: { capacity?: number; booked?: number } = {}) {
  const { capacity = 4, booked = 0 } = opts;
  const tag = nextTag();

  const [cls] = await sql`
    INSERT INTO classes (name, starts_at, capacity)
    VALUES (${`Test Class ${tag}`}, now() + interval '7 days', ${capacity}::int)
    RETURNING id`;

  await sql`
    INSERT INTO class_seats (class_id, seat_no)
    SELECT ${cls.id}::uuid, s FROM generate_series(1, ${capacity}::int) AS s`;

  const students = await makeStudents(booked);
  const confirmed: { bookingId: string; studentId: string; seatNo: number }[] = [];

  for (const [i, student] of students.entries()) {
    const [seat] = await sql`
      SELECT id, seat_no FROM class_seats
      WHERE class_id = ${cls.id} AND seat_no = ${i + 1}`;
    const [booking] = await sql`
      INSERT INTO bookings (student_id, class_id, seat_id, status)
      VALUES (${student.id}, ${cls.id}, ${seat.id}, 'CONFIRMED')
      RETURNING id`;
    await sql`
      UPDATE class_seats SET status = 'booked', held_by_booking_id = ${booking.id}
      WHERE id = ${seat.id}`;
    // Mirror the seed: a confirmed booking always has a succeeded charge behind it.
    await sql`
      INSERT INTO payment_attempts (booking_id, status, amount_cents, provider_ref)
      VALUES (${booking.id}, 'SUCCESS', 2900, ${`mock_test_${tag}_${i}`})`;
    confirmed.push({ bookingId: booking.id, studentId: student.id, seatNo: seat.seatNo });
  }

  return { classId: cls.id as string, capacity, confirmed };
}

// --- inspectors ------------------------------------------------------------

/** Raw seat status counts for a class, e.g. { available: 1, locked: 0, booked: 3 }. */
export async function seatStateOf(classId: string) {
  const rows = await sql`
    SELECT status, count(*)::int AS n FROM class_seats
    WHERE class_id = ${classId} GROUP BY status`;
  const counts: Record<'available' | 'locked' | 'booked', number> = {
    available: 0,
    locked: 0,
    booked: 0,
  };
  for (const row of rows) counts[row.status as keyof typeof counts] = row.n;
  return counts;
}

export async function confirmedCountOf(classId: string) {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM bookings
    WHERE class_id = ${classId} AND status = 'CONFIRMED'`;
  return row.n as number;
}

export async function bookingRow(bookingId: string) {
  const [row] = await sql`SELECT * FROM bookings WHERE id = ${bookingId}`;
  return row as unknown as { id: string; status: string; seatId: string | null };
}

export async function attemptsOf(bookingId: string) {
  const rows = await sql`
    SELECT * FROM payment_attempts WHERE booking_id = ${bookingId} ORDER BY created_at`;
  return rows as unknown as {
    status: string;
    amountCents: number;
    failureCode: string | null;
  }[];
}

/**
 * Drives lazy expiry deterministically: pushes a booking's hold into the past so the
 * next claimant may reclaim the seat, without waiting SEAT_HOLD_MINUTES in real time.
 */
export async function expireHold(bookingId: string) {
  await sql`
    UPDATE class_seats SET pending_until = now() - interval '1 minute'
    WHERE held_by_booking_id = ${bookingId} AND status = 'locked'`;
}

/** The demo seed's already-full class, looked up by name. */
export async function seededClassId(name: string) {
  const [row] = await sql`SELECT id FROM classes WHERE name = ${name}`;
  return row.id as string;
}

export async function studentIdByName(name: string) {
  const [row] = await sql`SELECT id FROM students WHERE name = ${name}`;
  return row.id as string;
}
