import { Elysia, t } from 'elysia';
import { completePayment } from '../services/booking';

export const paymentRoutes = new Elysia({ prefix: '/api' }).post(
  '/payments/complete',
  // Always 200 for a known booking: a declined card, a replay and a lost seat are business
  // outcomes, not transport errors, so they are reported in the body as `outcome`.
  ({ body }) => completePayment(body.bookingId, body.mockSuccess),
  {
    body: t.Object({
      bookingId: t.String({ format: 'uuid' }),
      mockSuccess: t.Boolean(),
    }),
  },
);
