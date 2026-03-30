#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# load-test.sh - Run k6 load tests
# Usage: ./scripts/load-test.sh [--vus 50] [--duration 30s] [--script path]
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

VUS=10
DURATION="30s"
K6_SCRIPT=""
BASE_URL="http://localhost:3000"
OUTPUT_JSON=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vus)      VUS="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --script)   K6_SCRIPT="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --json)     OUTPUT_JSON=true; shift ;;
    --)         shift; EXTRA_ARGS+=("$@"); break ;;
    *)          EXTRA_ARGS+=("$1"); shift ;;
  esac
done

if ! command -v k6 &>/dev/null; then
  error "k6 is not installed."
  echo ""
  echo "  Install k6:"
  echo "    macOS:   brew install k6"
  echo "    Windows: choco install k6 / winget install k6"
  echo "    Linux:   https://grafana.com/docs/k6/latest/set-up/install-k6/"
  exit 1
fi

if [[ -z "$K6_SCRIPT" ]]; then
  K6_SCRIPT="$API_DIR/tests/load/baseline.js"
fi

if [[ ! -f "$K6_SCRIPT" ]]; then
  warn "Load test script not found. Creating default baseline..."
  mkdir -p "$(dirname "$K6_SCRIPT")"
  cat > "$K6_SCRIPT" << 'K6EOF'
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const responseTime = new Trend('response_time');
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS) : 10,
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health status 200': (r) => r.status === 200,
    'health response < 200ms': (r) => r.timings.duration < 200,
  });
  errorRate.add(healthRes.status !== 200);
  responseTime.add(healthRes.timings.duration);

  const rootRes = http.get(`${BASE_URL}/`);
  check(rootRes, {
    'root status 200': (r) => r.status === 200,
    'root response < 300ms': (r) => r.timings.duration < 300,
  });
  errorRate.add(rootRes.status !== 200);
  responseTime.add(rootRes.timings.duration);

  sleep(0.5);
}
K6EOF
  success "Default baseline test created at: $K6_SCRIPT"
fi

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN} Nerva Load Test${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
info "Script:   ${CYAN}$K6_SCRIPT${NC}"
info "VUs:      ${CYAN}$VUS${NC}"
info "Duration: ${CYAN}$DURATION${NC}"
info "Base URL: ${CYAN}$BASE_URL${NC}"
echo ""

K6_CMD=("k6" "run")
K6_CMD+=("--vus" "$VUS")
K6_CMD+=("--duration" "$DURATION")
K6_CMD+=("-e" "BASE_URL=$BASE_URL")
K6_CMD+=("-e" "VUS=$VUS")
K6_CMD+=("-e" "DURATION=$DURATION")

if [[ "$OUTPUT_JSON" == true ]]; then
  REPORT_FILE="$API_DIR/tests/load/results-$(date +%Y%m%d-%H%M%S).json"
  K6_CMD+=("--out" "json=$REPORT_FILE")
  info "JSON output: $REPORT_FILE"
fi

[[ ${#EXTRA_ARGS[@]} -gt 0 ]] && K6_CMD+=("${EXTRA_ARGS[@]}")
K6_CMD+=("$K6_SCRIPT")

echo -e "${CYAN}Command:${NC} ${K6_CMD[*]}"
echo ""

START_TIME=$(date +%s)

if "${K6_CMD[@]}"; then
  END_TIME=$(date +%s)
  DUR=$((END_TIME - START_TIME))
  echo ""
  success "Load test completed in ${DUR}s."
  [[ "$OUTPUT_JSON" == true ]] && info "Results: $REPORT_FILE"
else
  END_TIME=$(date +%s)
  DUR=$((END_TIME - START_TIME))
  echo ""
  error "Load test failed after ${DUR}s."
  exit 1
fi
