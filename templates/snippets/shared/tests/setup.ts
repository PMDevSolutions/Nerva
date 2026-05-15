import { beforeAll, afterAll } from 'vitest';

// Set required environment variables before any module imports them.
// The Node config module parses process.env at module load, so these must
// be present before the first route/service import.
process.env['NODE_ENV'] ??= 'test';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-for-unit-tests-min-32-characters';
process.env['APP_VERSION'] ??= '0.0.1';
process.env['HEALTH_DB_TIMEOUT_MS'] ??= '2000';

beforeAll(() => {
  // Global setup before all tests
});

afterAll(() => {
  // Global cleanup after all tests
});
