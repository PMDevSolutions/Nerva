/**
 * Test data factories.
 *
 * A factory builds plain insert-shaped objects with realistic values from
 * `@faker-js/faker`, so tests never hand-write entities. Every call takes an
 * optional `overrides` object for the fields a test cares about; everything
 * else is generated. A per-factory sequence keeps generated identifiers unique
 * across a test run even when faker repeats a value.
 *
 * Usage:
 *
 *   const user = userFactory();                       // one NewUser
 *   const admin = userFactory({ name: 'Admin User' });// with overrides
 *   const users = userFactory.createMany(5);          // five unique users
 *   const numbered = userFactory.createMany(3, (i) => ({ name: `User ${i}` }));
 *
 * Reproducibility: call `seedFactories()` (or `faker.seed(n)`) at the top of a
 * test file to get the same data on every run. Add a factory per entity below
 * as your schema grows; keep them in this directory and re-export from
 * ./index.ts so tests import from one place.
 */
import { faker } from '@faker-js/faker';
import type { NewUser } from '../../src/db/schema.js';

export type Overrides<T> = Partial<T> | ((index: number) => Partial<T>);

export interface Factory<T> {
  /** Build one entity, applying `overrides` on top of generated values. */
  (overrides?: Partial<T>): T;
  /** Alias of the call signature, for readability in table-driven tests. */
  build(overrides?: Partial<T>): T;
  /**
   * Build `count` entities. `overrides` may be an object applied to every
   * entity or a function of the zero-based index for per-entity values.
   */
  createMany(count: number, overrides?: Overrides<T>): T[];
  /** Reset the sequence counter (useful between seeded runs). */
  reset(): void;
}

/**
 * Create a typed factory from a generator. The generator receives a
 * monotonically increasing sequence number, starting at 1, that it can fold
 * into unique fields such as emails or slugs.
 */
export function createFactory<T extends object>(generate: (sequence: number) => T): Factory<T> {
  let sequence = 0;

  const build = (overrides?: Partial<T>): T => {
    sequence += 1;
    return { ...generate(sequence), ...overrides };
  };

  const factory = ((overrides?: Partial<T>) => build(overrides)) as Factory<T>;
  factory.build = build;
  factory.createMany = (count, overrides) => {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`createMany expects a non-negative integer, received ${String(count)}`);
    }
    return Array.from({ length: count }, (_, index) =>
      build(typeof overrides === 'function' ? overrides(index) : overrides),
    );
  };
  factory.reset = () => {
    sequence = 0;
  };
  return factory;
}

/** Seed faker so factories produce identical data on every run. */
export function seedFactories(seed = 12345): void {
  faker.seed(seed);
}

/**
 * Users, matching `users` in src/db/schema.ts. Columns with database defaults
 * (id, timestamps, deleted_at) are left for PostgreSQL to fill, so the result
 * can be passed straight to `db.insert(users).values(...)`.
 */
export const userFactory = createFactory<NewUser>((sequence) => {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  return {
    // The sequence guarantees uniqueness; the name keeps it readable.
    email: `${firstName}.${lastName}.${sequence}@example.com`.toLowerCase(),
    name: `${firstName} ${lastName}`,
  };
});
