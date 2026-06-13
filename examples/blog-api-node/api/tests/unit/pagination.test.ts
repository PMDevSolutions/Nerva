import { describe, expect, it } from 'vitest';
import { pageMeta, paginationQuerySchema } from '../../src/lib/pagination.js';

describe('paginationQuerySchema', () => {
  it('applies defaults when no params are given', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it('coerces query-string values to numbers', () => {
    expect(paginationQuerySchema.parse({ limit: '5', offset: '10' })).toEqual({
      limit: 5,
      offset: 10,
    });
  });

  it('rejects out-of-range values', () => {
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
  });
});

describe('pageMeta', () => {
  it('echoes total alongside the requested window', () => {
    expect(pageMeta(42, { limit: 10, offset: 20 })).toEqual({ total: 42, limit: 10, offset: 20 });
  });
});
