import type { ApiError } from '@roster/types';
import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { sql } from './db';
import { env } from './env';
import { AppError } from './errors';
import { bookingRoutes } from './routes/bookings';
import { classRoutes } from './routes/classes';
import { paymentRoutes } from './routes/payments';
import { studentRoutes } from './routes/students';

/** Factory, not a singleton: every test gets a fresh instance on its own ephemeral port. */
export function createApp() {
  return new Elysia()
    .use(cors({ origin: env.corsOrigin ?? true }))
    // One place maps errors to responses. Nothing else in the app sets an error status.
    .onError({ as: 'global' }, ({ code, error, set }) => {
      // Schema validation is Elysia's own: returning nothing lets its 422 body through.
      if (code === 'VALIDATION') return;

      // A body we cannot parse is the client's mistake, not ours: 400, no stack, no
      // "unhandled error" log. PARSE is the only non-VALIDATION 4xx code
      // this app can raise — no cookies, no file uploads.
      if (code === 'PARSE') {
        set.status = 400;
        return { error: 'invalid_request', message: 'Request body is not valid JSON.' } satisfies ApiError;
      }

      if (error instanceof AppError) {
        set.status = error.status;
        return error.toBody();
      }

      if (code === 'NOT_FOUND') {
        set.status = 404;
        return { error: 'not_found', message: 'Route not found.' } satisfies ApiError;
      }

      // Anything unhandled is a bug: log it server-side, tell the client nothing useful —
      // no Postgres message, no stack.
      console.error('[api] unhandled error', error);
      set.status = 500;
      return { error: 'internal_error', message: 'Something went wrong.' } satisfies ApiError;
    })
    // Liveness: is the process up. Deliberately does NOT touch the database — this is what
    // the container HEALTHCHECK polls, and restarting the API does not fix a down database.
    .get('/api/health', () => ({ ok: true }))
    // Readiness: can we actually serve traffic. This is the one to point uptime monitoring at.
    .get('/api/ready', async ({ set }) => {
      try {
        await sql`SELECT 1`;
        return { ok: true, db: 'up' as const };
      } catch {
        set.status = 503;
        return { ok: false, db: 'down' as const };
      }
    })
    .use(studentRoutes)
    .use(classRoutes)
    .use(bookingRoutes)
    .use(paymentRoutes);
}
