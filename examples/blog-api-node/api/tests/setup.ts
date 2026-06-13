// Set required environment variables before any module imports them.
// src/config.ts parses process.env at module load, so these must be present
// before the first app/route import. DATABASE_URL is a placeholder: tests
// run against an in-process PGlite database (see tests/helpers.ts), never a
// real PostgreSQL server.
process.env['NODE_ENV'] ??= 'test';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-for-integration-tests-min-32-chars';
process.env['APP_VERSION'] ??= '0.0.1-test';
process.env['HEALTH_DB_TIMEOUT_MS'] ??= '2000';
