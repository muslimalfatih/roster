/**
 * Configuration comes from the environment, parsed once at import so a missing DATABASE_URL
 * fails at startup rather than on the first request.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to apps/api/.env before starting the API.',
  );
}

export const env = {
  databaseUrl,
  port: Number(process.env.PORT ?? 3000),
  // Undefined reflects any origin, which is fine locally. A deployment must pin this to the
  // frontend origin.
  corsOrigin: process.env.CORS_ORIGIN,
  // How long a claimed seat stays locked before the hold lapses. Lapsed holds are reclaimed
  // at claim time, so there is no sweeper job.
  seatHoldMinutes: Number(process.env.SEAT_HOLD_MINUTES ?? 10),
};
