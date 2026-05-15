import { z } from 'zod';

export const envSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'staging', 'production']).default('development'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_VERSION: z.string().default('unknown'),
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof envSchema>;

export function parseConfig(env: unknown): Config {
  return envSchema.parse(env);
}
