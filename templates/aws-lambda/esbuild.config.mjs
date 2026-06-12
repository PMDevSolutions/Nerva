import { build } from 'esbuild';

// Bundles the Lambda entry point into a single minified ESM file. One small
// artifact keeps cold starts short: there is no node_modules tree to unzip
// and resolve during the init phase.
await build({
  entryPoints: ['src/lambda.ts'],
  outfile: 'dist/lambda.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: true,
  // Shim require() for transitive CommonJS dependencies in the ESM bundle
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // The AWS SDK v3 ships with the nodejs runtime; never bundle it
  external: ['@aws-sdk/*'],
});
