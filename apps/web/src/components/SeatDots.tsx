type Props = { capacity: number; confirmed: number; locked?: number };

/** One dot per seat: filled is confirmed, ring is held, faint is free. */
export function SeatDots({ capacity, confirmed, locked = 0 }: Props) {
  return (
    <span className="seats" aria-hidden="true">
      {Array.from({ length: capacity }, (_, i) => (
        <span
          key={i}
          className="seat"
          data-s={i < confirmed ? 'booked' : i < confirmed + locked ? 'locked' : 'free'}
        />
      ))}
    </span>
  );
}
