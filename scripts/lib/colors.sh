# shellcheck shell=bash
# colors.sh — ANSI terminal color constants
#
# Source this file to get color variables. Colors are disabled when stdout is
# not a terminal, or when NO_COLOR (no-color.org) / COLORS_DISABLE is set, so
# output stays clean when piped, captured by tests, or written to logs.
#
# Usage:
#   source "$SCRIPT_DIR/lib/colors.sh"
#   echo -e "${RED}error${NC}"

# Avoid redefining if sourced multiple times.
if [[ -n "${__NERVA_COLORS_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__NERVA_COLORS_SH_LOADED=1

if [[ -n "${NO_COLOR:-}" ]] || [[ -n "${COLORS_DISABLE:-}" ]] || [[ ! -t 1 ]]; then
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  MAGENTA=''
  CYAN=''
  BOLD=''
  DIM=''
  NC=''
else
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[1;33m'
  BLUE=$'\033[0;34m'
  MAGENTA=$'\033[0;35m'
  CYAN=$'\033[0;36m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  NC=$'\033[0m'
fi

export RED GREEN YELLOW BLUE MAGENTA CYAN BOLD DIM NC
