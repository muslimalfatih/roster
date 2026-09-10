import type { ApiError } from '@roster/types';
import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
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
    .get('/api/health', () => ({ ok: true }))
    .use(studentRoutes)
    .use(classRoutes)
    .use(bookingRoutes)
    .use(paymentRoutes);
}
