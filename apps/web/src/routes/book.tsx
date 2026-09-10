import { useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Booking, CompletePaymentResponse, PaymentOutcome } from '@roster/types';
import { completePayment, createBooking, errorText, getClasses, getStudents, keys } from '../api';

const outcomeStyle: Record<PaymentOutcome, string> = {
  confirmed: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  payment_declined: 'border-rose-300 bg-rose-50 text-rose-900',
  class_full: 'border-amber-300 bg-amber-50 text-amber-900',
  already_processed: 'border-slate-300 bg-slate-100 text-slate-700',
};

const outcomeTitle: Record<PaymentOutcome, string> = {
  confirmed: 'Confirmed',
  payment_declined: 'Payment declined — seat released',
  class_full: 'Seat hold expired — seat lost, no charge made',
  already_processed: 'Already processed — nothing changed',
};

/** Claim a seat, then run the mock payment against it. */
export function BookPage() {
  const { classId } = useSearch({ from: '/book' });
  const queryClient = useQueryClient();
  const students = useQuery({ queryKey: keys.students, queryFn: getStudents });
  const classes = useQuery({ queryKey: keys.classes, queryFn: getClasses });

  const [studentId, setStudentId] = useState('');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [payment, setPayment] = useState<CompletePaymentResponse | null>(null);

  // Seat counts and the roster both move whenever a booking or payment lands.
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: keys.classes });
    queryClient.invalidateQueries({ queryKey: keys.allRosters });
  };

  const book = useMutation({
    mutationFn: () => createBooking({ studentId, classId: classId! }),
    onSuccess: (created) => {
      setBooking(created);
      setPayment(null);
      refresh();
    },
  });

  const pay = useMutation({
    mutationFn: (mockSuccess: boolean) => completePayment({ bookingId: booking!.id, mockSuccess }),
    onSuccess: (result) => {
      setPayment(result);
      refresh();
    },
  });

  const reset = () => {
    setBooking(null);
    setPayment(null);
    book.reset();
    pay.reset();
  };

  if (!classId) {
    return (
      <p className="text-sm text-slate-600">
        No class selected. <Link to="/" className="underline">Pick a class</Link>.
      </p>
    );
  }

  const klass = classes.data?.find((c) => c.id === classId);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-xl font-semibold">{klass ? klass.name : 'Book a trial class'}</h1>
        {klass && (
          <p className="text-sm text-slate-500">
            {new Date(klass.startsAt).toLocaleString()} · {klass.confirmedCount} of {klass.capacity}{' '}
            confirmed · {klass.seatsAvailable} free
          </p>
        )}

        <label htmlFor="student" className="block pt-2 text-sm font-medium text-slate-700">
          Child
        </label>
        <select
          id="student"
          value={studentId}
          onChange={(e) => {
            setStudentId(e.target.value);
            reset();
          }}
          className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">Select a child…</option>
          {students.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.parentName}
            </option>
          ))}
        </select>
        {students.isError && <p className="text-sm text-rose-700">{errorText(students.error)}</p>}

        <button
          type="button"
          onClick={() => book.mutate()}
          disabled={!studentId || book.isPending}
          className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:bg-slate-300"
        >
          Create booking
        </button>

        {/* 409 duplicate_booking and 409 class_full surface verbatim — the backend's verdict wins. */}
        {book.isError && (
          <p className="rounded border border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-900">
            Booking rejected: {errorText(book.error)}
          </p>
        )}
      </section>

      {booking && (
        <section className="space-y-3 rounded border border-slate-300 bg-white p-4">
          <h2 className="text-lg font-semibold">Mock payment</h2>
          <p className="text-sm text-slate-600">
            Booking <code className="rounded bg-slate-100 px-1">{booking.id}</code>
            <br />
            Status <strong>{payment?.status ?? booking.status}</strong> · Seat{' '}
            <strong>{booking.seatNo ?? '—'}</strong>
          </p>
          <div className="flex gap-2">
            {/*
              Deliberately still enabled after a result: pressing "Pay" twice is how the
              already_processed replay guard is demonstrated.
            */}
            <button
              type="button"
              onClick={() => pay.mutate(true)}
              disabled={pay.isPending}
              className="rounded bg-emerald-700 px-3 py-2 text-sm text-white disabled:bg-slate-300"
            >
              Pay (success)
            </button>
            <button
              type="button"
              onClick={() => pay.mutate(false)}
              disabled={pay.isPending}
              className="rounded bg-rose-700 px-3 py-2 text-sm text-white disabled:bg-slate-300"
            >
              Pay (fail)
            </button>
            <button type="button" onClick={reset} className="rounded border border-slate-300 px-3 py-2 text-sm">
              Start over
            </button>
          </div>
          {pay.isError && <p className="text-sm text-rose-700">{errorText(pay.error)}</p>}
          {payment && (
            <div className={`rounded border px-4 py-3 text-sm ${outcomeStyle[payment.outcome]}`}>
              <p className="font-semibold">{outcomeTitle[payment.outcome]}</p>
              <p>{payment.message}</p>
              <p className="mt-1 text-xs opacity-80">
                booking status: {payment.status}
                {payment.seatNo !== null && ` · seat ${payment.seatNo}`}
              </p>
            </div>
          )}
        </section>
      )}

      <Link to="/roster" search={{ classId }} className="inline-block text-sm underline">
        View roster for this class
      </Link>
    </div>
  );
}
