/**
 * UC3-A1 / NFR16 — DECLINED PAYMENTS RELEASE THEIR SEATS.
 *
 * N VUs each claim a seat, then pay with mockSuccess:false. The point is not the
 * decline itself but the CLEANUP: a failed payment must hand the seat back, or a
 * class quietly bleeds inventory every time a card is declined.
 *
 * Thresholds that make this fail:
 *   booked     count==N    <- every VU actually got a seat to lose
 *   declined   count==N    <- every one came back outcome payment_declined / PAYMENT_FAILED
 *   http_5xx   count==0
 *   checks     rate==1.00  <- includes teardown: seatsAvailable is back to its starting
 *                             value, the roster is untouched, and a fresh booking still
 *                             succeeds (the seats are genuinely reusable, not just
 *                             reported as free).
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const VUS = Number(__ENV.VUS || 4); // must be <= the target class's free seats; setup() enforces it

const booked = new Counter('booked');
const declined = new Counter('declined');
const http5xx = new Counter('http_5xx');

export const options = {
  // per-vu-iterations, iterations:1 — one distinct student per VU, exactly one attempt each.
  scenarios: { fail: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '30s' } },
  thresholds: {
    booked: [`count==${VUS}`],
    declined: [`count==${VUS}`],
    http_5xx: ['count==0'],
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
const headers = { 'Content-Type': 'application/json' };
const getClass = (id) => json(http.get(`${BASE}/api/classes`)).find((c) => c.id === id);

export function setup() {
  const target = json(http.get(`${BASE}/api/classes`))
    .filter((c) => c.seatsAvailable >= VUS)
    .sort((a, b) => b.seatsAvailable - a.seatsAvailable)[0];
  if (!target) throw new Error(`no class with >= ${VUS} free seats — reset the load DB first`);

  const rosterBefore = json(http.get(`${BASE}/api/classes/${target.id}/roster`));
  const taken = new Set(rosterBefore.map((r) => r.studentId));
  // VUS students for the race + one spare for the "seats are really reusable" check.
  const students = json(http.get(`${BASE}/api/students`)).filter((s) => !taken.has(s.id));
  if (students.length < VUS + 1) throw new Error(`need ${VUS + 1} free students, found ${students.length}`);

  http.batch(Array.from({ length: 10 }, () => ['GET', `${BASE}/api/classes`]));

  return {
    classId: target.id,
    studentIds: students.slice(0, VUS).map((s) => s.id),
    spareStudentId: students[VUS].id,
    before: getClass(target.id),
    rosterSizeBefore: rosterBefore.length,
  };
}

export default function (data) {
  const res = http.post(`${BASE}/api/bookings`,
    JSON.stringify({ studentId: data.studentIds[__VU - 1], classId: data.classId }),
    { headers, tags: { endpoint: 'booking' } });
  if (res.status >= 500) http5xx.add(1);
  check(res, { 'booking created': (r) => r.status === 201 });
  booked.add(res.status === 201 ? 1 : 0);
  if (res.status !== 201) { declined.add(0); return; }

  const pay = http.post(`${BASE}/api/payments/complete`,
    JSON.stringify({ bookingId: json(res).id, mockSuccess: false }),
    { headers, tags: { endpoint: 'payment' } });
  if (pay.status >= 500) http5xx.add(1);
  const body = json(pay);
  check(pay, {
    'payment answered 200': (r) => r.status === 200,
    'outcome is payment_declined': () => body.outcome === 'payment_declined',
    'booking ends PAYMENT_FAILED': () => body.status === 'PAYMENT_FAILED',
  });
  declined.add(body.outcome === 'payment_declined' && body.status === 'PAYMENT_FAILED' ? 1 : 0);
}

export function teardown(data) {
  const after = getClass(data.classId);
  check(after, {
    'all seats released — seatsAvailable back to start': (c) => c.seatsAvailable === data.before.seatsAvailable,
    'no seat left held': (c) => c.seatsLocked === data.before.seatsLocked,
    'confirmedCount unchanged': (c) => c.confirmedCount === data.before.confirmedCount,
  });
  check(json(http.get(`${BASE}/api/classes/${data.classId}/roster`)), {
    'roster unchanged': (r) => r.length === data.rosterSizeBefore,
  });

  // Released seats must be genuinely claimable, not merely reported as free.
  // This leaves one PENDING_PAYMENT booking behind on purpose; the run resets the DB.
  const retry = http.post(`${BASE}/api/bookings`,
    JSON.stringify({ studentId: data.spareStudentId, classId: data.classId }), { headers });
  check(retry, { 'a released seat can be booked again': (r) => r.status === 201 });
}
