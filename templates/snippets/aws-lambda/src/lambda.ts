import { handle } from 'hono/aws-lambda';
import app from './index.js';

// AWS Lambda entry point. The adapter translates API Gateway events (payload
// format 1.0 and 2.0) and ALB events into standard Requests for Hono.
// esbuild.config.mjs bundles this file into dist/lambda.mjs; template.yaml
// points the function handler at "lambda.handler".
export const handler = handle(app);
