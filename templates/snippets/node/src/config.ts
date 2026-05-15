import { z } from 'zod';

const isProduction = process.env['NODE_ENV'] === 'production';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: isProduction
    ? z.string().min(32, 'JWT_SECRET must be at least 32 characters in production')
    : z.string().min(32).default('dev-secret-change-me-in-production-min-32-chars'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default(isProduction ? 'info' : 'debug'),
  APP_VERSION: z.string().default('unknown'),
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof envSchema>;

export const config: Config = envSchema.parse(process.env);
