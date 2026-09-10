import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { errorText, getClasses, keys } from '../api';

/** Every class with its live seat inventory. */
export function ClassesPage() {
  const classes = useQuery({ queryKey: keys.classes, queryFn: getClasses });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Trial classes</h1>
      {classes.isPending && <p className="text-sm text-slate-500">Loading classes…</p>}
      {classes.isError && <p className="text-sm text-rose-700">{errorText(classes.error)}</p>}

      <ul className="space-y-2">
        {classes.data?.map((c) => {
          // Cosmetic only: "full" here is a stale render of seatsAvailable and is
          // never a guarantee. Seats move between this render and the request; the database's
          // seat rows + partial unique indexes are the only thing preventing overbooking.
          const full = c.seatsAvailable <= 0;
          return (
            <li
              key={c.id}
              className="flex items-center justify-between gap-4 rounded border border-slate-200 bg-white px-4 py-3"
            >
              <div className="text-sm">
                <p className="font-medium">
                  {c.name}
                  {full && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">FULL</span>
                  )}
                </p>
                <p className="text-slate-500">{new Date(c.startsAt).toLocaleString()}</p>
                <p className="text-slate-500">
                  {c.confirmedCount} of {c.capacity} confirmed · {c.seatsAvailable} free
                  {c.seatsLocked > 0 && ` · ${c.seatsLocked} held`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  to="/roster"
                  search={{ classId: c.id }}
                  className="rounded border border-slate-300 px-3 py-2 text-sm"
                >
                  Roster
                </Link>
                {full ? (
                  <span className="rounded bg-slate-200 px-3 py-2 text-sm text-slate-500">Full</span>
                ) : (
                  <Link
                    to="/book"
                    search={{ classId: c.id }}
                    className="rounded bg-slate-900 px-3 py-2 text-sm text-white"
                  >
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
