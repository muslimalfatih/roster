import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import type {
  ApiError,
  Booking,
  ClassWithAvailability,
  CompletePaymentResponse,
  RosterEntry,
} from '@roster/types';
import {
  api,
  attemptsOf,
  bookingRow,
  confirmedCountOf,
  expireHold,
  makeClass,
  makeStudents,
  resetDb,
  seatStateOf,
  seededClassId,
  sql,
  startServer,
} from './helpers';

let stop: () => Promise<void>;

beforeAll(async () => {
  ({ stop } = await startServer());
});

afterAll(async () => {
  await stop();
});

// Schema + seed before every case, so this file is order-independent and re-runnable.
beforeEach(resetDb);

const book = (studentId: string, classId: string) =>
  api.post<Booking & ApiError>('/api/bookings', { studentId, classId });

const pay = (bookingId: string, mockSuccess: boolean) =>
  api.post<CompletePaymentResponse & ApiError>('/api/payments/complete', {
    bookingId,
    mockSuccess,
  });

const roster = (classId: string) => api.get<RosterEntry[]>(`/api/classes/${classId}/roster`);

// ===========================================================================
// I3 — at most one ACTIVE booking per (student, class).
// ===========================================================================
describe('I3 duplicate prevention (UC5, NFR2)', () => {
  test('UC5: the same student cannot hold two active bookings for one class', async () => {
    const { classId } = await makeClass({ capacity: 4 });
    const [student] = await makeStudents(1);

    const first = await book(student.id, classId);
    const second = await book(student.id, classId);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('duplicate_booking');

    const rows = await sql`
      SELECT id FROM bookings WHERE student_id = ${student.id} AND class_id = ${classId}`;
    expect(rows.length).toBe(1);
  });

  test('UC5: a rejected duplicate leaks no seat — availability is byte-identical before and after', async () => {
    // This is the whole reason createBooking INSERTs the booking BEFORE claiming a
    // seat: the duplicate index fires first, so no seat is ever touched, let alone
    // locked and abandoned. Booking-then-claim in the other order would strand a seat.
    const { classId } = await makeClass({ capacity: 4 });
    const [student] = await makeStudents(1);

    await book(student.id, classId);
    const before = await seatStateOf(classId);

    const dup = await book(student.id, classId);
    const after = await seatStateOf(classId);

    expect(dup.status).toBe(409);
    expect(after).toEqual(before);
    expect(after).toEqual({ available: 3, locked: 1, booked: 0 });
  });

  test('UC5: an abandoned booking whose hold lapsed does not lock the student out forever', async () => {
    // Lazy expiry has to cover BOTH sides. The seat is reclaimable once the hold lapses,
    // but I3 has no time bound, so without settling the stale booking a parent who closed
    // the tab would get 409 duplicate_booking on that class for ever — with no cancel
    // endpoint and no way to look the booking up again.
    const { classId } = await makeClass({ capacity: 4 });
    const [student] = await makeStudents(1);

    const abandoned = await book(student.id, classId);
    await expireHold(abandoned.body.id);

    const retry = await book(student.id, classId);
    expect(retry.status).toBe(201);
    expect((await bookingRow(abandoned.body.id)).status).toBe('CANCELLED');

    // A LIVE hold still blocks: this must not become a way to double-book.
    expect((await book(student.id, classId)).status).toBe(409);
  });

  test('UC5: after a declined payment the same student may book that class again', async () => {
    // The index deliberately excludes PAYMENT_FAILED so a parent can retry a decline.
    const { classId } = await makeClass({ capacity: 4 });
    const [student] = await makeStudents(1);

    const first = await book(student.id, classId);
    await pay(first.body.id, false);

    const retry = await book(student.id, classId);
    expect(retry.status).toBe(201);
    expect(retry.body.status).toBe('PENDING_PAYMENT');
  });
});

// ===========================================================================
// I1 + I2 — capacity is structural, not counted.
// ===========================================================================
describe('I1+I2 capacity and the last-seat race (UC2, NFR1, NFR4)', () => {
  test('NFR1/NFR4: 12 parents storm the last seat of a 3/4 class — exactly one wins', async () => {
    // THE HEADLINE TEST. One seat, twelve simultaneous book+pay pipelines.
    //
    // Pools are already primed by startServer(), so these twelve really do hit the
    // database at once (see the FALSE PASS note in helpers.ts). Every loser must fail
    // for a BUSINESS reason — a 409 class_full at booking time, or a class_full outcome
    // at payment time if it lost a seat it briefly held — never with a lock error or a
    // 500, and never by overbooking.
    const { classId } = await makeClass({ capacity: 4, booked: 3 });
    const students = await makeStudents(12);

    const results = await Promise.all(
      students.map(async (student) => {
        const booked = await book(student.id, classId);
        if (booked.status !== 201) return { booked, paid: null };
        const paid = await pay(booked.body.id, true);
        return { booked, paid };
      }),
    );

    // THE CLAIM ITSELF MUST BE EXCLUSIVE, not just the final tally. One free seat means
    // exactly ONE parent may ever be handed it and sent to a payment screen. Asserting only
    // the end state is not enough: without the row lock, all twelve transactions read the
    // same free seat and all twelve get a 201 for seat 4, and the ownership check in
    // completePayment still narrows them back down to one confirmation — a correct final
    // count reached by showing eleven parents a seat that was never theirs.
    const claimed = results.filter((r) => r.booked.status === 201);
    expect(claimed.length).toBe(1);
    expect(new Set(claimed.map((r) => r.booked.body.seatNo)).size).toBe(1);

    const winners = results.filter((r) => r.paid?.body.outcome === 'confirmed');
    expect(winners.length).toBe(1);

    for (const r of results) {
      if (r.paid === null) {
        // Lost at booking: the seat was already claimed by someone else.
        expect(r.booked.status).toBe(409);
        expect(r.booked.body.error).toBe('class_full');
      } else if (r.paid.body.outcome !== 'confirmed') {
        // Lost at payment: held the seat, hold lapsed, someone else took it.
        expect(r.paid.body.outcome).toBe('class_full');
        expect(r.paid.status).toBe(200);
      }
    }

    // The invariant, stated three ways: bookings, roster, and the seat rows themselves.
    expect(await confirmedCountOf(classId)).toBe(4);
    expect((await roster(classId)).body.length).toBe(4);
    expect(await seatStateOf(classId)).toEqual({ available: 0, locked: 0, booked: 4 });
  });

  test('NFR4: four parents fill an empty 4-seat class in parallel and each gets a DIFFERENT seat', async () => {
    // This is exactly what FOR UPDATE SKIP LOCKED buys. All four transactions pick the
    // same first free seat with ORDER BY seat_no LIMIT 1; SKIP LOCKED lets each one step
    // over the rows its rivals hold and take the next free seat inside the same scan.
    // A FOR UPDATE NOWAIT implementation fails this test: it would grant ONE seat and
    // tell the other three parents the class is full while three seats sit empty.
    const { classId } = await makeClass({ capacity: 4 });
    const students = await makeStudents(4);

    const results = await Promise.all(students.map((s) => book(s.id, classId)));

    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.seatNo))).toEqual(new Set([1, 2, 3, 4]));
    expect(await seatStateOf(classId)).toEqual({ available: 0, locked: 4, booked: 0 });
  });

  test('UC2-A1: booking into an already-full class returns 409 class_full and moves no seat', async () => {
    const classId = await seededClassId('English Trial - Mon 17:00');
    const [student] = await makeStudents(1);
    const before = await seatStateOf(classId);

    const res = await book(student.id, classId);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('class_full');
    expect(await seatStateOf(classId)).toEqual(before);
    // The rolled-back transaction leaves no orphan booking behind either.
    const rows = await sql`SELECT id FROM bookings WHERE student_id = ${student.id}`;
    expect(rows.length).toBe(0);
  });

  test('NFR1: structurally, every class has confirmed bookings <= capacity and booked seats == CONFIRMED bookings', async () => {
    const { classId } = await makeClass({ capacity: 4, booked: 3 });
    const students = await makeStudents(6);
    await Promise.all(
      students.map(async (s) => {
        const b = await book(s.id, classId);
        if (b.status === 201) await pay(b.body.id, true);
      }),
    );

    const rows = await sql`
      SELECT c.capacity,
             (SELECT count(*) FROM bookings b
               WHERE b.class_id = c.id AND b.status = 'CONFIRMED')::int AS confirmed,
             (SELECT count(*) FROM class_seats cs
               WHERE cs.class_id = c.id AND cs.status = 'booked')::int AS booked
      FROM classes c`;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.confirmed).toBeLessThanOrEqual(row.capacity);
      expect(row.booked).toBe(row.confirmed);
    }
  });
});

// ===========================================================================
// UC3 — payment completion.
// ===========================================================================
describe('UC3 payment completion', () => {
  test('UC3-A1: a decline fails the booking, releases the seat, and records one card_declined attempt', async () => {
    const { classId } = await makeClass({ capacity: 4 });
    const [student] = await makeStudents(1);
    const booked = await book(student.id, classId);

    const res = await pay(booked.body.id, false);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('payment_declined');
    expect((await bookingRow(booked.body.id)).status).toBe('PAYMENT_FAILED');
    // The seat goes all the way back to clean 'available' — the CHECK constraints
    // would reject a half-released seat that kept its hold or its owner.
    expect(await seatStateOf(classId)).toEqual({ available: 4, locked: 0, booked: 0 });
    expect((await roster(classId)).body.length).toBe(0);

    const attempts = await attemptsOf(booked.body.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[0].failureCode).toBe('card_declined');
  });

  test('UC3-A1: the seat freed by a decline is immediately re-bookable by another student', async () => {
    const { classId } = await makeClass({ capacity: 4, booked: 3 });
    const [alice, bob] = await makeStudents(2);

    const aliceBooking = await book(alice.id, classId);
    expect(aliceBooking.body.seatNo).toBe(4);
    await pay(aliceBooking.body.id, false);

    const bobBooking = await book(bob.id, classId);
    expect(bobBooking.status).toBe(201);
    expect(bobBooking.body.seatNo).toBe(4);
    await pay(bobBooking.body.id, true);

    // Alice's booking keeps its seat_id for audit, but seat 4 is Bob's now. A replay must
    // not hand her back a seat number she does not own (@roster/types: seatNo is present
    // only when the booking ended CONFIRMED).
    const replay = await pay(aliceBooking.body.id, true);
    expect(replay.body.outcome).toBe('already_processed');
    expect(replay.body.status).toBe('PAYMENT_FAILED');
    expect(replay.body.seatNo).toBeNull();
  });

  test('UC3-A2/NFR13: replaying a successful payment is idempotent and charges nothing twice', async () => {
    const { classId } = await makeClass({ capacity: 4 });
    const [student] = await makeStudents(1);
    const booked = await book(student.id, classId);

    const first = await pay(booked.body.id, true);
    const replay = await pay(booked.body.id, true);

    expect(first.body.outcome).toBe('confirmed');
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe('already_processed');
    expect(replay.body.status).toBe('CONFIRMED');
    expect((await bookingRow(booked.body.id)).status).toBe('CONFIRMED');

    // The replay guard mutates NOTHING, so there is exactly one charge on record.
    const attempts = await attemptsOf(booked.body.id);
    expect(attempts.filter((a) => a.status === 'SUCCESS').length).toBe(1);
    expect(attempts.length).toBe(1);
  });

  test('UC3-A3: A holds the last seat, A’s hold lapses, B pays and wins it, A loses cleanly', async () => {
    // The brief's literal A/B scenario, driven through lazy expiry instead of a sleep.
    const { classId } = await makeClass({ capacity: 4, booked: 3 });
    const [alice, bob] = await makeStudents(2);

    const aliceBooking = await book(alice.id, classId);
    expect(aliceBooking.body.seatNo).toBe(4);

    await expireHold(aliceBooking.body.id); // A dawdles on the payment screen

    const bobBooking = await book(bob.id, classId);
    expect(bobBooking.status).toBe(201);
    expect(bobBooking.body.seatNo).toBe(4); // reclaimed the lapsed hold, no cron needed
    expect((await pay(bobBooking.body.id, true)).body.outcome).toBe('confirmed');

    const aliceResult = await pay(aliceBooking.body.id, true);
    expect(aliceResult.status).toBe(200);
    expect(aliceResult.body.outcome).toBe('class_full');
    expect(aliceResult.body.status).toBe('PAYMENT_FAILED');
    expect((await bookingRow(aliceBooking.body.id)).status).toBe('PAYMENT_FAILED');

    const entries = (await roster(classId)).body;
    expect(entries.length).toBe(4);
    expect(entries.some((e) => e.studentId === alice.id)).toBe(false);
    expect(entries.some((e) => e.studentId === bob.id)).toBe(true);
    expect(await seatStateOf(classId)).toEqual({ available: 0, locked: 0, booked: 4 });
  });

  test('MONEY SAFETY: losing the seat records a 0-cent failure and never a SUCCESS charge', async () => {
    // No seat, no charge, so there is nothing to refund. The failed attempt is an audit
    // record of a race lost, not of money moved — hence amount_cents = 0.
    const { classId } = await makeClass({ capacity: 4, booked: 3 });
    const [alice, bob] = await makeStudents(2);

    const aliceBooking = await book(alice.id, classId);
    await expireHold(aliceBooking.body.id);
    const bobBooking = await book(bob.id, classId);
    await pay(bobBooking.body.id, true);
    await pay(aliceBooking.body.id, true);

    const attempts = await attemptsOf(aliceBooking.body.id);
    expect(attempts.some((a) => a.status === 'SUCCESS')).toBe(false);
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[0].failureCode).toBe('seat_lost');
    expect(attempts[0].amountCents).toBe(0);
  });

  test('UC3: paying for an unknown booking id returns 404 not_found', async () => {
    const res = await pay('00000000-0000-4000-8000-000000000000', true);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

// ===========================================================================
// Input validation and error hygiene.
// ===========================================================================
describe('boundaries (NFR12, NFR18)', () => {
  test('NFR18: a malformed booking body is rejected by the schema with 422, not 400 and not 500', async () => {
    const missing = await api.post<unknown>('/api/bookings', { studentId: crypto.randomUUID() });
    const notAUuid = await api.post<unknown>('/api/bookings', {
      studentId: 'not-a-uuid',
      classId: crypto.randomUUID(),
    });
    const wrongType = await api.post<unknown>('/api/payments/complete', {
      bookingId: crypto.randomUUID(),
      mockSuccess: 'yes',
    });

    expect(missing.status).toBe(422);
    expect(notAUuid.status).toBe(422);
    expect(wrongType.status).toBe(422);
  });

  test('NFR18: an unparseable body is a 400 invalid_request, not a 500 internal_error', async () => {
    // Elysia raises its own PARSE error before any handler runs. Left unmapped it falls
    // into the catch-all and a truncated client request is reported as a server fault.
    const res = await api.postRaw<ApiError>('/api/bookings', '{"studentId":');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  test('NFR18: a non-uuid classId on the roster path is rejected with 422, not a Postgres 22P02 500', async () => {
    const res = await api.get<unknown>('/api/classes/definitely-not-a-uuid/roster');
    expect(res.status).toBe(422);
  });

  test('NFR12/NFR17: no error body leaks a driver message, a stack trace, or the connection string', async () => {
    const [student] = await makeStudents(1);
    const fullClass = await seededClassId('English Trial - Mon 17:00');

    const bodies = [
      (await book(student.id, fullClass)).body,
      (await book(student.id, '00000000-0000-4000-8000-000000000000')).body,
      (await pay('00000000-0000-4000-8000-000000000000', true)).body,
      (await api.get<unknown>('/api/classes/definitely-not-a-uuid/roster')).body,
      (await api.post<unknown>('/api/bookings', { studentId: 'x' })).body,
    ];

    for (const body of bodies) {
      const text = JSON.stringify(body).toLowerCase();
      for (const leak of ['postgres', 'pg_', 'at object', 'localhost:5432', '5432', 'stack']) {
        expect(text).not.toContain(leak);
      }
    }
  });
});

// ===========================================================================
// UC1 — the availability view the parent actually sees.
// ===========================================================================
describe('UC1 class availability', () => {
  test('UC1: a lapsed hold counts as available, a live hold counts as locked', async () => {
    const { classId } = await makeClass({ capacity: 4, booked: 1 });
    const [alice, bob] = await makeStudents(2);

    const live = await book(alice.id, classId);
    const lapsing = await book(bob.id, classId);
    await expireHold(lapsing.body.id);

    const listed = (await api.get<ClassWithAvailability[]>('/api/classes')).body;
    const cls = listed.find((c) => c.id === classId)!;

    expect(cls.confirmedCount).toBe(1);
    expect(cls.seatsLocked).toBe(1); // alice's hold is still live
    expect(cls.seatsAvailable).toBe(2); // one untouched seat + bob's lapsed hold
    expect(live.body.seatNo).not.toBe(lapsing.body.seatNo);
  });
});
