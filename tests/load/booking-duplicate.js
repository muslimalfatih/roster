/**
 * UC5 / NFR16 — DUPLICATE BOOKING UNDER CONCURRENCY.
 *
 * 15 VUs try to book THE SAME student into THE SAME class simultaneously.
 * The guarantee is the partial unique index I3
 * (bookings_one_active_per_student_class, WHERE status IN ('PENDING_PAYMENT','CONFIRMED')),
 * so it holds even when 15 requests interleave inside the same millisecond — no
 * read-then-check in application code could do that.
 *
 * Thresholds that make this fail:
 *   created            count==1    <- exactly one attempt won
 *   duplicate_rejected count==14   <- every other attempt got 409 duplicate_booking
 *   http_5xx           count==0    <- a raw pg 23505 never escaped as a 500 (NFR12)
 *   checks             rate==1.00  <- includes teardown: the class lost exactly ONE seat,
 *                                     i.e. the 14 rejected attempts leaked no seat.
 * The seat-leak check is the interesting one: createBooking INSERTs the booking BEFORE
 * claiming a seat, so a duplicate is rejected before any seat row is touched.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const VUS = 15;

const created = new Counter('created');
const duplicateRejected = new Counter('duplicate_rejected');
const http5xx = new Counter('http_5xx');

export const options = {
  // per-vu-iterations with iterations:1 — see booking-last-seat.js. Here it also
  // guarantees each VU makes exactly one attempt, so the expected reject count is exact.
  scenarios: { dup: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '30s' } },
  thresholds: {
    created: ['count==1'],
    duplicate_rejected: [`count==${VUS - 1}`],
    http_5xx: ['count==0'],
    checks: ['rate==1.00'],
    // NFR8, and it is an ASSERTION, not a note in a report: the aggregate
    // http_req_duration mixes in the GET /api/classes calls that setup() and teardown() make,
    // so the POSTs carry an `endpoint` tag and the budget is applied to those sub-metrics.
    // 300ms is the NFR8 ceiling for a local run under full contention.
    'http_req_duration{endpoint:booking}': ['p(95)<300'],
  },
};

const json = (r) => { try { return r.json(); } catch { return {}; } };
const getClass = (id) => json(http.get(`${BASE}/api/classes`)).find((c) => c.id === id);

export function setup() {
  const target = json(http.get(`${BASE}/api/classes`))
    .filter((c) => c.seatsAvailable > 0)
    .sort((a, b) => b.seatsAvailable - a.seatsAvailable)[0];
  if (!target) throw new Error('no class with a free seat — reset the load DB first');

  // The student must have no active booking here already, or the very first attempt
  // would also be a duplicate and `created` would be 0.
  const taken = new Set(json(http.get(`${BASE}/api/classes/${target.id}/roster`)).map((r) => r.studentId));
  const student = json(http.get(`${BASE}/api/students`)).find((s) => !taken.has(s.id));
  if (!student) throw new Error('no student free of this class');

  // Prime the API's postgres.js pool: a cold pool serialises the burst and a serial
  // run passes even without the index. Never delete this.
  http.batch(Array.from({ length: 10 }, () => ['GET', `${BASE}/api/classes`]));

  return { classId: target.id, studentId: student.id, before: getClass(target.id) };
}

export default function (data) {
  const res = http.post(`${BASE}/api/bookings`,
    JSON.stringify({ studentId: data.studentId, classId: data.classId }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'booking' } });

  if (res.status >= 500) http5xx.add(1);
  check(res, { 'answered 201 or 409': (r) => r.status === 201 || r.status === 409 });
  if (res.status === 409) {
    check(res, { 'rejection is duplicate_booking': (r) => json(r).error === 'duplicate_booking' });
  }
  // Written on every path so the thresholds always have samples (see last-seat).
  created.add(res.status === 201 ? 1 : 0);
  duplicateRejected.add(res.status === 409 && json(res).error === 'duplicate_booking' ? 1 : 0);
}

export function teardown(data) {
  const after = getClass(data.classId);
  check(after, {
    // One seat held by the one winner...
    'exactly one seat left the available pool': (c) => c.seatsAvailable === data.before.seatsAvailable - 1,
    'exactly one seat is held': (c) => c.seatsLocked === data.before.seatsLocked + 1,
    // ...and nothing was confirmed, because nobody paid.
    'confirmedCount unchanged': (c) => c.confirmedCount === data.before.confirmedCount,
  });
}
