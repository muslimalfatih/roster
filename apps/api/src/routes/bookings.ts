import { Elysia, t } from 'elysia';
import { createBooking } from '../services/booking';

export const bookingRoutes = new Elysia({ prefix: '/api' }).post(
  '/bookings',
  ({ body, set }) => {
    set.status = 201;
    return createBooking(body.studentId, body.classId);
  },
  // A schema failure is Elysia's own 422; 409 and 404 come from the service.
  {
    body: t.Object({
      studentId: t.String({ format: 'uuid' }),
      classId: t.String({ format: 'uuid' }),
    }),
  },
);
