import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { errorText, getClasses, keys } from '../api';
import { SeatDots } from '../components/SeatDots';
import { formatWhen, seatsLeft } from '../format';

/** Every class with its live seat inventory. */
export function ClassesPage() {
  const classes = useQuery({ queryKey: keys.classes, queryFn: getClasses });

  return (
    <div>
      <header className="enter mb-10">
        <h1 className="display">Trial classes</h1>
        <p className="mt-3 text-[17px] leading-relaxed text-ink-2">
          Every class has four seats. Choose one to book a place for your child.
        </p>
      </header>

      {classes.isPending && <p className="text-[15px] text-ink-3">Loading classes…</p>}
      {classes.isError && (
        <p className="text-[15px] text-err">
          <span className="dot" />
          {errorText(classes.error)}
        </p>
      )}

      <ul className="space-y-3">
        {classes.data?.map((c, i) => {
          // Cosmetic only. Seats move between this render and the request; the database's
          // seat rows and unique indexes are the only thing preventing overbooking.
          const full = c.seatsAvailable <= 0;
          return (
            <li
              key={c.id}
              className="card enter flex flex-col gap-5 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
              style={{ '--i': i + 1 } as React.CSSProperties}
            >
              <div className="min-w-0">
                <h2 className="title">{c.name}</h2>
                <p className="mt-1 text-[15px] text-ink-2">{formatWhen(c.startsAt)}</p>
                <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
                  <SeatDots capacity={c.capacity} confirmed={c.confirmedCount} locked={c.seatsLocked} />
                  <span className="whitespace-nowrap">
                    {c.confirmedCount} of {c.capacity} confirmed
                  </span>
                  <span className="whitespace-nowrap">{seatsLeft(c.seatsAvailable, c.seatsLocked)}</span>
                </p>
              </div>

              <div className="flex items-center gap-2 sm:shrink-0">
                <Link to="/roster" search={{ classId: c.id }} className="btn btn-tertiary text-[15px]">
                  Roster
                </Link>
                {full ? (
                  <span className="btn btn-secondary" aria-disabled="true">
                    Full
                  </span>
                ) : (
                  <Link to="/book" search={{ classId: c.id }} className="btn btn-primary">
                    Book
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
