import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { errorText, getClasses, getRoster, keys } from '../api';
import { SeatDots } from '../components/SeatDots';
import { formatWhen } from '../format';

/** Confirmed bookings for one class, in seat order. */
export function RosterPage() {
  const { classId } = useSearch({ from: '/roster' });
  const navigate = useNavigate();
  const classes = useQuery({ queryKey: keys.classes, queryFn: getClasses });
  const roster = useQuery({
    queryKey: keys.roster(classId ?? ''),
    queryFn: () => getRoster(classId!),
    enabled: classId !== undefined,
  });

  const selected = classes.data?.find((c) => c.id === classId);
  const confirmed = roster.data?.length ?? 0;

  return (
    <div>
      <header className="enter mb-10">
        <h1 className="display">Roster</h1>
        <p className="mt-3 text-[17px] leading-relaxed text-ink-2">
          Confirmed seats for a class. A student appears here only after payment succeeds.
        </p>
      </header>

      <div className="enter" style={{ '--i': 1 } as React.CSSProperties}>
        <label htmlFor="class" className="mb-2 block text-[13px] font-medium text-ink-2">
          Class
        </label>
        {/* The select drives ?classId=…, so the URL stays the single source of truth. */}
        <select
          id="class"
          className="select"
          value={classId ?? ''}
          onChange={(e) => navigate({ to: '/roster', search: { classId: e.target.value || undefined } })}
        >
          <option value="">Choose a class</option>
          {classes.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {roster.isError && (
        <p className="mt-6 text-[15px] text-err">
          <span className="dot" />
          {errorText(roster.error)}
        </p>
      )}

      {selected && roster.data && (
        <section className="card enter mt-8 overflow-hidden" key={selected.id}>
          <div className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <h2 className="title">{selected.name}</h2>
              <p className="mt-1 text-[15px] text-ink-2">{formatWhen(selected.startsAt)}</p>
            </div>
            <p className="flex items-center gap-3 text-[13px] text-ink-3">
              <SeatDots capacity={selected.capacity} confirmed={confirmed} />
              {confirmed} of {selected.capacity}
            </p>
          </div>

          {roster.data.length === 0 ? (
            <div className="hairline border-t px-6 py-12 text-center">
              <p className="text-[15px] font-medium">No confirmed seats yet</p>
              <p className="mt-1 text-[15px] text-ink-2">Students appear here once their payment goes through.</p>
              <Link to="/book" search={{ classId: selected.id }} className="btn btn-tertiary mt-4">
                Book a seat
              </Link>
            </div>
          ) : (
            <ol className="hairline divide-y divide-[var(--hairline)] border-t">
              {/* Already ordered by seat_no server-side; we do not re-sort. */}
              {roster.data.map((entry) => (
                <li key={entry.bookingId} className="flex items-center gap-5 px-6 py-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface text-[13px] font-medium text-ink-2">
                    {entry.seatNo}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{entry.studentName}</p>
                    <p className="text-[13px] text-ink-3">{entry.parentName}</p>
                  </div>
                  <p className="shrink-0 text-[13px] text-ink-3">{formatWhen(entry.confirmedAt)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
