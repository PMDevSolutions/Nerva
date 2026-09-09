/**
 * Factories for the multi-tenant tables in src/tenancy/schema.ts.
 *
 *   const tenant = tenantFactory({ plan: 'pro' });
 *   const [row] = await db.insert(tenants).values(tenant).returning();
 *   const project = projectFactory({ tenantId: row.id });
 *
 * `projectFactory` generates a random tenantId so the object is complete on
 * its own; pass the real id of an inserted tenant when writing to the
 * database, since the column is a foreign key.
 */
import { faker } from '@faker-js/faker';
import type { NewProject, NewTenant } from '../../src/tenancy/schema.js';
import { createFactory } from './factory.js';

export const tenantFactory = createFactory<NewTenant>((sequence) => {
  const name = faker.company.name();
  return {
    name,
    // Slugs must be unique and URL-safe: derived from the name, suffixed by the sequence.
    slug: `${faker.helpers.slugify(name).toLowerCase().replace(/[^a-z0-9-]/g, '')}-${sequence}`,
    plan: 'free',
  };
});

export const projectFactory = createFactory<NewProject>(() => ({
  tenantId: faker.string.uuid(),
  name: faker.commerce.productName(),
}));
