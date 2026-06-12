import { serve } from '@hono/node-server';
import { config } from './config';
import app from './index.js';

// Local development server only — deployed environments run src/lambda.ts on
// AWS Lambda. The same Hono app serves both, so behavior matches production.
console.log(`Dev server starting on port ${config.PORT}`);

serve({ fetch: app.fetch, port: config.PORT });
