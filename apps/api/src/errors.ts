import type { ApiError } from '@roster/types';

/** Thrown by services; app.ts's onError maps it 1:1 onto an ApiError response body. */
export class AppError extends Error {
  status: number;
  error: ApiError['error'];

  constructor(status: number, error: ApiError['error'], message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.error = error;
  }

  toBody(): ApiError {
    return { error: this.error, message: this.message };
  }
}

export const NotFoundError = (message: string) => new AppError(404, 'not_found', message);

export const ConflictError = (
  error: 'duplicate_booking' | 'class_full',
  message: string,
) => new AppError(409, error, message);
