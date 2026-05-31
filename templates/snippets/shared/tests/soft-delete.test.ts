import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { users } from '../src/db/schema.js';
import {
  notDeleted,
  withNotDeleted,
  softDeleteFilter,
  softDelete,
  includeDeletedQuerySchema,
} from '../src/db/soft-delete.js';

const dialect = new PgDialect();
const render = (sql: ReturnType<typeof notDeleted> | undefined) =>
  sql ? dialect.sqlToQuery(sql).sql : undefined;

/**
 * A chainable stub that records the arguments passed to update/set/where and
 * resolves `.returning()` with the configured rows. Stands in for a real
 * Drizzle PgDatabase so soft-delete behaviour can be asserted without Postgres.
 */
function makeStubDb(returningRows: Array<{ id: unknown }>) {
  const calls: { table?: unknown; set?: any; where?: any } = {};
  const chain = {
    set: vi.fn((values: unknown) => {
      calls.set = values;
      return chain;
    }),
    where: vi.fn((clause: unknown) => {
      calls.where = clause;
      return chain;
    }),
    returning: vi.fn(() => Promise.resolve(returningRows)),
  };
  const db = {
    update: vi.fn((table: unknown) => {
      calls.table = table;
      return chain;
    }),
  };
  return { db, chain, calls };
}

describe('soft-delete schema', () => {
  it('users table exposes a nullable deleted_at column', () => {
    expect(users.deletedAt).toBeDefined();
    expect(users.deletedAt.name).toBe('deleted_at');
    // Nullable: no NOT NULL constraint, so the soft-delete marker can be unset.
    expect(users.deletedAt.notNull).toBe(false);
  });
});

describe('notDeleted', () => {
  it('produces a `deleted_at IS NULL` predicate', () => {
    const rendered = render(notDeleted(users));
    expect(rendered).toContain('"deleted_at"');
    expect(rendered?.toLowerCase()).toContain('is null');
  });
});

describe('withNotDeleted', () => {
  it('ANDs the not-deleted filter with extra conditions', () => {
    const rendered = render(withNotDeleted(users, eq(users.email, 'a@b.com')))!;
    expect(rendered.toLowerCase()).toContain('is null');
    expect(rendered).toContain('"email"');
    expect(rendered.toLowerCase()).toContain('and');
  });

  it('returns just the not-deleted filter when no extra conditions are given', () => {
    const rendered = render(withNotDeleted(users))!;
    expect(rendered.toLowerCase()).toContain('is null');
    expect(rendered).not.toContain('"email"');
  });
});

describe('softDeleteFilter (?include_deleted handling)', () => {
  it('excludes deleted rows by default (include_deleted = false)', () => {
    const rendered = render(softDeleteFilter(users, false));
    expect(rendered?.toLowerCase()).toContain('is null');
  });

  it('returns no soft-delete filter when include_deleted = true', () => {
    // With no other conditions, the where clause is empty (undefined).
    expect(softDeleteFilter(users, true)).toBeUndefined();
  });

  it('keeps caller conditions but drops the not-deleted filter when include_deleted = true', () => {
    const rendered = render(softDeleteFilter(users, true, eq(users.email, 'a@b.com')))!;
    expect(rendered).toContain('"email"');
    expect(rendered.toLowerCase()).not.toContain('is null');
  });
});

describe('softDelete', () => {
  it('sets deleted_at to a Date instead of issuing a DELETE', async () => {
    const { db, calls } = makeStubDb([{ id: '00000000-0000-0000-0000-000000000001' }]);

    const affected = await softDelete(db as never, users, '00000000-0000-0000-0000-000000000001');

    expect(db.update).toHaveBeenCalledWith(users);
    expect(calls.set).toMatchObject({ deletedAt: expect.any(Date) });
    expect(affected).toBe(1);
  });

  it('guards on `deleted_at IS NULL` so a missing/already-deleted row affects 0 rows', async () => {
    const { db, calls } = makeStubDb([]);

    const affected = await softDelete(db as never, users, 'missing');

    expect(affected).toBe(0);
    const renderedWhere = render(calls.where);
    expect(renderedWhere?.toLowerCase()).toContain('is null');
    expect(renderedWhere).toContain('"id"');
  });
});

describe('includeDeletedQuerySchema', () => {
  it('defaults to false when the param is absent', () => {
    expect(includeDeletedQuerySchema.parse({})).toEqual({ include_deleted: false });
  });

  it('parses the literal string "true" as boolean true', () => {
    expect(includeDeletedQuerySchema.parse({ include_deleted: 'true' })).toEqual({
      include_deleted: true,
    });
  });

  it('parses "false" as boolean false', () => {
    expect(includeDeletedQuerySchema.parse({ include_deleted: 'false' })).toEqual({
      include_deleted: false,
    });
  });

  it('rejects values other than "true"/"false"', () => {
    expect(() => includeDeletedQuerySchema.parse({ include_deleted: 'yes' })).toThrow();
  });
});
