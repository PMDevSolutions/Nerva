/**
 * Example usage of the test data factories in tests/fixtures/.
 *
 * These tests double as living documentation: they show building a single
 * entity, applying overrides, building many, and seeding faker for
 * reproducible data. They need no database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { faker } from '@faker-js/faker';
import { createFactory, seedFactories, userFactory } from './fixtures/index.js';
import type { NewUser } from '../src/db/schema.js';

describe('userFactory', () => {
  beforeEach(() => {
    userFactory.reset();
    seedFactories();
  });

  it('builds a user with a realistic name and a lowercase example.com email', () => {
    const user = userFactory();
    expect(user.name).toMatch(/^\S+ \S+$/);
    expect(user.email).toMatch(/^[a-z0-9.'-]+@example\.com$/);
    expect(user.email).toBe(user.email.toLowerCase());
  });

  it('applies overrides on top of generated values', () => {
    const user = userFactory({ name: 'Custom Name' });
    expect(user.name).toBe('Custom Name');
    expect(user.email).toContain('@example.com');
    expect(userFactory.build({ email: 'fixed@example.com' }).email).toBe('fixed@example.com');
  });

  it('createMany returns the requested number of users with unique emails', () => {
    const users = userFactory.createMany(5);
    expect(users).toHaveLength(5);
    expect(new Set(users.map((u) => u.email)).size).toBe(5);
  });

  it('createMany accepts per-entity overrides by index', () => {
    const users = userFactory.createMany(3, (i) => ({ name: `User ${i}` }));
    expect(users.map((u) => u.name)).toEqual(['User 0', 'User 1', 'User 2']);
  });

  it('createMany rejects a non-integer or negative count', () => {
    expect(() => userFactory.createMany(-1)).toThrow(RangeError);
    expect(() => userFactory.createMany(1.5)).toThrow(RangeError);
    expect(userFactory.createMany(0)).toEqual([]);
  });

  it('produces the same data on every run once seeded', () => {
    seedFactories(42);
    userFactory.reset();
    const first = userFactory.createMany(3);
    seedFactories(42);
    userFactory.reset();
    const second = userFactory.createMany(3);
    expect(second).toEqual(first);
  });

  it('matches the insert shape of the users table', () => {
    // Compile-time check: a factory result is assignable to NewUser, so it can
    // be passed straight to db.insert(users).values(...).
    const values: NewUser[] = userFactory.createMany(2);
    expect(values.every((v) => typeof v.email === 'string' && typeof v.name === 'string')).toBe(true);
    // Columns with database defaults are intentionally left unset.
    expect(values[0]).not.toHaveProperty('id');
    expect(values[0]).not.toHaveProperty('createdAt');
  });
});

describe('createFactory', () => {
  it('threads a 1-based sequence through the generator and resets on demand', () => {
    const numbered = createFactory<{ n: number }>((sequence) => ({ n: sequence }));
    expect(numbered().n).toBe(1);
    expect(numbered().n).toBe(2);
    numbered.reset();
    expect(numbered().n).toBe(1);
  });

  it('works with any entity shape, not just schema tables', () => {
    interface Token {
      value: string;
      expiresInSeconds: number;
    }
    const tokenFactory = createFactory<Token>(() => ({
      value: faker.string.alphanumeric(32),
      expiresInSeconds: 900,
    }));
    const token = tokenFactory({ expiresInSeconds: 60 });
    expect(token.value).toHaveLength(32);
    expect(token.expiresInSeconds).toBe(60);
  });
});
