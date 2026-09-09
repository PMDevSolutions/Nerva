/**
 * Single import point for test fixtures:
 *
 *   import { userFactory, seedFactories } from './fixtures/index.js';
 *
 * Add a line here for each new factory module.
 */
export { createFactory, seedFactories, userFactory } from './factory.js';
export type { Factory, Overrides } from './factory.js';
