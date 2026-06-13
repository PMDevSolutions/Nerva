import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Error codes from the Nerva API standards (docs/api-development/README.md).
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  field: string;
  message: string;
}

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details?: ErrorDetail[],
): Response {
  return c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}
