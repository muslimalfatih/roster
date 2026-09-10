/**
 * NFR9 / NFR16 — THE LAST-SEAT RACE. This is the headline evidence.
 *
 * 20 parents, each with their OWN child, all POST /api/bookings for the class that
 * has exactly ONE seat left, at the same instant. Exactly one may end up CONFIRMED.
 *
 * What proves it: THRESHOLDS, not console output. k6 exits non-zero when any
 * threshold fails, so this file is a real assertion and not a demo.
 *   confirmed           count==1   <- I1+I2 held: the last seat went to exactly one parent
 *   rejected_cleanly    count==19  <- every loser got a business answer, nobody hung or 500'd
 *   rejected_at_booking count==19  <- and they learned it BEFORE being shown a payment screen
 *   rejected_at_payment count==0   <- nobody was handed a seat that was never theirs
 *   http_5xx            count==0   <- no lock error (55P03) or crash ever reached a parent (NFR7)
 *   checks              rate==1.00 <- includes the teardown roster/inventory assertions
 *
 * WHY EVERY LOSER LOSES AT *BOOKING* TIME, NOT AT PAYMENT TIME:
 * the seat row is claimed with FOR UPDATE SKIP LOCKED at booking. Once the single free
 * seat row is locked by the winner, the other 19 SELECTs skip it, find zero claimable
 * rows and get 409 class_full immediately — that IS the fail-fast behaviour NFR6 asks
 * for (no HTTP connection parked waiting on a lock). That is why rejected_at_payment is
 * pinned to 0: a nonzero value means several parents were sold the same seat and only
 * sorted out later, which is exactly what deleting the lock produces. The payment-time loss path
 * (UC3-A3, "my hold lapsed and someone else took my seat") needs clock control to
 * trigger, which k6 cannot do cheaply, so it is covered by the bun suite instead.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const VUS = 20;

const confirmed = new Counter('confirmed');
const rejectedAtBooking = new Counter('rejected_at_booking');
const rejectedAtPayment = new Counter('rejected_at_payment');
const rejectedCleanly = new Counter('rejected_cleanly');
const http5xx = new Counter('http_5xx');

export const options = {
  scenarios: {
    // per-vu-iterations, NOT shared-iterations: shared-iterations hands the next
    // iteration to whichever VU is free, so one fast VU could run twice while another
    // runs zero times. Each VU owns exactly one student, and a VU running twice would
    // hit the one-active-booking-per-student index (I3) instead of seat contention —
    // the test would then "pass" while proving nothing. One iteration per VU, exactly.
    race: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '30s' },
  },
  thresholds: {
    confirmed: ['count==1'],                  // the whole point: no overbooking, no underbooking
    rejected_cleanly: [`count==${VUS - 1}`],  // and everyone else got a clean business rejection
    // THE MUTATION-KILLING PAIR. `confirmed==1` alone is NOT enough: with the row lock
    // deleted from the seat-claim query, six parents were handed a 201 for the SAME seat and
    // completePayment's held_by_booking_id check narrowed them back to one confirmation — a
    // correct final tally reached by showing five parents a payment screen for a seat that was
    // never theirs. Measured: confirmed=1, rejected_cleanly=19, all thresholds green.
    // One free seat means exactly ONE parent may ever be handed it, and every other parent must
    // learn that at BOOKING time. Deterministic under SKIP LOCKED: the single free row is either
    // held by the winner's lock (skipped -> 0 rows) or already committed 'locked' with a
    // pending_until 10 minutes out (predicate false -> 0 rows). Either way, 409 immediately.
    rejected_at_booking: [`count==${VUS - 1}`],
    rejected_at_payment: ['count==0'],
    http_5xx: ['count==0'],                   // never a lock error or a leaked pg message (NFR7/NFR12)
    checks: ['rate==1.00'],
    // NFR8, and it is an ASSERTION, not a note in a report: the aggregate
    // http_req_duration mixes in the GET /api/classes calls that setup() and teardown() make,
    // so the POSTs carry an `endpoint` tag and the budget is applied to those sub-metrics.
    // 300ms is the NFR8 ceiling for a local run under full contention.
    'http_req_duration{endpoint:booking}': ['p(95)<300'],
    'http_req_duration{endpoint:payment}': ['p(95)<300'],
  },
};

const json = (r) => { try { return r.json(); } catch { return {}; } };

export function setup() {
  // NO HARDCODED UUIDs — everything is discovered from the API.
  const classes = json(http.get(`${BASE}/api/classes`));
  const target = classes.find((c) => c.seatsAvailable === 1);
  if (!target) throw new Error('no class with exactly 1 seat available — reset the load DB first');

  // Students already CONFIRMED in this class would be rejected as duplicate_booking (I3)
  // rather than class_full, which would corrupt the classification. Exclude them.
  const taken = new Set(json(http.get(`${BASE}/api/classes/${target.id}/roster`)).map((r) => r.studentId));
  const students = json(http.get(`${BASE}/api/students`)).filter((s) => !taken.has(s.id));
  if (students.length < VUS) throw new Error(`need ${VUS} free students, found ${students.length}`);

  // PRIME THE POOLS. A first burst on cold pools runs near-serially (the API's
  // postgres.js pool grows one connection at a time), and a serial run satisfies the
  // invariant even with the locking removed — a false pass. Never delete this.
  http.batch(Array.from({ length: 10 }, () => ['GET', `${BASE}/api/classes`]));

  return { classId: target.id, capacity: target.capacity, studentIds: students.slice(0, VUS).map((s) => s.id) };
}

export default function (data) {
  const studentId = data.studentIds[__VU - 1]; // one distinct child per VU
  const headers = { 'Content-Type': 'application/json' };

  const res = http.post(`${BASE}/api/bookings`, JSON.stringify({ studentId, classId: data.classId }),
    { headers, tags: { endpoint: 'booking' } });
  if (res.status >= 500) http5xx.add(1);
  check(res, { 'booking answered 201 or 409': (r) => r.status === 201 || r.status === 409 });

  if (res.status === 409) {
    // Lost the seat row itself. Must be a BUSINESS error, never a lock error.
    check(res, { 'booking rejection is class_full': (r) => json(r).error === 'class_full' });
    confirmed.add(0); rejectedAtBooking.add(1); rejectedAtPayment.add(0); rejectedCleanly.add(1);
    return;
  }
  if (res.status !== 201) { confirmed.add(0); rejectedAtBooking.add(0); rejectedAtPayment.add(0); rejectedCleanly.add(0); return; }

  const booking = json(res);
  const pay = http.post(`${BASE}/api/payments/complete`,
    JSON.stringify({ bookingId: booking.id, mockSuccess: true }),
    { headers, tags: { endpoint: 'payment' } });
  if (pay.status >= 500) http5xx.add(1);
  check(pay, { 'payment answered 200': (r) => r.status === 200 });

  const outcome = json(pay).outcome;
  check(pay, { 'payment outcome is confirmed or class_full': () => outcome === 'confirmed' || outcome === 'class_full' });

  // Every counter is written on every path (0 or 1). A k6 threshold on a metric that
  // received no samples is skipped, so a counter left untouched would PASS silently.
  confirmed.add(outcome === 'confirmed' ? 1 : 0);
  rejectedAtBooking.add(0);
  rejectedAtPayment.add(outcome === 'class_full' ? 1 : 0);
  rejectedCleanly.add(outcome === 'class_full' ? 1 : 0);
}

export function teardown(data) {
  // Independent read-back: the durable state must agree with the counters.
  const roster = json(http.get(`${BASE}/api/classes/${data.classId}/roster`));
  const seatNos = new Set(roster.map((r) => r.seatNo));
  check(roster, {
    'roster is exactly capacity entries': (r) => r.length === data.capacity,
    'every roster seat number is distinct': () => seatNos.size === data.capacity,
  });

  const cls = json(http.get(`${BASE}/api/classes`)).find((c) => c.id === data.classId);
  check(cls, {
    'class reports confirmedCount == capacity': (c) => c.confirmedCount === data.capacity,
    'class reports seatsAvailable == 0': (c) => c.seatsAvailable === 0,
    'no seat left dangling in a lapsed hold': (c) => c.seatsLocked === 0,
  });
}
