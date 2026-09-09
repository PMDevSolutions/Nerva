#!/usr/bin/env bash
#
# check-prerequisites.sh — Verify the tools Nerva needs and report them in a
# stable, machine-parseable layout.
#
# Usage:
#   ./scripts/check-prerequisites.sh          # human-readable report
#   ./scripts/check-prerequisites.sh --json   # same data as JSON
#   ./scripts/check-prerequisites.sh --help
#
# Output contract (do not change casually — scripts/__tests__ pins it):
#   - Section headers on their own line, each followed by a dashed underline:
#       REQUIRED SOFTWARE, OPTIONAL SOFTWARE, CLAUDE CODE, PROJECT
#   - One result per line:  [PASS] | [FAIL] | [SKIP] | [INFO] <detail>
#   - Indented continuation lines under a result are hints for that result
#   - A "=== Summary ===" block with
#       "Required: x/y passed", "Optional: x/y installed",
#       "Claude Code: x/y ready", "Project: x/y ready",
#     then "Ready to use Nerva: YES|NO"
#
# JSON mode (--json) emits one object:
#   { "ready": bool, "exitCode": n,
#     "summary": { "required": {passed,total}, "optional": {installed,total},
#                  "claudeCode": {passed,total}, "project": {ready,total} },
#     "checks": [ { "section", "status", "detail", "hints": [] }, ... ] }
#
# What blocks readiness: any [FAIL] in REQUIRED SOFTWARE or any [FAIL] in
# PROJECT. The claude CLI, plugins, optional software, and [INFO]/[SKIP]
# lines never block (the IDE extensions run Claude Code without a CLI on PATH).
#
# Exit codes: 0 = ready, 1 = a required item is missing or the project is
#             broken, 2 = script/usage error.
#
# Env overrides (tests): NERVA_PROJECT_ROOT, NERVA_PLUGINS_FILE.
# Colors come from scripts/lib/colors.sh and are disabled under NO_COLOR.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

MIN_GIT_VERSION="2.30.0"
MIN_NODE_VERSION="20.0.0"
RECOMMENDED_NODE_MAJOR=22
MIN_PNPM_VERSION="9.0.0"
# Marketplace plugins CLAUDE.md lists as installed (ai-taskmaster is local).
EXPECTED_PLUGINS="episodic-memory commit-commands superpowers"

JSON_MODE=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=1 ;;
    -h|--help)
      sed -n '2,/^set -u/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      error "Unknown argument: $arg (expected --json or --help)"
      exit 2
      ;;
  esac
done

ROOT="${NERVA_PROJECT_ROOT:-$(common_project_root)}"
PLUGINS_FILE="${NERVA_PLUGINS_FILE:-$HOME/.claude/plugins/installed_plugins.json}"

if [[ ! -d "$ROOT" ]]; then
  error "Project root does not exist: $ROOT"
  exit 2
fi

# ── Counters ────────────────────────────────────────────────────────────────
REQUIRED_PASS=0; REQUIRED_TOTAL=0
OPTIONAL_PASS=0; OPTIONAL_TOTAL=0
CLAUDE_PASS=0;   CLAUDE_TOTAL=0
PROJECT_PASS=0;  PROJECT_TOTAL=0
BLOCKING=0

# ── Result recording (text or JSON) ─────────────────────────────────────────
CURRENT_SECTION=""
ITEM_SECTION=(); ITEM_STATUS=(); ITEM_DETAIL=(); ITEM_HINTS=()
HINT_SEP=$'\x1f'

header() {
  CURRENT_SECTION="$1"
  [[ "$JSON_MODE" -eq 1 ]] && return 0
  echo ""
  printf '%s%s%s\n' "$CYAN" "$1" "$NC"
  printf '%s\n' "$(printf '%s' "$1" | sed 's/./-/g')"
}

record() {
  local status="$1" detail="$2" color=""
  ITEM_SECTION+=("$CURRENT_SECTION"); ITEM_STATUS+=("$status")
  ITEM_DETAIL+=("$detail"); ITEM_HINTS+=("")
  [[ "$JSON_MODE" -eq 1 ]] && return 0
  case "$status" in
    PASS) color="$GREEN" ;;
    FAIL) color="$RED" ;;
    SKIP) color="$YELLOW" ;;
    INFO) color="$BLUE" ;;
  esac
  printf '%s[%s]%s %s\n' "$color" "$status" "$NC" "$detail"
}
pass() { record PASS "$1"; }
fail() { record FAIL "$1"; }
skip() { record SKIP "$1"; }
note() { record INFO "$1"; }
hint() {
  local last=$(( ${#ITEM_HINTS[@]} - 1 ))
  if [[ "$last" -ge 0 ]]; then
    if [[ -n "${ITEM_HINTS[$last]}" ]]; then
      ITEM_HINTS[$last]="${ITEM_HINTS[$last]}${HINT_SEP}$1"
    else
      ITEM_HINTS[$last]="$1"
    fi
  fi
  [[ "$JSON_MODE" -eq 1 ]] && return 0
  printf '       %s\n' "$1"
}

# ── Version helpers ─────────────────────────────────────────────────────────
first_version() { printf '%s' "$1" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1; }

# version_gte A B → 0 when A >= B (dotted numeric versions; pure bash, no sort -V)
version_gte() {
  local a b i ai bi
  IFS='.' read -r -a a <<< "$(printf '%s' "$1" | sed 's/[^0-9.]//g')"
  IFS='.' read -r -a b <<< "$(printf '%s' "$2" | sed 's/[^0-9.]//g')"
  for i in 0 1 2; do
    ai="${a[$i]:-0}"; bi="${b[$i]:-0}"
    if (( 10#$ai > 10#$bi )); then return 0; fi
    if (( 10#$ai < 10#$bi )); then return 1; fi
  done
  return 0
}

# check_optional <cmd> <label> <install hint> [version flag]
check_optional() {
  local cmd="$1" label="$2" install="$3" flag="${4:---version}" version=""
  OPTIONAL_TOTAL=$((OPTIONAL_TOTAL + 1))
  if have_cmd "$cmd"; then
    version="$(first_version "$("$cmd" "$flag" 2>&1 </dev/null | head -n 3)")"
    pass "$label${version:+ $version}"; OPTIONAL_PASS=$((OPTIONAL_PASS + 1))
  else
    skip "$label not installed"
    hint "Install: $install"
  fi
}

if [[ "$JSON_MODE" -eq 0 ]]; then
  echo ""
  echo "=== Nerva Prerequisites Check ==="
fi

# ── Required software ───────────────────────────────────────────────────────
header "REQUIRED SOFTWARE"

REQUIRED_TOTAL=$((REQUIRED_TOTAL + 1))
if have_cmd git; then
  GIT_VERSION="$(first_version "$(git --version 2>/dev/null)")"
  if [[ -n "$GIT_VERSION" ]] && version_gte "$GIT_VERSION" "$MIN_GIT_VERSION"; then
    pass "Git $GIT_VERSION (minimum: $MIN_GIT_VERSION)"; REQUIRED_PASS=$((REQUIRED_PASS + 1))
  else
    fail "Git ${GIT_VERSION:-unknown} is too old (minimum: $MIN_GIT_VERSION)"; BLOCKING=1
    hint "Install: https://git-scm.com/downloads"
  fi
else
  fail "Git not installed (minimum: $MIN_GIT_VERSION)"; BLOCKING=1
  hint "Install: https://git-scm.com/downloads"
fi

REQUIRED_TOTAL=$((REQUIRED_TOTAL + 1))
if have_cmd node; then
  NODE_VERSION="$(first_version "$(node --version 2>/dev/null)")"
  if [[ -n "$NODE_VERSION" ]] && version_gte "$NODE_VERSION" "$MIN_NODE_VERSION"; then
    pass "Node.js $NODE_VERSION (minimum: $MIN_NODE_VERSION, recommended: $RECOMMENDED_NODE_MAJOR)"
    REQUIRED_PASS=$((REQUIRED_PASS + 1))
    if (( 10#${NODE_VERSION%%.*} < RECOMMENDED_NODE_MAJOR )); then
      hint "Node.js $RECOMMENDED_NODE_MAJOR LTS is recommended (deployment templates target nodejs22.x / 22-alpine)"
    fi
  else
    fail "Node.js ${NODE_VERSION:-unknown} is too old (minimum: $MIN_NODE_VERSION, recommended: $RECOMMENDED_NODE_MAJOR)"; BLOCKING=1
    hint "Install: https://nodejs.org/ (or use nvm/fnm)"
  fi
else
  fail "Node.js not installed (minimum: $MIN_NODE_VERSION, recommended: $RECOMMENDED_NODE_MAJOR)"; BLOCKING=1
  hint "Install: https://nodejs.org/ (or use nvm/fnm)"
fi

REQUIRED_TOTAL=$((REQUIRED_TOTAL + 1))
if have_cmd pnpm; then
  PNPM_VERSION="$(first_version "$(pnpm --version 2>/dev/null)")"
  if [[ -n "$PNPM_VERSION" ]] && version_gte "$PNPM_VERSION" "$MIN_PNPM_VERSION"; then
    pass "pnpm $PNPM_VERSION (minimum: $MIN_PNPM_VERSION)"; REQUIRED_PASS=$((REQUIRED_PASS + 1))
  else
    fail "pnpm ${PNPM_VERSION:-unknown} is too old (minimum: $MIN_PNPM_VERSION)"; BLOCKING=1
    hint "Fix: corepack enable && corepack prepare pnpm@latest --activate"
  fi
else
  fail "pnpm not installed (minimum: $MIN_PNPM_VERSION)"; BLOCKING=1
  hint "Install: corepack enable && corepack prepare pnpm@latest --activate"
fi

REQUIRED_TOTAL=$((REQUIRED_TOTAL + 1))
pass "Bash ${BASH_VERSION%%(*}"; REQUIRED_PASS=$((REQUIRED_PASS + 1))

# ── Optional software ───────────────────────────────────────────────────────
header "OPTIONAL SOFTWARE"

check_optional docker     "Docker"       "https://docs.docker.com/get-docker/ (local PostgreSQL via docker-compose)"
check_optional psql       "psql"         "brew install libpq / apt install postgresql-client"
check_optional jq         "jq"           "brew install jq / apt install jq (used by hooks)"
check_optional gh         "GitHub CLI"   "https://cli.github.com/ then run: gh auth login"
check_optional shellcheck "ShellCheck"   "brew install shellcheck / apt install shellcheck"
check_optional k6         "k6"           "brew install k6 / https://grafana.com/docs/k6/latest/set-up/install-k6/ (load tests)" "version"
check_optional wrangler   "Wrangler"     "pnpm add -g wrangler (Cloudflare Workers target)"
check_optional sam        "AWS SAM CLI"  "brew install aws-sam-cli / https://docs.aws.amazon.com/serverless-application-model/ (AWS Lambda target)"
check_optional flyctl     "flyctl"       "brew install flyctl / curl -L https://fly.io/install.sh | sh (Fly.io target)" "version"
check_optional railway    "Railway CLI"  "pnpm add -g @railway/cli (Railway target)"

# ── Claude Code ─────────────────────────────────────────────────────────────
header "CLAUDE CODE"

CLAUDE_TOTAL=$((CLAUDE_TOTAL + 1))
if have_cmd claude; then
  CLAUDE_VERSION="$(first_version "$(claude --version 2>/dev/null </dev/null | head -n 1)")"
  pass "Claude Code${CLAUDE_VERSION:+ $CLAUDE_VERSION}"; CLAUDE_PASS=$((CLAUDE_PASS + 1))
else
  # Not blocking: the VS Code / JetBrains extensions and the desktop app run
  # Claude Code without putting a `claude` binary on the shell PATH.
  skip "Claude Code CLI not on PATH (fine if you use the VS Code, JetBrains or desktop app)"
  hint "CLI install: npm install -g @anthropic-ai/claude-code (https://claude.ai/code)"
fi

if [[ -f "$PLUGINS_FILE" ]]; then
  INSTALLED_PLUGINS=""
  if have_cmd node; then
    # Prints "name version" per installed plugin (keys are "name@marketplace").
    INSTALLED_PLUGINS="$(node -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        for (const [key, entries] of Object.entries(data.plugins || {})) {
          const name = key.split("@")[0];
          const first = Array.isArray(entries) ? entries[0] : entries;
          const version = (first && first.version) || "";
          console.log(name + " " + version);
        }
      } catch { /* unreadable: report nothing installed */ }
    ' "$PLUGINS_FILE" 2>/dev/null)"
  else
    INSTALLED_PLUGINS="$(grep -oE '"[A-Za-z0-9_-]+@[^"]*"' "$PLUGINS_FILE" 2>/dev/null | sed 's/^"//; s/@.*//' | sort -u)"
  fi
  for plugin in $EXPECTED_PLUGINS; do
    CLAUDE_TOTAL=$((CLAUDE_TOTAL + 1))
    match="$(printf '%s\n' "$INSTALLED_PLUGINS" | awk -v p="$plugin" '$1 == p { print; exit }')"
    if [[ -n "$match" ]]; then
      version="$(printf '%s' "$match" | awk '{ print $2 }')"
      pass "$plugin plugin${version:+ $version}"; CLAUDE_PASS=$((CLAUDE_PASS + 1))
    else
      skip "$plugin plugin not installed"
      hint "Install in Claude Code: /plugin install $plugin"
    fi
  done
else
  for plugin in $EXPECTED_PLUGINS; do
    CLAUDE_TOTAL=$((CLAUDE_TOTAL + 1))
    skip "$plugin plugin: cannot verify (no installed_plugins.json)"
  done
  hint "Plugin registry not found at $PLUGINS_FILE"
fi
note "ai-taskmaster is a local plugin (see .claude/PLUGINS-REFERENCE.md)"

# ── Project ─────────────────────────────────────────────────────────────────
header "PROJECT"

PROJECT_TOTAL=$((PROJECT_TOTAL + 1))
if [[ -d "$ROOT/node_modules" ]]; then
  pass "node_modules present"; PROJECT_PASS=$((PROJECT_PASS + 1))
else
  fail "node_modules missing at repo root"; BLOCKING=1
  hint "Run: pnpm install"
fi

PROJECT_TOTAL=$((PROJECT_TOTAL + 1))
CONFIG_FILE="$ROOT/.claude/pipeline.config.json"
if [[ -f "$CONFIG_FILE" ]]; then
  if have_cmd node; then
    if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$CONFIG_FILE" >/dev/null 2>&1; then
      pass ".claude/pipeline.config.json parses"; PROJECT_PASS=$((PROJECT_PASS + 1))
      hint "Full validation: node scripts/validate-pipeline-config.js"
    else
      fail ".claude/pipeline.config.json is not valid JSON"; BLOCKING=1
      hint "Validate: node scripts/validate-pipeline-config.js"
    fi
  elif have_cmd jq; then
    if jq empty "$CONFIG_FILE" >/dev/null 2>&1; then
      pass ".claude/pipeline.config.json parses"; PROJECT_PASS=$((PROJECT_PASS + 1))
    else
      fail ".claude/pipeline.config.json is not valid JSON"; BLOCKING=1
    fi
  else
    pass ".claude/pipeline.config.json present (parse not checked: node and jq missing)"
    PROJECT_PASS=$((PROJECT_PASS + 1))
  fi
else
  fail ".claude/pipeline.config.json not found (is this a Nerva checkout?)"; BLOCKING=1
fi

PROJECT_TOTAL=$((PROJECT_TOTAL + 1))
if [[ -f "$ROOT/.husky/pre-commit" ]]; then
  pass ".husky/pre-commit hook present"; PROJECT_PASS=$((PROJECT_PASS + 1))
else
  fail ".husky/pre-commit hook missing"; BLOCKING=1
  hint "Run: pnpm install (husky installs hooks via the prepare script)"
fi

PROJECT_TOTAL=$((PROJECT_TOTAL + 1))
AGENT_COUNT=0
if [[ -d "$ROOT/.claude/agents" ]]; then
  AGENT_COUNT="$(find "$ROOT/.claude/agents" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')"
fi
if [[ "$AGENT_COUNT" -gt 0 ]]; then
  pass ".claude/agents contains $AGENT_COUNT agent(s)"; PROJECT_PASS=$((PROJECT_PASS + 1))
else
  fail ".claude/agents is missing or empty"; BLOCKING=1
fi

PROJECT_TOTAL=$((PROJECT_TOTAL + 1))
SKILL_COUNT=0
if [[ -d "$ROOT/.claude/skills" ]]; then
  SKILL_COUNT="$(find "$ROOT/.claude/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
fi
if [[ "$SKILL_COUNT" -gt 0 ]]; then
  pass ".claude/skills contains $SKILL_COUNT skill(s)"; PROJECT_PASS=$((PROJECT_PASS + 1))
else
  fail ".claude/skills is missing or empty"; BLOCKING=1
fi

if [[ -d "$ROOT/api" ]]; then
  note "api/ present (generated API project)"
else
  note "api/ not present (framework checkout; run ./scripts/setup-project.sh or /build-from-schema to create one)"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
READY="NO"; EXIT_CODE=1
if [[ "$BLOCKING" -eq 0 ]]; then
  READY="YES"; EXIT_CODE=0
fi

if [[ "$JSON_MODE" -eq 1 ]]; then
  json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037'
  }
  ready_json="false"; [[ "$READY" == "YES" ]] && ready_json="true"
  printf '{"ready":%s,"exitCode":%d,' "$ready_json" "$EXIT_CODE"
  printf '"summary":{"required":{"passed":%d,"total":%d},"optional":{"installed":%d,"total":%d},"claudeCode":{"passed":%d,"total":%d},"project":{"ready":%d,"total":%d}},' \
    "$REQUIRED_PASS" "$REQUIRED_TOTAL" "$OPTIONAL_PASS" "$OPTIONAL_TOTAL" \
    "$CLAUDE_PASS" "$CLAUDE_TOTAL" "$PROJECT_PASS" "$PROJECT_TOTAL"
  printf '"checks":['
  for i in "${!ITEM_STATUS[@]}"; do
    [[ "$i" -gt 0 ]] && printf ','
    printf '{"section":"%s","status":"%s","detail":"%s","hints":[' \
      "$(json_escape "${ITEM_SECTION[$i]}")" "${ITEM_STATUS[$i]}" "$(json_escape "${ITEM_DETAIL[$i]}")"
    if [[ -n "${ITEM_HINTS[$i]}" ]]; then
      IFS="$HINT_SEP" read -r -a hints <<< "${ITEM_HINTS[$i]}"
      for j in "${!hints[@]}"; do
        [[ "$j" -gt 0 ]] && printf ','
        printf '"%s"' "$(json_escape "${hints[$j]}")"
      done
    fi
    printf ']}'
  done
  printf ']}\n'
  exit "$EXIT_CODE"
fi

echo ""
echo "=== Summary ==="
echo "Required: $REQUIRED_PASS/$REQUIRED_TOTAL passed"
echo "Optional: $OPTIONAL_PASS/$OPTIONAL_TOTAL installed"
echo "Claude Code: $CLAUDE_PASS/$CLAUDE_TOTAL ready"
echo "Project: $PROJECT_PASS/$PROJECT_TOTAL ready"
echo ""
if [[ "$READY" == "YES" ]]; then
  printf '%sReady to use Nerva: YES%s\n' "$GREEN" "$NC"
else
  printf '%sReady to use Nerva: NO%s\n' "$RED" "$NC"
  echo ""
  echo "Install the missing requirements above, then run this script again."
fi
exit "$EXIT_CODE"
