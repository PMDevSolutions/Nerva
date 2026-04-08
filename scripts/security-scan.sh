#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# security-scan.sh - Security scanning for Nerva API projects
# Usage: ./scripts/security-scan.sh [--json] [--audit-only] [--patterns-only]
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$PROJECT_ROOT/api"

OUTPUT_JSON=false
AUDIT_ONLY=false
PATTERNS_ONLY=false
ISSUES_FOUND=0
JSON_RESULTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)          OUTPUT_JSON=true; shift ;;
    --audit-only)    AUDIT_ONLY=true; shift ;;
    --patterns-only) PATTERNS_ONLY=true; shift ;;
    *)               error "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ ! -d "$API_DIR" ]]; then
  error "API directory not found at: $API_DIR"
  exit 1
fi

cd "$API_DIR"

add_issue() {
  local severity="$1" category="$2" message="$3" file="${4:-}" line="${5:-}"
  ISSUES_FOUND=$((ISSUES_FOUND + 1))

  if [[ "$OUTPUT_JSON" == true ]]; then
    JSON_RESULTS+=("{\"severity\":\"$severity\",\"category\":\"$category\",\"message\":\"$message\",\"file\":\"$file\",\"line\":\"$line\"}")
  else
    case "$severity" in
      critical) echo -e "  ${RED}[CRITICAL]${NC} $message" ;;
      high)     echo -e "  ${RED}[HIGH]${NC} $message" ;;
      medium)   echo -e "  ${YELLOW}[MEDIUM]${NC} $message" ;;
      low)      echo -e "  ${BLUE}[LOW]${NC} $message" ;;
    esac
    [[ -n "$file" ]] && echo -e "    File: $file${line:+:$line}"
  fi
}

run_audit() {
  info "Running pnpm audit for known vulnerabilities..."
  echo ""
  if ! command -v pnpm &>/dev/null; then
    error "pnpm is not installed."
    return 1
  fi

  AUDIT_OUTPUT=$(pnpm audit 2>&1) || true

  if echo "$AUDIT_OUTPUT" | grep -q "No known vulnerabilities found"; then
    success "No known vulnerabilities in dependencies."
  else
    warn "Vulnerabilities detected:"
    echo "$AUDIT_OUTPUT"
    CRITICAL_COUNT=$(echo "$AUDIT_OUTPUT" | grep -ci "critical" || true)
    HIGH_COUNT=$(echo "$AUDIT_OUTPUT" | grep -ci "high" || true)
    [[ "$CRITICAL_COUNT" -gt 0 ]] && add_issue "critical" "dependency" "$CRITICAL_COUNT critical vulnerability(ies)"
    [[ "$HIGH_COUNT" -gt 0 ]] && add_issue "high" "dependency" "$HIGH_COUNT high severity vulnerability(ies)"
  fi
  echo ""
}

run_pattern_scan() {
  info "Scanning for common API security anti-patterns..."
  echo ""

  SRC_DIR="$API_DIR/src"
  if [[ ! -d "$SRC_DIR" ]]; then
    warn "No src/ directory found. Skipping pattern scan."
    return
  fi

  # Hardcoded secrets
  info "Checking for hardcoded secrets..."
  for pattern in \
    'password\s*[:=]\s*["'"'"'][^"'"'"']{3,}' \
    'secret\s*[:=]\s*["'"'"'][^"'"'"']{3,}' \
    'api[_-]?key\s*[:=]\s*["'"'"'][^"'"'"']{3,}' \
    'token\s*[:=]\s*["'"'"'][A-Za-z0-9+/=]{10,}' \
    'Bearer\s+[A-Za-z0-9._-]{20,}' \
    'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'; do
    MATCHES=$(grep -rnE "$pattern" "$SRC_DIR" --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v ".test." | grep -v ".spec." || true)
    if [[ -n "$MATCHES" ]]; then
      while IFS= read -r match; do
        FILE=$(echo "$match" | cut -d: -f1)
        LINE=$(echo "$match" | cut -d: -f2)
        add_issue "critical" "hardcoded-secret" "Possible hardcoded secret" "$FILE" "$LINE"
      done <<< "$MATCHES"
    fi
  done

  # SQL injection
  info "Checking for SQL injection risks..."
  for pattern in \
    'query\s*\(\s*`[^`]*\$\{' \
    'execute\s*\(\s*`[^`]*\$\{' \
    'raw\s*\(\s*`[^`]*\$\{'; do
    MATCHES=$(grep -rnE "$pattern" "$SRC_DIR" --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v ".test." || true)
    if [[ -n "$MATCHES" ]]; then
      while IFS= read -r match; do
        FILE=$(echo "$match" | cut -d: -f1)
        LINE=$(echo "$match" | cut -d: -f2)
        add_issue "high" "sql-injection" "Possible SQL injection via string interpolation" "$FILE" "$LINE"
      done <<< "$MATCHES"
    fi
  done

  # Rate limiting
  info "Checking for rate limiting..."
  HAS_RATE_LIMIT=false
  while IFS= read -r file; do
    grep -qE "(rateLimiter|rateLimit|rate-limit|throttle)" "$file" 2>/dev/null && HAS_RATE_LIMIT=true
  done < <(find "$SRC_DIR" -name "index.ts" -o -name "app.ts" 2>/dev/null)
  [[ "$HAS_RATE_LIMIT" == false ]] && add_issue "medium" "rate-limiting" "No rate limiting middleware detected"

  # CORS
  info "Checking for CORS configuration..."
  HAS_CORS=false
  while IFS= read -r file; do
    grep -qE "(cors|CORS)" "$file" 2>/dev/null && HAS_CORS=true
  done < <(find "$SRC_DIR" -name "index.ts" -o -name "app.ts" 2>/dev/null)
  [[ "$HAS_CORS" == false ]] && add_issue "medium" "cors" "No CORS middleware detected"

  # Console.log
  info "Checking for console.log statements..."
  LOG_COUNT=$(grep -rn "console\.log" "$SRC_DIR" --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v ".test." | grep -v ".spec." | wc -l || true)
  [[ "$LOG_COUNT" -gt 0 ]] && add_issue "low" "logging" "Found $LOG_COUNT console.log statement(s) - use structured logger"

  echo ""
}

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN} Nerva Security Scan${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

[[ "$PATTERNS_ONLY" == false ]] && run_audit
[[ "$AUDIT_ONLY" == false ]] && run_pattern_scan

if [[ "$OUTPUT_JSON" == true ]]; then
  JOINED=$(IFS=,; echo "${JSON_RESULTS[*]}")
  echo "{\"scan_date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"issues_count\":$ISSUES_FOUND,\"issues\":[$JOINED]}"
else
  echo -e "${CYAN}============================================${NC}"
  if [[ "$ISSUES_FOUND" -eq 0 ]]; then
    success "Security scan complete. No issues found."
  else
    warn "Security scan complete. Found $ISSUES_FOUND issue(s)."
    echo "  Run with --json for machine-readable output."
  fi
  echo -e "${CYAN}============================================${NC}"
fi

[[ "$ISSUES_FOUND" -gt 0 ]] && exit 1 || exit 0
