const when = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Sat 13 Sep, 10:00" — not the full ISO dump `toLocaleString()` gives you. */
export const formatWhen = (iso: string) => when.format(new Date(iso));

/** "1 seat left", "1 held", "Full". A held seat is not free, but it is not gone either. */
export const seatsLeft = (free: number, held = 0) => {
  if (free > 0) return free === 1 ? '1 seat left' : `${free} seats left`;
  if (held > 0) return held === 1 ? '1 seat held' : `${held} seats held`;
  return 'Full';
};
