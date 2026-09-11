import { useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Booking, CompletePaymentResponse, PaymentOutcome } from '@roster/types';
import { completePayment, createBooking, errorText, getClasses, getStudents, keys } from '../api';
import { SeatDots } from '../components/SeatDots';
import { formatWhen, seatsLeft } from '../format';

const outcome: Record<PaymentOutcome, { title: string; tone: string }> = {
  confirmed: { title: 'Seat confirmed', tone: 'text-ok' },
  payment_declined: { title: 'Payment declined', tone: 'text-err' },
  class_full: { title: 'Seat no longer available', tone: 'text-warn' },
  already_processed: { title: 'Already processed', tone: 'text-ink-2' },
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
      <div className="enter">
        <h1 className="display">No class selected</h1>
        <p className="mt-3 text-[17px] text-ink-2">Choose a class first, then book a seat.</p>
        <Link to="/" className="btn btn-primary mt-8">
          See classes
        </Link>
      </div>
    );
  }

  const klass = classes.data?.find((c) => c.id === classId);
  const child = students.data?.find((s) => s.id === studentId);
  const status = payment?.status ?? booking?.status;

  return (
    <div>
      <Link to="/" className="enter mb-6 inline-flex items-center gap-1 text-[15px] text-accent">
        <span aria-hidden="true">‹</span> Classes
      </Link>

      <header className="enter mb-10" style={{ '--i': 1 } as React.CSSProperties}>
        <h1 className="display">{klass?.name ?? 'Book a seat'}</h1>
        {klass && (
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[17px] text-ink-2">
            <span>{formatWhen(klass.startsAt)}</span>
            <span className="text-ink-3">·</span>
            <span className="inline-flex items-center gap-2.5">
              <SeatDots capacity={klass.capacity} confirmed={klass.confirmedCount} locked={klass.seatsLocked} />
              {seatsLeft(klass.seatsAvailable, klass.seatsLocked)}
            </span>
          </p>
        )}
      </header>

      <section className="card enter px-6 py-6" style={{ '--i': 2 } as React.CSSProperties}>
        <label htmlFor="student" className="mb-2 block text-[13px] font-medium text-ink-2">
          Child
        </label>
        <select
          id="student"
          className="select"
          value={studentId}
          disabled={booking !== null}
          onChange={(e) => {
            setStudentId(e.target.value);
            reset();
          }}
        >
          <option value="">Choose a child</option>
          {students.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.parentName}
            </option>
          ))}
        </select>
        {students.isError && (
          <p className="mt-3 text-[15px] text-err">
            <span className="dot" />
            {errorText(students.error)}
          </p>
        )}

        {!booking && (
          <div className="mt-5 flex items-center gap-4">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => book.mutate()}
              disabled={!studentId || book.isPending}
            >
              {book.isPending ? 'Reserving…' : 'Book a seat'}
            </button>
            {/* 409 duplicate_booking and 409 class_full surface verbatim — the backend's verdict wins. */}
            {book.isError && (
              <p className="text-[15px] text-err">
                <span className="dot" />
                {errorText(book.error)}
              </p>
            )}
          </div>
        )}
      </section>

      {booking && (
        <section className="card enter mt-4 px-6 py-6" key={booking.id}>
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="text-[13px] font-medium text-ink-2">Reserved for {child?.name ?? 'your child'}</p>
              <p className="display mt-1">Seat {booking.seatNo ?? '—'}</p>
            </div>
            <p className="rounded-full bg-surface px-3 py-1 text-[13px] font-medium text-ink-2">
              {status === 'PENDING_PAYMENT' ? 'Awaiting payment' : status === 'CONFIRMED' ? 'Confirmed' : 'Not confirmed'}
            </p>
          </div>

          {!payment && (
            <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
              The seat is held while you pay. This is a mock payment, so you choose the result.
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {/* Still enabled after a result: pressing Pay twice is how the replay guard is demonstrated. */}
            <button type="button" className="btn btn-primary" onClick={() => pay.mutate(true)} disabled={pay.isPending}>
              Pay now
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => pay.mutate(false)} disabled={pay.isPending}>
              Simulate a decline
            </button>
            <button type="button" className="btn btn-tertiary" onClick={reset}>
              Start over
            </button>
          </div>

          {pay.isError && (
            <p className="mt-4 text-[15px] text-err">
              <span className="dot" />
              {errorText(pay.error)}
            </p>
          )}

          {payment && (
            <div className="hairline enter mt-6 border-t pt-5" key={`${payment.outcome}-${payment.status}`}>
              <p className={`text-[15px] font-semibold ${outcome[payment.outcome].tone}`}>
                <span className="dot" />
                {outcome[payment.outcome].title}
              </p>
              <p className="mt-1.5 text-[15px] leading-relaxed text-ink-2">{payment.message}</p>
              {payment.outcome === 'confirmed' && (
                <Link to="/roster" search={{ classId }} className="btn btn-tertiary mt-3">
                  See the roster
                </Link>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
