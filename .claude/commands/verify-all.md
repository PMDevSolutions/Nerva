---
allowed-tools: Bash, Read
---

# /verify-all — Run All Local Quality Checks

Runs every local quality check in sequence and reports a pass/fail summary. Wraps `./scripts/verify-all.sh` so you do not have to remember each individual script.

## Purpose

One command that answers "is this checkout healthy?" for both the Nerva framework itself (shell/JS syntax, config JSON, pipeline config, documentation counts, script tests) and a generated API project under `api/` (types, tests, security, migration safety).

## Usage

```
/verify-all
/verify-all --skip script-tests,security
/verify-all --include shell-syntax,json,doc-counts
/verify-all --list
```

Optional flags forward to the underlying script:

| Flag | Effect |
|------|--------|
| `--skip <a,b,c>` | Skip the named checks (comma-separated) |
| `--include <a,b>` | Run only the named checks; everything else is marked skipped |
| `--list` | Print the check names in run order and exit |
| `--root <dir>` | Check a different project tree (defaults to the repo root) |
| `--json` | Emit the machine-readable report instead of the summary table |
| `--help` | Full flag documentation |

Unknown flags and unknown check names exit `2`. For machine-readable output and CI-style behavior, use `/ci` instead.

## What runs

The orchestrator runs these checks in order. Each is independent — a failure in one does not stop the others. Checks whose backing script or subject is absent are **skipped with a reason**, never failed, so the command is safe on a bare framework checkout.

| # | Check | Backing command | What it does | Skipped when |
|---|-------|-----------------|--------------|--------------|
| 1 | `shell-syntax` | `bash -n` | Parses `scripts/*.sh`, `scripts/lib/*.sh`, `.claude/hooks/*.sh` | no shell scripts found |
| 2 | `js-syntax` | `node --check` | Parses `scripts/*.js`, `scripts/lib/*.js` | no JS files / no node |
| 3 | `json` | `JSON.parse` | Parses `.claude/pipeline.config.json`, `.claude/settings.json` (if present), `package.json` | no JSON files / no node |
| 4 | `pipeline-config` | `node scripts/validate-pipeline-config.js` | Validates `pipeline.config.json` against its schema | script not found |
| 5 | `doc-counts` | `scripts/check-doc-counts.sh` | Agent/skill/script/command counts in docs vs disk | script not found |
| 6 | `script-tests` | `pnpm test` | Vitest suite for `scripts/` (slow) | no `package.json` / no `test` script / no pnpm |
| 7 | `types` | `scripts/check-types.sh` | `tsc --noEmit` on the API | no `api/` directory |
| 8 | `tests` | `scripts/run-tests.sh` | Vitest with coverage on the API | no `api/` directory |
| 9 | `security` | `scripts/security-scan.sh` | Dependency audit + anti-pattern scan | no `api/` directory |
| 10 | `destructive-migrations` | `node scripts/check-destructive-migrations.js` | Flags DROP/TRUNCATE/etc. in migrations | no `api/src/db/migrations` |

`api/` is resolved via `NERVA_API_DIR` when set, otherwise `<root>/api`.

## Steps

### 1. Run the orchestrator

```bash
./scripts/verify-all.sh $ARGUMENTS
```

The script prints per-check progress and a summary table at the end:

```
=== verify-all ===

▸ shell-syntax …
  ✓ pass (144ms)
▸ js-syntax …
  ✓ pass (314ms)
▸ doc-counts …
  ✗ fail (exit 1, 1466ms)
    --- last 15 lines of output ---
    |     <file>:<line>: claims <N> scripts, actual <M> -> "<matched text>"
    ---

=== Summary ===
Check                    Status Duration   Reason
-----                    ------ --------   ------
shell-syntax             pass   144ms
js-syntax                pass   314ms
json                     pass   221ms
pipeline-config          pass   180ms
doc-counts               fail   1466ms     exit 1
script-tests             pass   8120ms
types                    skip   0ms        no api/ directory
tests                    skip   0ms        no api/ directory
security                 skip   0ms        no api/ directory
destructive-migrations   skip   0ms        no migrations directory at api/src/db/migrations

Totals: 5 passed, 1 failed, 4 skipped

✗ Some checks failed. Re-run each failing check individually for full output:
  bash scripts/check-doc-counts.sh
```

### 2. If any check fails

The last 15 lines of the failing check's output are shown inline, and the summary lists the exact command to reproduce each failure with full output. Re-run that one script to see the underlying errors:

```bash
bash scripts/check-doc-counts.sh
```

Once the failing check is fixed, re-run `/verify-all` to confirm.

### 3. Skipping the slow check during iteration

`script-tests` runs the whole Vitest suite for `scripts/`. While iterating on something else:

```bash
./scripts/verify-all.sh --skip script-tests
```

## Or use the package scripts

```bash
pnpm verify        # same as ./scripts/verify-all.sh
pnpm verify:ci     # same as ./scripts/verify-all.sh --ci
```

## Exit codes

- `0` — every check passed (or was skipped)
- `1` — one or more checks failed
- `2` — usage error (unknown flag or check name)

## Common Issues

- **`doc-counts` fails after adding a script/agent/skill/command**: update the counts in `CLAUDE.md`, `README.md`, and any other doc it lists (it prints `file:line`, the claimed number, and the actual number).
- **Everything under `types`/`tests`/`security` is skipped**: there is no `api/` directory yet. Run `./scripts/setup-project.sh` or set `NERVA_API_DIR`.
- **`script-tests` is skipped with "nested verify-all run"**: the orchestrator was invoked from within `pnpm test`; this is the recursion guard, not an error.

## Related

- `/ci` — same checks, JSON output, non-interactive (for automation / CI)
- `/lint` — lint and format only
- `/test` — API tests only
