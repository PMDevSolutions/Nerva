import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { z } from 'zod';

/**
 * zValidator with the standard Nerva error envelope on failure. Handlers
 * behind it read the parsed value with `c.req.valid(target)`.
 */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: result.error.issues.map((issue) => ({
              field: issue.path.map(String).join('.') || target,
              message: issue.message,
            })),
          },
        },
        400,
      );
    }
    return undefined;
  });
}
