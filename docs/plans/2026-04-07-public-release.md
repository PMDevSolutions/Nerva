# Nerva Public FOSS Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare Nerva for public release on GitHub as a well-documented FOSS project, matching the administrative structure of its sibling projects (Aurelius, Claudius, Flavian).

**Architecture:** Create all missing community/governance files, GitHub infrastructure (issue templates, PR template, workflows, funding), release tooling (conventional commits, changelog, versioning), onboarding documentation, and an enhanced README. All files adapted from Aurelius templates with Nerva-specific content.

**Tech Stack:** GitHub Actions, pnpm, commit-and-tag-version, commitlint, husky, Vitest, ESLint, Prettier

---

## Pre-Flight: Current State

**What Nerva has:**
- README.md (good content, placeholder repo URL)
- LICENSE (MIT, Copyright 2026 PMDS)
- CLAUDE.md (comprehensive)
- .gitignore (comprehensive)
- 9 scripts, 4 template dirs, 2 docs sections
- .claude/ with 24 agents, 12 skills, 5 commands, pipeline.config.json

**What Nerva is missing (all files below must be created):**
- CONTRIBUTING.md
- CODE_OF_CONDUCT.md
- SECURITY.md
- CHANGELOG.md
- .editorconfig
- .gitattributes
- .versionrc.json
- commitlint.config.js
- package.json (root)
- .github/FUNDING.yml
- .github/pull_request_template.md
- .github/ISSUE_TEMPLATE/config.yml
- .github/ISSUE_TEMPLATE/bug_report.yml
- .github/ISSUE_TEMPLATE/feature_request.yml
- .github/ISSUE_TEMPLATE/pipeline_issue.yml
- .github/workflows/ci.yml
- .github/workflows/release.yml
- docs/onboarding/README.md
- docs/onboarding/quickstart.md
- docs/onboarding/architecture.md
- docs/onboarding/troubleshooting.md
- docs/community/patreon-voting.md

**What Nerva needs updated:**
- README.md (repo URL, prerequisites, badges, links to new files)
- LICENSE (copyright holder: PMDevSolutions to match other projects)

---

## Task 1: Root package.json

**Files:**
- Create: `package.json`

**Step 1: Create root package.json**

```json
{
  "name": "nerva",
  "version": "0.5.0",
  "description": "Claude Code-integrated API & backend development framework with TypeScript, Hono, Drizzle ORM, and automated schema-to-API pipelines",
  "private": true,
  "type": "module",
  "scripts": {
    "release": "commit-and-tag-version",
    "release:minor": "commit-and-tag-version --release-as minor",
    "release:major": "commit-and-tag-version --release-as major",
    "release:patch": "commit-and-tag-version --release-as patch",
    "release:dry": "commit-and-tag-version --dry-run",
    "release:first": "commit-and-tag-version --first-release",
    "setup": "bash scripts/setup-project.sh",
    "prepare": "husky"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/PMDevSolutions/Nerva.git"
  },
  "keywords": [
    "claude-code",
    "api",
    "backend",
    "hono",
    "drizzle-orm",
    "typescript",
    "openapi",
    "schema-first",
    "tdd",
    "cloudflare-workers"
  ],
  "author": "PAMulligan",
  "license": "MIT",
  "devDependencies": {
    "@commitlint/cli": "^20.5.0",
    "@commitlint/config-conventional": "^20.5.0",
    "commit-and-tag-version": "^12.7.1",
    "husky": "^9.1.7"
  }
}
```

**Step 2: Install dependencies**

Run: `pnpm install`
Expected: `pnpm-lock.yaml` created, node_modules/ populated

**Step 3: Initialize Husky**

Run: `pnpm exec husky init`
Expected: `.husky/` directory created with `pre-commit` hook

**Step 4: Configure the pre-commit hook**

Write `.husky/pre-commit`:
```bash
#!/usr/bin/env sh

# Validate shell script syntax
for f in scripts/*.sh; do
  if [ -f "$f" ]; then
    bash -n "$f" || exit 1
  fi
done

# Validate JSON configs
for f in .claude/pipeline.config.json package.json; do
  if [ -f "$f" ]; then
    node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || exit 1
  fi
done
```

**Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml .husky/
git commit -m "chore: add root package.json with release tooling and husky hooks"
```

---

## Task 2: Commit Tooling (.versionrc.json, commitlint.config.js)

**Files:**
- Create: `.versionrc.json`
- Create: `commitlint.config.js`

**Step 1: Create .versionrc.json**

```json
{
  "header": "# Changelog\n\nAll notable changes to the Nerva framework will be documented in this file.\n\nThis changelog is automatically generated from [Conventional Commits](https://www.conventionalcommits.org/).\n",
  "types": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance" },
    { "type": "refactor", "section": "Refactoring" },
    { "type": "docs", "section": "Documentation", "hidden": true },
    { "type": "chore", "hidden": true },
    { "type": "style", "hidden": true },
    { "type": "test", "hidden": true },
    { "type": "build", "hidden": true },
    { "type": "ci", "hidden": true }
  ],
  "commitUrlFormat": "{{host}}/{{owner}}/{{repository}}/commit/{{hash}}",
  "compareUrlFormat": "{{host}}/{{owner}}/{{repository}}/compare/{{previousTag}}...{{currentTag}}",
  "tagPrefix": "v"
}
```

**Step 2: Create commitlint.config.js**

```javascript
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "chore",
        "revert",
      ],
    ],
    "subject-case": [2, "never", ["start-case", "pascal-case", "upper-case"]],
    "header-max-length": [2, "always", 100],
  },
};
```

**Step 3: Add commitlint hook to Husky**

Write `.husky/commit-msg`:
```bash
#!/usr/bin/env sh
npx --no -- commitlint --edit ${1}
```

**Step 4: Commit**

```bash
git add .versionrc.json commitlint.config.js .husky/commit-msg
git commit -m "chore: add conventional commit tooling (commitlint, versionrc)"
```

---

## Task 3: Editor Config & Git Attributes

**Files:**
- Create: `.editorconfig`
- Create: `.gitattributes`

**Step 1: Create .editorconfig**

```ini
# EditorConfig - API/TypeScript Conventions
# https://editorconfig.org

root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

# TypeScript & JavaScript
[*.{ts,tsx,js,jsx,mjs,cjs}]
indent_style = space
indent_size = 2

# JSON files
[*.json]
indent_style = space
indent_size = 2

# YAML files
[*.{yml,yaml}]
indent_style = space
indent_size = 2

# TOML files (Wrangler config)
[*.toml]
indent_style = space
indent_size = 2

# Markdown files
[*.md]
trim_trailing_whitespace = false

# Shell scripts
[*.sh]
indent_style = space
indent_size = 2

# SQL files
[*.sql]
indent_style = space
indent_size = 2

# Docker
[Dockerfile]
indent_style = space
indent_size = 2

# Makefiles require tabs
[Makefile]
indent_style = tab
```

**Step 2: Create .gitattributes**

```
# Language statistics overrides for GitHub Linguist
# Mark pipeline/build scripts as generated so TypeScript
# shows as the primary language instead of Shell

scripts/**/*.sh linguist-generated=true
scripts/**/*.bash linguist-generated=true
templates/**/*.sh linguist-generated=true
templates/**/*.tpl linguist-generated=true
*.sh linguist-generated=true

# Lock files are vendored
pnpm-lock.yaml linguist-generated=true

# SQL migrations are generated
api/src/db/migrations/**/*.sql linguist-generated=true
```

**Step 3: Commit**

```bash
git add .editorconfig .gitattributes
git commit -m "chore: add editorconfig and gitattributes for consistent formatting"
```

---

## Task 4: Community Governance Files

**Files:**
- Create: `CODE_OF_CONDUCT.md`
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`

**Step 1: Create CODE_OF_CONDUCT.md**

Use the Contributor Covenant v2.1 (identical to Aurelius). Contact email: **paul@pmds.info**. Copy verbatim from Aurelius — this is a standardized document across all PMDS projects.

**Step 2: Create SECURITY.md**

Adapt from Aurelius with Nerva-specific scope:

- **In Scope:** Framework source code, scripts (`scripts/`), templates (`templates/`), agent definitions (`.claude/agents/`), pipeline configuration and skill definitions
- **Out of Scope:** Third-party dependencies, physical access, social engineering
- **Contact:** paul@pmds.info
- **Response timeline:** 48h acknowledgment, 7d initial assessment
- **Maintained by:** [PMDevSolutions](https://github.com/PMDevSolutions)

**Step 3: Create CONTRIBUTING.md**

Adapt from Aurelius with these Nerva-specific changes:

- **Title:** "Contributing to Nerva"
- **Description:** Named after Marcus Cocceius Nerva — the Roman Emperor known for pragmatic governance and building stable foundations — this project brings those same qualities to API development.
- **Getting started:** Fork, clone, `pnpm install`
- **Development scripts table:** Reference Nerva's 9 scripts:
  - `./scripts/run-tests.sh` — Run Vitest test suite with coverage
  - `./scripts/check-types.sh` — TypeScript type checking (strict mode)
  - `./scripts/security-scan.sh` — Security audit for dependency vulnerabilities
- **Branch naming:** Same conventions (feat/, fix/, docs/, chore/)
- **PR process:** Same 8-step process, reference Nerva scripts
- **Conventional commits:** Same format
- **Claude Code Agents section:** 24 specialized agents and 12 skills. Link to `.claude/CUSTOM-AGENTS-GUIDE.md` and `.claude/skills/` directory
- **Roadmap:** GitHub project board, Discussions link
- **Code of Conduct:** Reference CODE_OF_CONDUCT.md
- **Discussion link:** `https://github.com/PMDevSolutions/Nerva/discussions`

**Step 4: Commit**

```bash
git add CODE_OF_CONDUCT.md SECURITY.md CONTRIBUTING.md
git commit -m "docs: add code of conduct, security policy, and contributing guide"
```

---

## Task 5: CHANGELOG.md (Initial Release)

**Files:**
- Create: `CHANGELOG.md`

**Step 1: Create CHANGELOG.md**

```markdown
# Changelog

All notable changes to the Nerva framework will be documented in this file.

This changelog is automatically generated from [Conventional Commits](https://www.conventionalcommits.org/).

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
```

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add changelog for v0.5.0 initial release"
```

---

## Task 6: GitHub Issue Templates

**Files:**
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/pipeline_issue.yml`

**Step 1: Create config.yml**

```yaml
blank_issues_enabled: false
contact_links:
  - name: Questions & Discussions
    url: https://github.com/PMDevSolutions/Nerva/discussions
    about: Ask questions and discuss ideas in GitHub Discussions

  - name: Documentation
    url: https://github.com/PMDevSolutions/Nerva/tree/main/docs
    about: Check the documentation before opening an issue

  - name: Security Vulnerabilities
    url: https://github.com/PMDevSolutions/Nerva/security/advisories/new
    about: Report security vulnerabilities privately via GitHub Security Advisories
```

**Step 2: Create bug_report.yml**

Adapt from Aurelius with Nerva-specific component dropdown:
- Agents (Custom Claude Code agents)
- Skills (Slash command skills)
- Scripts (Development automation scripts)
- Pipeline - Schema-to-API (/build-from-schema)
- Pipeline - Conversational (/build-from-conversation)
- Pipeline - Aurelius (/build-from-aurelius)
- Templates (Starter configs)
- Database (Drizzle ORM, migrations)
- Authentication & Security
- Documentation
- Other

Same fields: severity dropdown, description, steps-to-reproduce, expected/actual behavior, error logs, OS, Node version, pnpm version, Claude Code version, screenshots, pre-submission checklist.

**Step 3: Create feature_request.yml**

Adapt from Aurelius with same Nerva component dropdown as bug_report. Same fields: feature type, target component, description, use case, proposed solution, alternatives, scope estimate, acceptance criteria, contribution interest, pre-submission checklist.

**Step 4: Create pipeline_issue.yml**

Nerva-specific pipeline issue template:

- **Pipeline type dropdown:**
  - Schema-to-API (/build-from-schema)
  - Conversational (/build-from-conversation)
  - Aurelius-to-API (/build-from-aurelius)

- **Pipeline phase dropdown:**
  - "Phase 0: Schema Intake (parse OpenAPI spec)"
  - "Phase 1: Database Design (Drizzle schema generation)"
  - "Phase 2: TDD Gate (failing integration tests)"
  - "Phase 3: Route Generation (Hono handlers)"
  - "Phase 4: Auth & Middleware (JWT, CORS, rate limiting)"
  - "Phase 5: API Testing (integration + contract + load)"
  - "Phase 6: Documentation (OpenAPI docs, Postman)"
  - "Phase 7: Quality Gate (types + coverage + security)"
  - "Phase 8: Deployment Config (Docker, Wrangler, CI/CD)"
  - "Phase 9: Report (build report)"
  - "Unknown / Multiple Phases"

- **Deployment target dropdown:**
  - Cloudflare Workers
  - Node.js (Docker)
  - Both

- Same fields as Aurelius pipeline_issue: description, steps-to-reproduce, expected/actual behavior, build-spec.json textarea, error logs, OS, Node version, Claude Code version, screenshots, pre-submission checklist.

**Step 5: Commit**

```bash
git add .github/ISSUE_TEMPLATE/
git commit -m "chore: add GitHub issue templates (bug, feature, pipeline)"
```

---

## Task 7: GitHub PR Template & Funding

**Files:**
- Create: `.github/pull_request_template.md`
- Create: `.github/FUNDING.yml`

**Step 1: Create PR template**

```markdown
## Description

<!-- Describe your changes in detail -->

## Related Issue

<!-- Link to the issue this PR addresses, e.g. Closes #123 -->

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Documentation update
- [ ] Chore (dependency updates, CI changes, refactoring)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)

## Checklist

- [ ] Tests pass (`./scripts/run-tests.sh`)
- [ ] Types check (`./scripts/check-types.sh`)
- [ ] Security scan passes (`./scripts/security-scan.sh`)
- [ ] Documentation updated (if applicable)
```

**Step 2: Create FUNDING.yml**

```yaml
patreon: PaulMakesThings
```

**Step 3: Commit**

```bash
git add .github/pull_request_template.md .github/FUNDING.yml
git commit -m "chore: add PR template and Patreon funding link"
```

---

## Task 8: GitHub Actions — CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create CI workflow**

Adapt from Aurelius CI with Nerva-specific validation:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  validate:
    name: Validate Structure
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: actions/checkout@v4

      - name: Check shell script syntax
        run: |
          errors=0
          for f in scripts/*.sh; do
            if [ -f "$f" ]; then
              bash -n "$f" || { echo "FAIL: $f"; errors=$((errors + 1)); }
            fi
          done
          echo "Checked $(ls scripts/*.sh 2>/dev/null | wc -l) scripts, $errors failed"
          exit $errors

      - name: Validate JSON configs
        run: |
          errors=0
          for f in .claude/pipeline.config.json package.json; do
            if [ -f "$f" ]; then
              python3 -m json.tool "$f" > /dev/null || { echo "FAIL: $f"; errors=$((errors + 1)); }
            fi
          done
          for f in templates/**/*.json; do
            if [ -f "$f" ]; then
              python3 -m json.tool "$f" > /dev/null || { echo "FAIL: $f"; errors=$((errors + 1)); }
            fi
          done
          echo "$errors JSON validation failures"
          exit $errors

      - name: Validate pipeline.config.json structure
        run: |
          required_keys='["tdd","database","auth","testing","qualityGate","deployment","security","api"]'
          python3 -c "
          import json, sys
          with open('.claude/pipeline.config.json') as f:
              config = json.load(f)
          required = json.loads('$required_keys')
          missing = [k for k in required if k not in config]
          if missing:
              print(f'Missing required keys: {missing}')
              sys.exit(1)
          print(f'All {len(required)} required keys present')
          "

      - name: Check required files exist
        run: |
          exit_code=0
          required_files=(
            "CLAUDE.md"
            "package.json"
            "CONTRIBUTING.md"
            "CODE_OF_CONDUCT.md"
            "SECURITY.md"
            "LICENSE"
            ".claude/pipeline.config.json"
            "scripts/setup-project.sh"
            "scripts/run-tests.sh"
            "scripts/check-types.sh"
            "scripts/security-scan.sh"
            "scripts/generate-migration.sh"
          )
          for f in "${required_files[@]}"; do
            if [ -f "$f" ]; then
              echo "  $f: OK"
            else
              echo "  $f: MISSING"
              exit_code=1
            fi
          done
          exit $exit_code

      - name: Validate agent frontmatter
        run: |
          errors=0
          count=0
          for f in .claude/agents/*.md; do
            [ -f "$f" ] || continue
            count=$((count + 1))
            frontmatter=$(sed -n '/^---$/,/^---$/p' "$f" | sed '1d;$d')
            if [ -z "$frontmatter" ]; then
              echo "FAIL: $f — no YAML frontmatter found"
              errors=$((errors + 1))
              continue
            fi
            for field in name description; do
              if ! echo "$frontmatter" | grep -qE "^${field}:"; then
                echo "FAIL: $f — missing required field: $field"
                errors=$((errors + 1))
              fi
            done
          done
          echo "Checked $count agents, $errors failures"
          exit $errors

      - name: Validate skill structure
        run: |
          errors=0
          count=0
          for dir in .claude/skills/*/; do
            [ -d "$dir" ] || continue
            count=$((count + 1))
            skill_file="${dir}SKILL.md"
            if [ ! -f "$skill_file" ]; then
              echo "FAIL: $dir — missing SKILL.md"
              errors=$((errors + 1))
              continue
            fi
            frontmatter=$(sed -n '/^---$/,/^---$/p' "$skill_file" | sed '1d;$d')
            if [ -z "$frontmatter" ]; then
              echo "FAIL: $skill_file — no frontmatter found"
              errors=$((errors + 1))
              continue
            fi
            for field in name description; do
              if ! echo "$frontmatter" | grep -qE "^${field}:"; then
                echo "FAIL: $skill_file — missing required field: $field"
                errors=$((errors + 1))
              fi
            done
          done
          echo "Checked $count skills, $errors failures"
          exit $errors

      - name: Validate templates
        run: |
          errors=0
          for f in templates/**/*.json; do
            if [ -f "$f" ]; then
              python3 -m json.tool "$f" > /dev/null 2>&1 || {
                echo "FAIL: $f — invalid JSON"
                errors=$((errors + 1))
              }
            fi
          done
          for dir in templates/shared templates/cloudflare-workers templates/node-server templates/docker; do
            if [ -d "$dir" ]; then
              echo "  $dir: OK"
            else
              echo "  $dir: MISSING"
              errors=$((errors + 1))
            fi
          done
          echo "$errors template validation failures"
          exit $errors
```

**Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add structural validation workflow"
```

---

## Task 9: GitHub Actions — Release Workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Step 1: Create release workflow**

Identical to Aurelius release.yml — same manual dispatch with auto/patch/minor/major choice, same version bump, changelog generation, tag push, and GitHub Release creation flow. No Nerva-specific changes needed since it's driven by package.json and .versionrc.json.

**Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow with automated changelog generation"
```

---

## Task 10: Onboarding Documentation

**Files:**
- Create: `docs/onboarding/README.md`
- Create: `docs/onboarding/quickstart.md`
- Create: `docs/onboarding/architecture.md`
- Create: `docs/onboarding/troubleshooting.md`

**Step 1: Create docs/onboarding/README.md (documentation map)**

Structure:
- Welcome section explaining Nerva
- "Start Here" quick links
- Documentation map table:
  | Document | Description |
  | quickstart.md | Get your first API running |
  | architecture.md | System architecture overview |
  | troubleshooting.md | Common issues and fixes |
  | ../schema-to-api/README.md | Pipeline deep dive |
  | ../api-development/README.md | Development standards |
  | ../../.claude/CUSTOM-AGENTS-GUIDE.md | Agent catalog |

**Step 2: Create docs/onboarding/quickstart.md**

Content:
- Prerequisites (Node.js 20+, pnpm 9+, Claude Code, PostgreSQL or Docker)
- Installation (clone, pnpm install)
- Creating your first API project (`./scripts/setup-project.sh my-api --cloudflare`)
- Three paths:
  1. Schema-first: `/build-from-schema openapi-spec.yaml`
  2. From conversation: `/build-from-conversation`
  3. From Aurelius: `/build-from-aurelius build-spec.json`
- Running the dev server
- Running tests
- What's next (link to pipeline guide, API standards)

**Step 3: Create docs/onboarding/architecture.md**

Content:
- High-level architecture (framework that generates APIs, not an API itself)
- Component overview:
  - Claude Code Agents (24): what they are, how they're invoked
  - Skills (12): what they automate, pipeline vs standalone
  - Scripts (9): automation scripts
  - Templates (4): starter configs
  - Pipelines (3): schema-to-API, conversational, Aurelius
- Technology stack: Hono, Drizzle ORM, PostgreSQL, Zod, Vitest, k6
- Deployment targets: Cloudflare Workers vs Node.js
- How Nerva fits with Aurelius (full-stack workflow)
- pipeline.config.json configuration reference

**Step 4: Create docs/onboarding/troubleshooting.md**

Content:
- Common setup issues (pnpm not found, Node version, PostgreSQL connection)
- Pipeline issues (consolidate from docs/schema-to-api/README.md troubleshooting table)
- Database issues (migration failures, connection pooling)
- Deployment issues (Wrangler config, Docker build failures)
- Claude Code issues (agents not loading, skills not found)

**Step 5: Commit**

```bash
git add docs/onboarding/
git commit -m "docs: add onboarding documentation (quickstart, architecture, troubleshooting)"
```

---

## Task 11: Community Documentation (Patreon Voting)

**Files:**
- Create: `docs/community/patreon-voting.md`

**Step 1: Create patreon-voting.md**

Adapt from Aurelius with Nerva-specific links:
- Replace all Aurelius URLs with Nerva URLs (discussions, roadmap category)
- Same tier structure ($5 Supporter/1x, $15 Contributor/2x, $30 Champion/3x)
- Same voting process, proposal template, priority calculation, monthly cycle
- Same transparency and FAQ sections
- Contact: paul@pmds.info

**Step 2: Commit**

```bash
git add docs/community/
git commit -m "docs: add Patreon supporter voting process documentation"
```

---

## Task 12: Update LICENSE Copyright

**Files:**
- Modify: `LICENSE`

**Step 1: Update copyright holder**

Change `Copyright (c) 2026 PMDS` to `Copyright (c) 2026 PMDevSolutions` to match Aurelius and Claudius.

**Step 2: Commit**

```bash
git add LICENSE
git commit -m "docs: update LICENSE copyright holder to PMDevSolutions"
```

---

## Task 13: Rewrite README.md

**Files:**
- Modify: `README.md`

**Step 1: Rewrite README.md**

The README needs a complete rewrite to be public-facing. Structure:

```markdown
# Nerva

A Claude Code-integrated API & backend development framework with TypeScript, Hono, Drizzle ORM, and automated schema-to-API pipelines.

> Named after Marcus Cocceius Nerva — the Roman Emperor known for pragmatic governance and building stable foundations — this framework brings those same qualities to API development.

[![CI](https://github.com/PMDevSolutions/Nerva/actions/workflows/ci.yml/badge.svg)](https://github.com/PMDevSolutions/Nerva/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Patreon](https://img.shields.io/badge/Patreon-Support-orange?logo=patreon)](https://www.patreon.com/PaulMakesThings)

---

## What This Framework Provides

[Keep existing bullet list — it's already good]

## Prerequisites

- **Node.js** 20 or later
- **pnpm** 9 or later (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Claude Code** ([claude.ai/code](https://claude.ai/code)) — agents and skills require Claude Code
- **PostgreSQL** 15+ (or Docker for local development)

## Quick Start

[Keep existing quick start, replace <repository-url> with actual URL]

## Pipelines

### Schema-to-API (Autonomous)
[Keep existing /build-from-schema section]

### From Conversation
[Keep existing section]

### From Aurelius (Full-Stack Workflow)
[Keep existing section, add note about Aurelius being the frontend counterpart]

## Directory Structure
[Keep existing]

## Agents, Skills & Scripts
[Keep existing tables]

## Part of the PMDS Framework Series

Nerva is the backend counterpart in a family of Claude Code-integrated development frameworks:

| Project | Purpose | Repository |
|---------|---------|------------|
| **Aurelius** | Frontend development (React, Vue, Svelte) | [PMDevSolutions/Aurelius](https://github.com/PMDevSolutions/Aurelius) |
| **Nerva** | Backend/API development (Hono, Drizzle, PostgreSQL) | This repository |
| **Claudius** | Embeddable AI chat widget | [PMDevSolutions/Claudius](https://github.com/PMDevSolutions/Claudius) |
| **Flavian** | WordPress development template | [PMDevSolutions/Flavian](https://github.com/PMDevSolutions/Flavian) |

**Full-stack workflow:** Design in Figma → Build frontend with Aurelius → Generate backend with Nerva → Share typed API client

## Documentation

[Keep existing documentation index table, add new onboarding docs]

## Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## Support the Project

Nerva is free and open source. If you find it useful, consider supporting development on [Patreon](https://www.patreon.com/PaulMakesThings). Supporters get voting power on the development roadmap.

See the [Patreon voting process](docs/community/patreon-voting.md) for details.

## Security

To report a vulnerability, please see our [Security Policy](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE) for details.
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for public release with badges, prerequisites, and ecosystem links"
```

---

## Task 14: Clean Up Stray Files

**Files:**
- Remove: `_write_skills.js` (development helper, not part of framework)
- Remove: `dGVzdA==` (binary test artifact)

**Step 1: Verify these files are safe to remove**

- `_write_skills.js` is a skill generation helper — internal dev tool
- `dGVzdA==` is a base64-encoded test file (name decodes to "test")

**Step 2: Remove and commit**

```bash
git rm _write_skills.js dGVzdA==
git commit -m "chore: remove development artifacts from repository root"
```

---

## Task 15: Generate First Release Tag

**Step 1: Run the first release**

```bash
pnpm release:first
```

This creates the v0.5.0 tag and updates CHANGELOG.md with proper formatting.

**Step 2: Verify**

Run: `git tag -l`
Expected: `v0.5.0` appears

Run: `git log --oneline -5`
Expected: Release commit with version bump

---

## Task 16: Final Validation

**Step 1: Run CI checks locally**

```bash
# Shell script syntax
for f in scripts/*.sh; do bash -n "$f"; done

# JSON validation
node -e "JSON.parse(require('fs').readFileSync('.claude/pipeline.config.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"

# Required files
for f in CLAUDE.md package.json CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md LICENSE CHANGELOG.md; do
  [ -f "$f" ] && echo "$f: OK" || echo "$f: MISSING"
done
```

**Step 2: Verify git status is clean**

Run: `git status`
Expected: Clean working tree, all files committed

**Step 3: Verify .gitignore covers sensitive patterns**

Confirm these are in .gitignore:
- `.env` (already present)
- `node_modules/` (already present)
- `.claude/settings.local.json` (check — contains local permissions)

---

## Task 17: Push to GitHub

**Step 1: Create the GitHub repository** (if not already created)

```bash
gh repo create PMDevSolutions/Nerva --public --description "Claude Code-integrated API & backend development framework" --source=.
```

**Step 2: Push all branches and tags**

```bash
git push -u origin main --tags
```

**Step 3: Configure repository settings via GitHub**

Manual steps (or via `gh` CLI):
- Enable Discussions
- Create discussion categories: General, Q&A, Roadmap, Show and Tell
- Add repository topics: `claude-code`, `api`, `backend`, `hono`, `drizzle-orm`, `typescript`, `openapi`, `cloudflare-workers`
- Set "Sponsor" button to show (FUNDING.yml handles this)

**Step 4: Verify**

- Visit `https://github.com/PMDevSolutions/Nerva`
- Confirm README renders correctly with badges
- Confirm issue templates work (click New Issue)
- Confirm Sponsor button appears
- Confirm CI workflow triggers on main push

---

## Summary: File Inventory (22 new files, 2 modified, 2 removed)

### New Files
| # | File | Task |
|---|------|------|
| 1 | `package.json` | Task 1 |
| 2 | `pnpm-lock.yaml` | Task 1 |
| 3 | `.husky/pre-commit` | Task 1 |
| 4 | `.husky/commit-msg` | Task 2 |
| 5 | `.versionrc.json` | Task 2 |
| 6 | `commitlint.config.js` | Task 2 |
| 7 | `.editorconfig` | Task 3 |
| 8 | `.gitattributes` | Task 3 |
| 9 | `CODE_OF_CONDUCT.md` | Task 4 |
| 10 | `SECURITY.md` | Task 4 |
| 11 | `CONTRIBUTING.md` | Task 4 |
| 12 | `CHANGELOG.md` | Task 5 |
| 13 | `.github/ISSUE_TEMPLATE/config.yml` | Task 6 |
| 14 | `.github/ISSUE_TEMPLATE/bug_report.yml` | Task 6 |
| 15 | `.github/ISSUE_TEMPLATE/feature_request.yml` | Task 6 |
| 16 | `.github/ISSUE_TEMPLATE/pipeline_issue.yml` | Task 6 |
| 17 | `.github/pull_request_template.md` | Task 7 |
| 18 | `.github/FUNDING.yml` | Task 7 |
| 19 | `.github/workflows/ci.yml` | Task 8 |
| 20 | `.github/workflows/release.yml` | Task 9 |
| 21 | `docs/onboarding/` (4 files) | Task 10 |
| 22 | `docs/community/patreon-voting.md` | Task 11 |

### Modified Files
| # | File | Task |
|---|------|------|
| 1 | `LICENSE` | Task 12 |
| 2 | `README.md` | Task 13 |

### Removed Files
| # | File | Task |
|---|------|------|
| 1 | `_write_skills.js` | Task 14 |
| 2 | `dGVzdA==` | Task 14 |

### Commits (14 total)
1. `chore: add root package.json with release tooling and husky hooks`
2. `chore: add conventional commit tooling (commitlint, versionrc)`
3. `chore: add editorconfig and gitattributes for consistent formatting`
4. `docs: add code of conduct, security policy, and contributing guide`
5. `docs: add changelog for v0.5.0 initial release`
6. `chore: add GitHub issue templates (bug, feature, pipeline)`
7. `chore: add PR template and Patreon funding link`
8. `ci: add structural validation workflow`
9. `ci: add release workflow with automated changelog generation`
10. `docs: add onboarding documentation (quickstart, architecture, troubleshooting)`
11. `docs: add Patreon supporter voting process documentation`
12. `docs: update LICENSE copyright holder to PMDevSolutions`
13. `docs: rewrite README for public release with badges, prerequisites, and ecosystem links`
14. `chore: remove development artifacts from repository root`
