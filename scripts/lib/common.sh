# common.sh — Shared bash helpers for scripts/*.sh and .claude/hooks/*.sh
#
# Source this from any script:
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=lib/common.sh
#   source "$SCRIPT_DIR/lib/common.sh"
#
# Provides:
#   - colors (via lib/colors.sh)
#   - info/success/warn/error/step  — the log prefixes Nerva scripts already use
#   - say_banner/say_step/say_pass/say_fail/say_skip/say_warn — plain-text
#     prefixes for machine-parsed output (tests grep for these literals)
#   - common_project_root / common_api_dir
#   - require_cmd / have_cmd
#   - common_track_tmpfile (EXIT-trap cleanup)
#   - common_now_ms, common_csv_contains
#   - common_config_get <dotted.path> [default]  — reads .claude/pipeline.config.json
#
# Adapted from the Aurelius scripts/lib pattern so both frameworks share one
# convention.

if [[ -n "${__NERVA_COMMON_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__NERVA_COMMON_SH_LOADED=1

__NERVA_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/colors.sh
source "$__NERVA_LIB_DIR/colors.sh"

# --- Project root ---------------------------------------------------------

# Repository root = the parent of scripts/. Independent of the caller's cwd.
common_project_root() {
  (cd "$__NERVA_LIB_DIR/../.." && pwd)
}

# Directory of the generated API project. Defaults to <root>/api; override
# with NERVA_API_DIR for monorepos or tests.
common_api_dir() {
  if [[ -n "${NERVA_API_DIR:-}" ]]; then
    echo "$NERVA_API_DIR"
  else
    echo "$(common_project_root)/api"
  fi
}

# --- Log helpers (Nerva style) -------------------------------------------

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()    { echo -e "${CYAN}==>${NC} $*"; }

# --- Plain-text status prefixes (stable; tests assert these) --------------

say_banner() { echo "=== $* ==="; }
say_step()   { echo "▸ $*"; }
say_pass()   { echo "  ✓ $*"; }
say_fail()   { echo "  ✗ $*"; }
say_skip()   { echo "  ⊘ $*"; }
say_warn()   { echo "  ⚠ $*"; }
say_err()    { echo "Error: $*" >&2; }

# --- Tool availability ----------------------------------------------------

# require_cmd <name> [install hint] — exits 1 if the command is missing.
require_cmd() {
  local cmd="$1"
  local hint="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    say_err "$cmd not found on PATH."
    if [[ -n "$hint" ]]; then
      echo "  Install it with: $hint" >&2
    fi
    exit 1
  fi
}

# have_cmd <name> — 0/1 without exiting.
have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# --- Tempfile tracking ----------------------------------------------------
#
#   F=$(mktemp); common_track_tmpfile "$F"
#
# (mktemp cannot be wrapped in a function: the $( ) subshell would run the
# EXIT trap and delete the file before the caller receives the path.)

__NERVA_TMPFILES=()
__NERVA_TRAP_SET=0

common_cleanup_tmpfiles() {
  local f
  for f in "${__NERVA_TMPFILES[@]+"${__NERVA_TMPFILES[@]}"}"; do
    [[ -e "$f" ]] && rm -rf "$f"
  done
}

common_track_tmpfile() {
  __NERVA_TMPFILES+=("$1")
  if [[ "$__NERVA_TRAP_SET" -eq 0 ]]; then
    trap common_cleanup_tmpfiles EXIT
    __NERVA_TRAP_SET=1
  fi
}

# --- Cross-platform timestamp --------------------------------------------

# Milliseconds since epoch. GNU date supports %N; macOS does not.
common_now_ms() {
  if have_cmd node; then
    node -e 'process.stdout.write(String(Date.now()))'
  elif have_cmd python3; then
    python3 -c 'import time; print(int(time.time()*1000))'
  else
    echo "$(( $(date +%s) * 1000 ))"
  fi
}

# --- CSV helpers ----------------------------------------------------------

# common_csv_contains "a,b,c" "b" → 0/1
common_csv_contains() {
  local csv="$1"
  local needle="$2"
  [[ -z "$csv" ]] && return 1
  local parts part
  IFS=',' read -ra parts <<< "$csv"
  for part in "${parts[@]}"; do
    [[ "$(echo "$part" | tr -d ' ')" == "$needle" ]] && return 0
  done
  return 1
}

# --- pipeline.config.json access -----------------------------------------
#
# common_config_get <dotted.path> [default]
#
#   THRESHOLD=$(common_config_get 'tdd.coverageThreshold' 80)
#   LEVEL=$(common_config_get 'security.audit.level' moderate)
#
# Thin wrapper around scripts/lib/pipeline-config.js. Prints the default when
# the config, the key, or node is missing, so callers never need set +e.

common_config_get() {
  local key="$1"
  local default="${2-}"
  local helper="$__NERVA_LIB_DIR/pipeline-config.js"
  if [[ ! -f "$helper" ]] || ! have_cmd node; then
    echo "$default"
    return 0
  fi
  node "$helper" get "$key" "$default" 2>/dev/null || echo "$default"
}
