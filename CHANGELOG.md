# Changelog

All notable changes to the Nerva framework will be documented in this file.

This changelog is automatically generated from [Conventional Commits](https://www.conventionalcommits.org/).

## [0.6.0](https://github.com/PMDevSolutions/Nerva/compare/v0.5.0...v0.6.0) (2026-05-15)


### Features

* add --dry-run flag to setup-project.sh ([179e8d3](https://github.com/PMDevSolutions/Nerva/commit/179e8d35eec6b92cb5796d8d0f7155e51e02657f)), closes [#8](https://github.com/PMDevSolutions/Nerva/issues/8)
* add .dev.vars.example to Cloudflare Workers project setup ([5bc6243](https://github.com/PMDevSolutions/Nerva/commit/5bc62439a8b6c0ec5ccd5a0c66790c01936dacdc))
* add Architecture Decision Records (ADRs) template and initial decisions ([500cab9](https://github.com/PMDevSolutions/Nerva/commit/500cab98fb40ec18c88fea336955eb53cab32447))
* add automatic PR labeling workflow ([82d7252](https://github.com/PMDevSolutions/Nerva/commit/82d7252e489eb1a00b302d7e069b18f0bf495b63))
* add CI matrix testing for Node.js 20 and 22 ([8130c97](https://github.com/PMDevSolutions/Nerva/commit/8130c97da474c8eb0b7bf15ee80bc1cebfa1c021)), closes [#16](https://github.com/PMDevSolutions/Nerva/issues/16)
* add CodeQL security scanning workflow ([1b36254](https://github.com/PMDevSolutions/Nerva/commit/1b36254208d113f3dae1f80613b977bd7a97af2b))
* add Dependabot configuration for automated dependency updates ([15e4197](https://github.com/PMDevSolutions/Nerva/commit/15e4197324a1a7a952915f1cea15dc289107bb66))
* add devcontainer Dockerfile with Node 22 and corepack ([f6e7b3d](https://github.com/PMDevSolutions/Nerva/commit/f6e7b3d8dddd38b4a749d7a54f8a56db6f4bfcf2))
* add devcontainer.json with extensions, ports, and pnpm setup ([f46c35b](https://github.com/PMDevSolutions/Nerva/commit/f46c35b42032d7dc64e243fb5005fa2073a4710c))
* add ETag middleware to Cloudflare Workers and Node.js templates ([d863aed](https://github.com/PMDevSolutions/Nerva/commit/d863aed61fa862328a995aa5cbe92dd6ddff348b))
* add graceful shutdown handling to Node.js template ([d8da351](https://github.com/PMDevSolutions/Nerva/commit/d8da3518b861040d61498268c5cd480be353d50a))
* add markdown link validation to CI workflow ([d8a791f](https://github.com/PMDevSolutions/Nerva/commit/d8a791fbdb3b1a3ba1aaf1e84c1411f633ddc349))
* add request ID middleware to generated project templates ([a9751e5](https://github.com/PMDevSolutions/Nerva/commit/a9751e5619a1e87859b984b3cc8feabd071107f1))
* add response compression middleware to Node.js project template ([a81de16](https://github.com/PMDevSolutions/Nerva/commit/a81de161b9953f7ce628f612aed62b90c1750b7c))
* add ShellCheck linting to CI workflow ([f572b60](https://github.com/PMDevSolutions/Nerva/commit/f572b60423c60c6c906d5b9fb4d09c19d8ff7f2c)), closes [#3](https://github.com/PMDevSolutions/Nerva/issues/3)
* add stale issue and PR management workflow ([449502b](https://github.com/PMDevSolutions/Nerva/commit/449502bcb2a825f5d613de8fae6b264db72ec91d))
* add Todo API example project for Cloudflare Workers ([c28647a](https://github.com/PMDevSolutions/Nerva/commit/c28647af2b35819664251893635a952170bade87)), closes [#18](https://github.com/PMDevSolutions/Nerva/issues/18)
* add VS Code workspace recommendations and shared settings ([b7996df](https://github.com/PMDevSolutions/Nerva/commit/b7996df1fdf9a3fb7064db3fa6cd96d7a0200b02))
* **ci:** scaffold for type-checking embedded templates ([ee56c3e](https://github.com/PMDevSolutions/Nerva/commit/ee56c3edb88d79a28ca160f9d55dcb763d06656c))
* **example:** wire dependency-checking /health into todo-api-cloudflare ([a0e034e](https://github.com/PMDevSolutions/Nerva/commit/a0e034e53c4dea7c619675a6915dfa95e78f93a7))
* **template:** add pingDatabase helper for health checks ([83a1cea](https://github.com/PMDevSolutions/Nerva/commit/83a1ceaf53683170b7377278e99d1a93651d2b8f))
* **template:** replace static /health with dependency-checking handler ([e9947e1](https://github.com/PMDevSolutions/Nerva/commit/e9947e1ad9920a8285bcd06c139100de9a4a337f))
* **templates:** add typed env config utility ([#60](https://github.com/PMDevSolutions/Nerva/issues/60)) ([1a57b7a](https://github.com/PMDevSolutions/Nerva/commit/1a57b7abcca0c9126136a84e8cb8c4fce9bf70b1))


### Bug Fixes

* correct typo includeSchemaDigram → includeSchemaDiagram ([74d4c18](https://github.com/PMDevSolutions/Nerva/commit/74d4c18916c9914ccb3cd8c49ef086d13cb248ba)), closes [#1](https://github.com/PMDevSolutions/Nerva/issues/1)
* exclude all contributor-covenant.org URLs from link checker ([a997645](https://github.com/PMDevSolutions/Nerva/commit/a9976452726cc6c270f021353c59470607b83195))
* explicitly pass lychee config path in CI workflow ([0d8dc08](https://github.com/PMDevSolutions/Nerva/commit/0d8dc08cdb5dcb72e5ed0637d5066485d5c2c98f))
* remove placeholder link in ADR template that breaks lychee ([674ab77](https://github.com/PMDevSolutions/Nerva/commit/674ab77dcccbe34ec2f362bf734678be7dffc6c2))
* use correct null check for X-Request-Id header assertion ([7bf6574](https://github.com/PMDevSolutions/Nerva/commit/7bf65744e41ff467eeb3aa8c262e8b19090dc90e))


### Refactoring

* **setup:** replace TS heredocs with copy_file from templates/snippets/ ([c67caca](https://github.com/PMDevSolutions/Nerva/commit/c67caca0c969739dc37fe44987b3ac6dd804b198))
* **template:** extract shared postgres client for Node template ([a24b937](https://github.com/PMDevSolutions/Nerva/commit/a24b937348e09ba33ae1a9b67a7aed1a564f2396)), closes [#54](https://github.com/PMDevSolutions/Nerva/issues/54)

## [0.5.0] - 2026-04-07

### Features

- 24 custom Claude Code agents for backend architecture, database design, testing, security, deployment, and operations
- 12 development skills including schema-to-API pipeline, TDD, authentication, validation, and documentation
- 10-phase autonomous OpenAPI-to-working-API pipeline with enforced TDD gates
- Conversational API builder (`/build-from-conversation`) with structured interview
- Aurelius frontend-to-backend pipeline (`/build-from-aurelius`) for full-stack workflows
- Hono HTTP framework with typed routes, middleware composition, and context typing
- Drizzle ORM schema-first database design with relations, indexes, and migrations
- Dual deployment targets: Cloudflare Workers (edge) and Node.js (Docker)
- Zod request/response validation with type inference
- JWT, OAuth2, and API key authentication patterns
- Contract testing against OpenAPI specification
- k6 load testing script generation
- 9 automation scripts (setup, test, types, security, migration, seed, load test, docs, client generation)
- Starter templates for Cloudflare Workers (wrangler.toml), Node.js (Dockerfile + docker-compose), and shared configs (ESLint, Prettier, TypeScript, Vitest)
- Typed API client generation for Aurelius frontend consumption
- Pipeline configuration with quality gates (80% coverage, TypeScript strict, security audit)
- MIT license, contributing guide, security policy, and code of conduct
