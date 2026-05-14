# Type-check embedded templates in CI — design & implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Issue:** #57
**Goal:** Catch TypeScript regressions in `setup-project.sh`'s embedded TS *during development* rather than after users run the script. Extract the 11 `write_file ... << 'EOF'` heredoc bodies into real `.ts` files, have `setup-project.sh` `cp` them at runtime, and run `tsc --noEmit` on them in CI for both Workers and Node target shapes.

---

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Source of truth | Real `.ts` files in `templates/snippets/`; `setup-project.sh` `cp`s them | Zero drift possible — one copy. Free editor LSP + formatting. Shorter shell script |
| Scope | All 11 embedded TS heredocs (Workers + Node + shared) | One CI job catches regressions across `index.ts`, `routes/health.ts`, `db/ping.ts`, etc. — not just `db/schema.ts` |
| Test file typecheck | Skipped (out of scope) | `tests/unit/health.test.ts` needs `vitest` types + globals — added complexity. Test *correctness* is already verified by running them on generated projects |
| CI integration | New dedicated `typecheck-templates` job, single Node version | One typecheck pass is enough; no value running it twice in the existing 20/22 matrix |
| Dep-version sync | Cross-reference comment in `setup-project.sh` near `pnpm add` lines | Two places (script's `pnpm add` and the typecheck scaffold's `package.json`) must agree. Drift is caught the next time anyone touches either |
| `tests/unit/health.test.ts` location | Out of scope for typecheck, but its **runtime correctness** is already covered | The health PR's smoke test runs these on generated projects |

---

## File layout (deltas)

```
templates/
├── shared/                          # EXISTING — configs (eslint, prettier, tsconfig, vitest)
├── cloudflare-workers/              # EXISTING — wrangler.toml
├── node-server/                     # EXISTING — Dockerfile, docker-compose.yml
├── docker/                          # EXISTING
└── snippets/                        # NEW — runtime TS extracted from setup-project.sh
    ├── shared/
    │   ├── src/db/schema.ts
    │   ├── src/db/client.ts
    │   ├── src/db/seed.ts
    │   └── tests/setup.ts
    ├── cloudflare/
    │   ├── src/index.ts
    │   ├── src/db/ping.ts
    │   ├── src/routes/health.ts
    │   └── tests/unit/health.test.ts
    └── node/
        ├── src/index.ts
        ├── src/db/ping.ts
        ├── src/routes/health.ts
        └── tests/unit/health.test.ts

tests/typecheck-templates/           # NEW — CI typecheck scaffold
├── package.json                     # only deps needed to typecheck (drizzle-orm, hono, postgres, zod, @hono/zod-validator, @cloudflare/workers-types, @types/node, typescript)
├── pnpm-lock.yaml                   # generated
├── tsconfig.cloudflare.json         # extends ../../templates/shared/tsconfig.json, types: ["@cloudflare/workers-types"]
└── tsconfig.node.json               # extends ../../templates/shared/tsconfig.json, types: ["node"]
```

`setup-project.sh`: 11 heredocs replaced with `copy_file` calls. Estimated ~250 lines removed.

---

## tsconfig shapes

**`tests/typecheck-templates/tsconfig.cloudflare.json`:**
```json
{
  "extends": "../../templates/shared/tsconfig.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"],
    "moduleResolution": "bundler",
    "noEmit": true,
    "rootDir": "../../templates/snippets"
  },
  "include": [
    "../../templates/snippets/shared/src/**/*.ts",
    "../../templates/snippets/cloudflare/src/**/*.ts"
  ]
}
```

**`tsconfig.node.json`:** same shape with `"types": ["node"]` and `node/` included.

Both **exclude** `tests/**/*.ts` from the snippet trees — vitest tests are out of scope for this PR.

---

## CI job

Added to `.github/workflows/ci.yml`:

```yaml
typecheck-templates:
  name: Type-check Embedded Templates
  runs-on: ubuntu-latest
  timeout-minutes: 3
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22 }
    - run: corepack enable
    - run: pnpm install --frozen-lockfile
      working-directory: tests/typecheck-templates
    - run: pnpm exec tsc --noEmit -p tsconfig.cloudflare.json
      working-directory: tests/typecheck-templates
    - run: pnpm exec tsc --noEmit -p tsconfig.node.json
      working-directory: tests/typecheck-templates
```

---

## Task 1: Extract heredocs to `templates/snippets/`

**Files created (11):**

| Snippet file | Source heredoc in setup-project.sh |
|---|---|
| `templates/snippets/shared/src/db/schema.ts` | line ~286 (`SEOF`) |
| `templates/snippets/shared/src/db/client.ts` | line ~298 (`CEOF`) |
| `templates/snippets/shared/src/db/seed.ts` | line ~312 (`SEEDEOF`) |
| `templates/snippets/shared/tests/setup.ts` | line ~439 (`TSEOF`) |
| `templates/snippets/cloudflare/src/index.ts` | line ~171 (`SRCEOF`, cloudflare branch) |
| `templates/snippets/cloudflare/src/db/ping.ts` | line ~333 (`PEOF`, cloudflare branch) |
| `templates/snippets/cloudflare/src/routes/health.ts` | line ~355 (`HEOF`, cloudflare branch) |
| `templates/snippets/cloudflare/tests/unit/health.test.ts` | line ~452 (`HTEOF`, cloudflare branch) |
| `templates/snippets/node/src/index.ts` | line ~209 (`SRCEOF`, node branch) |
| `templates/snippets/node/src/db/ping.ts` | line ~393 (`PEOF`, node branch) |
| `templates/snippets/node/src/routes/health.ts` | line ~406 (`HEOF`, node branch) |
| `templates/snippets/node/tests/unit/health.test.ts` | line ~558 (`HTEOF`, node branch) |

Content extracted **verbatim** — no rewrites. No changes to `setup-project.sh` yet.

**Verify:** `git diff` shows only new files; `bash -n scripts/setup-project.sh` still passes.

**Commit:** `chore(template): extract embedded TS heredocs to templates/snippets/`

---

## Task 2: Add `tests/typecheck-templates/` scaffold

**Files created:**
- `tests/typecheck-templates/package.json` — `typescript`, `drizzle-orm`, `hono`, `postgres`, `zod`, `@hono/zod-validator`, `@cloudflare/workers-types`, `@types/node`. Versions match `setup-project.sh` `pnpm add` lines.
- `tests/typecheck-templates/tsconfig.cloudflare.json` (see shape above)
- `tests/typecheck-templates/tsconfig.node.json` (see shape above)

**Run locally:**
```bash
cd tests/typecheck-templates
pnpm install
pnpm exec tsc --noEmit -p tsconfig.cloudflare.json
pnpm exec tsc --noEmit -p tsconfig.node.json
```

**If errors surface, fix them in the snippets** — that's the bug this PR exists to catch. Commit the snippet fixes in this task.

**Verify:** both `tsc` invocations exit 0.

**Commit:** `feat(ci): scaffold for type-checking embedded templates`

---

## Task 3: Refactor `setup-project.sh` to consume snippet files

Replace 11 `write_file ... << 'EOF'` blocks with `copy_file` calls. Pattern:

```bash
# OLD
write_file "$API_DIR/src/db/schema.ts" << 'SEOF'
import { pgTable, ... } from 'drizzle-orm/pg-core';
...
SEOF

# NEW
copy_file "$TEMPLATES_DIR/snippets/shared/src/db/schema.ts" "$API_DIR/src/db/schema.ts"
```

For platform-specific files (`index.ts`, `ping.ts`, `health.ts`, test files), the source path differs by branch:
- Cloudflare branch: `$TEMPLATES_DIR/snippets/cloudflare/...`
- Node branch: `$TEMPLATES_DIR/snippets/node/...`

**Verify:**
- `bash -n scripts/setup-project.sh` passes
- Generate Node project: `bash scripts/setup-project.sh /tmp/x --node` → `cd /tmp/x/api && pnpm test` → 7/7 health tests pass
- Generate Cloudflare project: `bash scripts/setup-project.sh /tmp/y --cloudflare` → `cd /tmp/y/api && pnpm test` → 7/7 health tests pass

**Commit:** `refactor(setup): replace TS heredocs with copy_file from templates/snippets/`

---

## Task 4: Add `typecheck-templates` CI job

Add the YAML block (see "CI job" section above) to `.github/workflows/ci.yml`. Place it alongside the existing `node-compat` and `check-links` jobs.

**Verify:**
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` — valid YAML
- Existing `validate` job's `Check required files exist` step is unaffected (the new dir isn't required there)

**Commit:** `ci: type-check embedded templates against current dep versions`

---

## Task 5: Cross-reference comment in `setup-project.sh`

Add a comment near each `pnpm add` line:

```bash
# NOTE: keep deps in sync with tests/typecheck-templates/package.json
run_cmd pnpm add hono drizzle-orm postgres zod @hono/zod-validator
```

**Verify:** `bash -n` passes.

**Commit:** `docs(setup): cross-reference typecheck-templates dep versions`

---

## Task 6: Document in CONTRIBUTING.md

Add a short section: "Modifying generated-project templates". Explain that runtime TS lives in `templates/snippets/`; bumping a dep in `setup-project.sh` needs the matching bump in `tests/typecheck-templates/package.json`; the `typecheck-templates` CI job catches type drift against the current Drizzle/Hono APIs.

**Verify:** new section renders cleanly in GitHub's markdown preview (no broken anchors / lychee passes).

**Commit:** `docs(contributing): explain templates/snippets/ + dep version sync`

---

## Task 7: Smoke test full pipeline locally

```bash
rm -rf /tmp/nerva-typecheck-node /tmp/nerva-typecheck-cf
bash scripts/setup-project.sh /tmp/nerva-typecheck-node --node
bash scripts/setup-project.sh /tmp/nerva-typecheck-cf --cloudflare
(cd /tmp/nerva-typecheck-node/api && pnpm test)   # must show 7/7
(cd /tmp/nerva-typecheck-cf/api && pnpm test)     # must show 7/7

cd tests/typecheck-templates
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit -p tsconfig.cloudflare.json
pnpm exec tsc --noEmit -p tsconfig.node.json
```

All four commands must exit 0.

**No commit** — this is a verification step.

---

## Task 8: Push branch and open PR

**Verify CI:**
- Validate Structure: green
- Node.js 20 / 22 Compatibility: green
- Check Markdown Links: green
- **Type-check Embedded Templates (new): green**

**PR title:** `feat(ci): type-check embedded TS templates`
**Closes #57.**

---

## Out of scope (follow-up issues)

- Type-checking `tests/unit/health.test.ts` snippets — requires `vitest` types + globals; small but added complexity. Test correctness is already covered by running them on generated projects.
- Pre-existing `templates/shared/tsconfig.json` gaps (missing `"types": ["node"]` for Node target, missing `@cloudflare/workers-types` install for Cloudflare target). Surfaces if/when those template tsconfigs get included in the typecheck.
- A pre-commit hook that runs `tsc -p tsconfig.cloudflare.json` locally — `husky` is already installed; could add later.
