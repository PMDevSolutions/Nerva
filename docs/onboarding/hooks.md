# Claude Code Hooks

Hooks are small bash scripts that Claude Code runs automatically around its own tool calls. Nerva ships two kinds:

- **PreToolUse guards** that block a dangerous Bash command before it runs (staging secrets into git, pushing schema changes at a production database).
- **PostToolUse reminders** that surface a one-line nudge after a Bash command finishes (coverage threshold, migration review, quality gate).

Every hook is a file under `.claude/hooks/`, wired in `.claude/settings.json`, and covered by `scripts/__tests__/hooks.test.js`.

```
.claude/
├── settings.json                      # wiring (committed; settings.local.json stays personal)
└── hooks/
    ├── lib/
    │   ├── hook-input.sh              # stdin JSON helpers (hook_get, hook_tool_output, ...)
    │   └── bash-cmd.sh                # splits a Bash command into simple commands + words
    ├── secret-guard.sh                # PreToolUse
    ├── prod-db-guard.sh               # PreToolUse
    ├── coverage-check.sh              # PostToolUse
    ├── migration-safety-reminder.sh   # PostToolUse
    └── quality-gate-reminder.sh       # PostToolUse
```

## The stdin contract

Claude Code passes **one JSON object on stdin** to each hook. Hooks read it once and never take positional arguments.

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "git add .env" },
  "tool_response": { "stdout": "...", "stderr": "...", "interrupted": false },
  "cwd": "/path/to/project"
}
```

| Field | Present on | Notes |
|-------|-----------|-------|
| `tool_name` | both | Hooks in this repo only act on `Bash` |
| `tool_input.command` | both | The exact command Claude asked to run |
| `tool_response` | PostToolUse | For Bash an object with `stdout`/`stderr`; other tools may return a string |

What the exit code means:

| Event | Exit 0 | Exit 2 | Other |
|-------|--------|--------|-------|
| PreToolUse | allow the call | **block** the call; stderr is shown to Claude | non-blocking error, call proceeds |
| PostToolUse | done; stdout is surfaced to Claude as a reminder (no output = silent) | n/a | treated as a hook error |

Hooks run with the **project root as cwd**, which is why `settings.json` references them as `bash .claude/hooks/<name>.sh`.

Two rules every hook here follows:

1. **Never crash the tool call.** `set -u` plus `trap 'exit 0' ERR`, and every helper returns 0. Empty, truncated, or non-JSON stdin exits 0 with no output. A PreToolUse guard therefore *fails open*: the only way it blocks is its explicit `exit 2`.
2. **Read stdin through the shared helper**, never with ad-hoc `jq` calls, so the jq/node fallback and the `tool_response` shape are handled in one place.

## Shared libraries

`.claude/hooks/lib/hook-input.sh` (sourced by every hook):

| Helper | Purpose |
|--------|---------|
| `HOOK_INPUT` | Raw stdin, read once |
| `hook_get .tool_input.command` | jq-style lookup; `""` when missing or not JSON. Uses `jq` when installed, otherwise `node` (always present in Nerva). `NERVA_HOOK_JSON_TOOL=node` forces the node path (tests use it) |
| `hook_tool_name`, `hook_tool_command` | Shorthands |
| `hook_tool_output` | `tool_response` as text, whatever its shape (`{stdout,stderr}`, `{output}`, or a string) |
| `hook_skip_requested` | True when `NERVA_SKIP_HOOKS=1` is in the hook's environment |
| `common_config_get` fallback | Defined only if `scripts/lib/common.sh` was not sourced, so copied hooks still read `pipeline.config.json` |

`.claude/hooks/lib/bash-cmd.sh` (PreToolUse guards):

| Helper | Purpose |
|--------|---------|
| `hook_split_commands "$CMD"` | Fills `HOOK_SEGMENTS`: one simple command per entry. Splits on newline, `;`, `|`, `||`, `&&`, `&`, `(`, `)` and backticks outside quotes, drops comments, skips heredoc bodies (`<<EOF`, `<<-'EOF'`), keeps `2>&1`-style redirects intact |
| `hook_tokenize "$seg"` | Fills `HOOK_TOKENS`: words with quotes and backslash escapes removed |
| `hook_strip_wrappers` | Fills `HOOK_ARGV`: `HOOK_TOKENS` minus leading `VAR=value`, `sudo`, `env`, `command`, `time`, `if`, `{`, ... so `HOOK_ARGV[0]` is the program |

Both libraries are Bash 3.2 compatible (macOS `/bin/bash`).

`scripts/lib/common.sh` is sourced via an absolute path derived from the hook's own location (`$HOOK_DIR/../../scripts/lib/common.sh`). It supplies `have_cmd` and `common_config_get <dotted.path> [default]`, which reads `.claude/pipeline.config.json` (or the file named by `NERVA_PIPELINE_CONFIG`).

## Built-in hooks

### secret-guard.sh (PreToolUse, Bash)

| | |
|---|---|
| Triggers on | `git add` / `git stage` of `.env`, `.env.*`, `.dev.vars`, `.dev.vars.*`, `*.pem`, `*.key`, `*.p12`, `credentials.json`; any `git add -f` / `--force` (including clusters such as `-Af`); `git commit -a` / `-am` / `--all` while one of those files is already tracked (`git ls-files`) |
| Not blocked | `.env.example`, `.env.*.example`, `.dev.vars.example`; `git add .` / `-A` (rely on `.gitignore`); a mention inside a quoted string, comment, or heredoc body; `git commit -m "add .env support"` |
| Result | exit 2, stderr `[secret-guard] Blocked: this command would stage a secret file (.env). ...` |
| Compound commands | Every simple command is inspected, so `cd api && git add .env`, `git -C api add .env`, `(cd api && git add .env)` and `FOO=1 git add .env` are all caught |
| Bypass | Commit `.env.example` instead; untrack a secret with `git rm --cached <file>`; or run the command yourself in a terminal (see below) |

### prod-db-guard.sh (PreToolUse, Bash)

| | |
|---|---|
| Triggers on | (1) `drizzle-kit push` / `pnpm db:push` when the same command references production: `--env production`, `PROD_DATABASE_URL`, `NODE_ENV=production`, or a `postgres://...` URL containing `prod`. (2) `psql`, `pnpm db:*`, or `drizzle-kit` invocations that reference production **and** contain `DROP DATABASE`, `DROP SCHEMA`, or `TRUNCATE`. (3) `drizzle-kit drop`, always |
| Not blocked | Plain `drizzle-kit push` / `pnpm db:push` in dev (the PostToolUse reminder fires instead); `drizzle-kit generate` / `migrate`; read-only `psql` against production; `TRUNCATE` against a non-production URL |
| Result | exit 2, stderr `[prod-db-guard] Blocked: drizzle-kit push against a production target (--env production). ...` naming the matched token |
| Bypass | Production schema changes go through `drizzle-kit generate`, review, `drizzle-kit migrate`. For a genuine one-off, run it yourself in a terminal |

### coverage-check.sh (PostToolUse, Bash)

| | |
|---|---|
| Triggers on | Command contains `vitest` (or `run-tests.sh`) **and** the output mentions coverage |
| Prints | `[coverage-check] Statement coverage 91.2% meets the 80% threshold ...` when the text reporter's `All files` row is present, otherwise a generic reminder. Threshold comes from `tdd.coverageThreshold` (default 80) |
| Silent when | No coverage in the output, or the command is not a test run |

### migration-safety-reminder.sh (PostToolUse, Bash)

| | |
|---|---|
| Triggers on | `drizzle-kit generate` / `pnpm db:generate` / `scripts/generate-migration.sh` whose output reports a generated migration; any `drizzle-kit push` / `pnpm db:push` |
| Prints | After generate: run the destructive-DDL check and read the SQL. The command is chosen from the cwd: `node scripts/check-destructive-migrations.js` when that file exists (framework repo), `pnpm db:check-destructive` when `package.json` defines it (generated `api/` project). After push: push is dev-only; staging and production take migrations |
| Silent when | Generate reported `No schema changes` or an error |

### quality-gate-reminder.sh (PostToolUse, Bash)

| | |
|---|---|
| Triggers on | A test command (`vitest`, `pnpm test`, `run-tests.sh`) whose output contains `Tests  N passed` and no `failed` |
| Prints | `[quality-gate] All tests passed. Run the quality gate ...: ./scripts/check-types.sh && ./scripts/security-scan.sh, then confirm coverage is at least 80% ...` |
| Silent when | Any test failed, or there is no summary line |

## Bypassing a guard legitimately

The guards govern **Claude's Bash tool only**. Options, from most to least targeted:

1. **Do the safe thing instead.** Stage `.env.example`; generate a migration instead of pushing; put the `TRUNCATE` in a reviewed migration.
2. **Run the command yourself** in your own terminal. Hooks do not run there.
3. **Launch Claude with `NERVA_SKIP_HOOKS=1`** (`NERVA_SKIP_HOOKS=1 claude`). Every hook exits 0 immediately. This has to be set in the environment Claude Code starts from; a `NERVA_SKIP_HOOKS=1 git add .env` typed by Claude does *not* work, because the prefix is stripped by the parser and the hook's own environment is untouched.
4. **Remove the entry from `.claude/settings.json`** for the session and restore it afterwards. Prefer the options above; `settings.local.json` cannot disable a hook defined in `settings.json`.

## Adding a hook

### 1. Write the script

`.claude/hooks/my-hook.sh`:

```bash
#!/usr/bin/env bash
# my-hook.sh — PostToolUse hook (matcher: Bash): one line on what it does.
set -u
trap 'exit 0' ERR

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HOOK_DIR/../../scripts/lib/common.sh" ]]; then
  source "$HOOK_DIR/../../scripts/lib/common.sh"
fi
source "$HOOK_DIR/lib/hook-input.sh"

hook_skip_requested && exit 0
CMD="$(hook_tool_command)"
[[ -n "$CMD" ]] || exit 0
printf '%s' "$CMD" | grep -qE 'git tag' || exit 0

OUT="$(hook_tool_output)"
THRESHOLD="$(common_config_get tdd.coverageThreshold 80)"
echo "[my-hook] New tag created. Update CHANGELOG.md if you have not."
exit 0
```

For a PreToolUse guard, add `set -f`, source `lib/bash-cmd.sh`, walk `HOOK_SEGMENTS`, and finish with:

```bash
if [[ -n "$BLOCK" ]]; then
  echo "[my-guard] Blocked: $BLOCK" >&2
  exit 2
fi
exit 0
```

Keep it fast (well under a second: it runs on every Bash call), prefix output with `[hook-name]`, and never `set -e`.

### 2. Register it

Append to the matching group in `.claude/settings.json`:

```json
{
  "type": "command",
  "command": "bash .claude/hooks/my-hook.sh",
  "description": "Remind to update the changelog after creating a git tag"
}
```

Entries in a group run in order; each is independent.

### 3. Test it

Try it by hand with a crafted payload:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git tag v1.2.0"},"tool_response":{"stdout":"","stderr":""}}' \
  | bash .claude/hooks/my-hook.sh; echo "exit=$?"

echo 'garbage' | bash .claude/hooks/my-hook.sh; echo "exit=$?"   # must be 0 and silent
bash -n .claude/hooks/my-hook.sh
```

Then add a `describe` block to `scripts/__tests__/hooks.test.js`. The file already has `runHook(name, payload, { cwd, env })`, `pre(command)`, `post(command, stdout, stderr)`, `configEnv({...})` for a throwaway `pipeline.config.json` (via `NERVA_PIPELINE_CONFIG`), and `gitRepo({...})` for a throwaway repository:

```js
describe("my-hook.sh (PostToolUse)", () => {
  it("fires after git tag", () => {
    const r = runHook("my-hook.sh", post("git tag v1.2.0", ""));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[my-hook]");
  });

  it("stays silent otherwise", () => {
    expect(runHook("my-hook.sh", post("git status", "")).stdout).toBe("");
  });
});
```

Add the file name to `PRE_HOOKS` or `POST_HOOKS` at the top of the test file: that enrols it in the `bash -n`, settings.json wiring, and bad-input robustness suites automatically. Run:

```bash
pnpm test -- scripts/__tests__/hooks.test.js
```

## Known limits

- The command parser does not descend into `bash -c "..."`, `eval`, or scripts invoked by path. `.gitignore` and database credentials scoping remain the real backstops.
- `git add .` / `git add -A` are allowed; they are far too common to block and `.gitignore` covers them.
- `git commit -a` checks tracked files from the project root; a nested repository under `api/` is not inspected.
- SQL inside a file (`psql -f drop.sql`) is invisible to prod-db-guard.
- Only one heredoc per line is recognised.

## Troubleshooting

**A guard blocked something legitimate.** The stderr line names the token that matched. Rename to `*.example`, untrack the file, or use one of the bypasses above.

**A hook does nothing.** Run it by hand with the payload shown in "Test it" and check `echo $?`. Then confirm the entry exists in `.claude/settings.json` (hooks are read at session start; restart Claude Code after editing).

**"jq: command not found" style noise.** Hooks should never print that; `hook_get` falls back to node. If you see it, the hook is calling jq directly instead of using `hook_get`.

**Hook output not visible.** PostToolUse reminders go to stdout; PreToolUse block reasons go to stderr. Swapping them makes the message disappear.
