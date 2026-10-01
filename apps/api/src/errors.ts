import { FourEyesViolation } from '@khalta/rbac';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthenticated = () =>
  new ApiError(401, 'unauthenticated', 'Authentication required');
export const forbidden = (m = 'Not allowed') => new ApiError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new ApiError(404, 'not_found', m);
export const conflict = (m: string) => new ApiError(409, 'conflict', m);

/** Drizzle wraps driver errors; the Postgres SQLSTATE lives on the error or its cause chain. */
function pgCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 5; i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    e = e.cause as typeof e;
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: { code: string; message: string; details?: unknown } = {
    code: 'internal_error',
    message: 'Internal server error',
  };
  if (err instanceof ApiError) {
    status = err.status;
    body = { code: err.code, message: err.message, details: err.details };
  } else if (err instanceof ZodError) {
    status = 400;
    body = { code: 'invalid_request', message: 'Invalid request', details: err.issues };
  } else if (err instanceof FourEyesViolation) {
    status = 403;
    body = { code: 'four_eyes', message: err.message };
  } else if (pgCode(err) === '23505') {
    status = 409;
    body = { code: 'conflict', message: 'A record with these values already exists' };
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    body = { code: 'too_large', message: 'The upload is too large' };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { code: 'invalid_json', message: 'Malformed JSON body' };
  }
  if (status >= 500) req.log?.error({ err }, 'unhandled error');
  res.status(status).json({ error: body });
};
