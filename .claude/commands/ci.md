---
allowed-tools: Bash, Read
---

# /ci — CI-Optimized Verification

Runs the same checks as `/verify-all` but in non-interactive, machine-readable mode. Designed for CI pipelines, pre-merge gates, and automation: no prompts, JSON output, exit code reflects overall pass/fail.

## Usage

```
/ci
/ci --skip script-tests,security
/ci --include shell-syntax,json,pipeline-config,doc-counts
```

The slash command wraps `./scripts/verify-all.sh --ci`. The `--ci` flag implies `--json`, exports `CI=1` and `NO_COLOR=1` to every check, and never reads stdin. Pass `--skip` or `--include` to filter checks; `--root <dir>` points it at another project tree.

## What runs

Same ten checks as `/verify-all`, in the same order:

```
shell-syntax → js-syntax → json → pipeline-config → doc-counts → script-tests
  → types → tests → security → destructive-migrations
```

Checks whose subject is absent skip automatically with a reason: `types`, `tests`, and `security` need an `api/` directory; `destructive-migrations` needs `api/src/db/migrations`; `script-tests` needs a `package.json` with a `test` script and `pnpm` on PATH; any check whose backing script is missing is skipped as `script not found`. Skips never fail the run. No check requires a dev server or a database connection, so all of them run in CI without extra setup.

## Output

JSON written to stdout:

```json
{
  "status": "fail",
  "checks": [
    { "name": "shell-syntax",    "status": "pass", "exitCode": 0, "durationMs": 144 },
    { "name": "js-syntax",       "status": "pass", "exitCode": 0, "durationMs": 314 },
    { "name": "json",            "status": "pass", "exitCode": 0, "durationMs": 221 },
    { "name": "pipeline-config", "status": "pass", "exitCode": 0, "durationMs": 180 },
    { "name": "doc-counts",      "status": "fail", "exitCode": 1, "durationMs": 1466,
      "reason": "exit 1",
      "command": "bash scripts/check-doc-counts.sh",
      "output": "...last 15 lines of the check's output..." },
    { "name": "script-tests",    "status": "pass", "exitCode": 0, "durationMs": 8120 },
    { "name": "types",           "status": "skip", "exitCode": 0, "durationMs": 0, "reason": "no api/ directory" },
    { "name": "tests",           "status": "skip", "exitCode": 0, "durationMs": 0, "reason": "no api/ directory" },
    { "name": "security",        "status": "skip", "exitCode": 0, "durationMs": 0, "reason": "no api/ directory" },
    { "name": "destructive-migrations", "status": "skip", "exitCode": 0, "durationMs": 0,
      "reason": "no migrations directory at api/src/db/migrations" }
  ],
  "summary": { "passed": 5, "failed": 1, "skipped": 4, "total": 10 }
}
```

| Field | Meaning |
|-------|---------|
| `status` | `"pass"` only when every check passed or was skipped; otherwise `"fail"` |
| `checks[].status` | `pass` \| `fail` \| `skip` |
| `checks[].exitCode` | The exit code returned by the underlying check |
| `checks[].durationMs` | Wall-clock duration (0 for skips) |
| `checks[].reason` | Present on `skip` (why) and `fail` (`exit N`); absent on `pass` |
| `checks[].command` | Present on `fail`: the command to reproduce it |
| `checks[].output` | Present on `fail`: last 15 lines of captured output, ANSI-stripped |
| `summary.passed` / `failed` / `skipped` / `total` | Counts across all checks |

## Steps

### 1. Run the orchestrator in CI mode

```bash
./scripts/verify-all.sh --ci $ARGUMENTS
```

### 2. Surface results to the user

Parse the JSON and report the summary in plain text:

```
5 passed, 1 failed, 4 skipped
Failing: doc-counts (exit 1, 1466ms) — bash scripts/check-doc-counts.sh
```

Include the `output` field of each failing check so the cause is visible without a re-run. When invoked from a CI pipeline, pipe the JSON straight to a downstream step or store it as a build artifact.

### 3. In a GitHub Actions job

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm verify:ci | tee verify-report.json
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: verify-report
    path: verify-report.json
```

`pnpm verify:ci` propagates the script's exit code, so a failing check fails the job.

## Exit codes

- `0` — every check passed or was skipped
- `1` — one or more checks failed
- `2` — usage error (unknown flag or check name)

The exit code is what CI runners pivot on, so do not swallow it.

## Differences vs `/verify-all`

| Aspect | `/verify-all` | `/ci` |
|--------|---------------|-------|
| Output | Human-readable progress + summary table | JSON to stdout only |
| Failing output | Inline tail under each failure | `output` field per failing check |
| Interactivity | Allowed (no prompts today, but reserved) | Forbidden; `CI=1` exported |
| Use case | Local development | CI pipelines, automation, scripts |
| Exit code on failure | 1 | 1 |

## Related

- `/verify-all` — human-readable version of the same checks
- `./scripts/verify-all.sh --help` — full flag documentation
