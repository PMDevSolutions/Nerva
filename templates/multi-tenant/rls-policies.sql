-- ============================================================================
-- Row Level Security policies for row-based multi-tenancy.
--
-- Applies to the ROW strategy only (TENANCY_STRATEGY=row). Under the schema
-- strategy, isolation comes from per-tenant schemas + search_path instead.
--
-- How it works:
--   * withTenant() (src/tenancy/row-scope.ts) runs queries inside a
--     transaction with `app.tenant_id` set via SET LOCAL.
--   * The policy below compares each row's tenant_id to that setting.
--   * When the setting is absent, current_setting(..., true) returns NULL /
--     empty string, the comparison is never true, and NO rows are visible or
--     writable — fail closed, not open.
--
-- Apply as a custom Drizzle migration so it deploys with the schema:
--   pnpm drizzle-kit generate --custom --name enable-rls
--   # paste this file's statements into the generated migration, then:
--   pnpm drizzle-kit migrate
--
-- IMPORTANT — who RLS applies to:
--   * FORCE ROW LEVEL SECURITY makes the policy apply to the table owner too.
--   * Superusers and roles with BYPASSRLS always bypass RLS. Do not run the
--     API as a superuser (the default `postgres` user in many docker images
--     is one) — create a dedicated application role:
--
--       CREATE ROLE app_user LOGIN PASSWORD '...';
--       GRANT USAGE ON SCHEMA public TO app_user;
--       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--       ALTER DEFAULT PRIVILEGES IN SCHEMA public
--         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
-- ============================================================================

-- ---------------------------------------------------------------------------
-- projects — copy this block for EVERY tenant-scoped table.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- One FOR ALL policy covers SELECT/INSERT/UPDATE/DELETE:
--   USING      — which existing rows are visible (SELECT/UPDATE/DELETE).
--   WITH CHECK — which new/updated rows are allowed (INSERT/UPDATE), so a
--                request cannot write rows for another tenant, and UPDATE
--                cannot re-home a row to a different tenant.
-- nullif(..., '') guards against PostgreSQL returning an empty string (rather
-- than NULL) for a setting that was assigned earlier in the session.
CREATE POLICY tenant_isolation ON projects
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The tenants registry itself is NOT tenant-scoped: the resolver middleware
-- must read it before any tenant context exists. Leave RLS off for it, or add
-- a permissive read-only policy if your application role should not see the
-- full tenant list.
