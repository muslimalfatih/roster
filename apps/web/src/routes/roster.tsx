import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { errorText, getClasses, getRoster, keys } from '../api';

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

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Admin — confirmed roster</h1>
        <label htmlFor="class" className="block text-sm font-medium text-slate-700">
          Class
        </label>
        {/* The select drives ?classId=…, so the URL stays the single source of truth. */}
        <select
          id="class"
          value={classId ?? ''}
          onChange={(e) => navigate({ to: '/roster', search: { classId: e.target.value || undefined } })}
          className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">Select a class…</option>
          {classes.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <p className="text-sm text-slate-600">
          {roster.data?.length ?? 0} of {selected.capacity} seats confirmed
        </p>
      )}

      {classId && roster.isPending && <p className="text-sm text-slate-500">Loading roster…</p>}
      {roster.isError && <p className="text-sm text-rose-700">{errorText(roster.error)}</p>}

      {classId &&
        roster.data &&
        (roster.data.length === 0 ? (
          <p className="rounded border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
            No confirmed students yet.
          </p>
        ) : (
          <table className="w-full border-collapse overflow-hidden rounded border border-slate-200 bg-white text-sm">
            <thead className="bg-slate-100 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">Seat</th>
                <th className="px-3 py-2 font-medium">Student</th>
                <th className="px-3 py-2 font-medium">Parent</th>
                <th className="px-3 py-2 font-medium">Confirmed at</th>
              </tr>
            </thead>
            <tbody>
              {/* Already ordered by seat_no server-side; we do not re-sort. */}
              {roster.data.map((entry) => (
                <tr key={entry.bookingId} className="border-t border-slate-200">
                  <td className="px-3 py-2 text-slate-500">{entry.seatNo}</td>
                  <td className="px-3 py-2">{entry.studentName}</td>
                  <td className="px-3 py-2 text-slate-600">{entry.parentName}</td>
                  <td className="px-3 py-2 text-slate-600">{new Date(entry.confirmedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}
