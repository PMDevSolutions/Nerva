#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# generate-client.sh - Generate typed TypeScript API client from OpenAPI spec
# Usage: ./scripts/generate-client.sh --spec docs/openapi.yaml --output client/
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
PROJECT_ROOT="$(common_project_root)"
API_DIR="$(common_api_dir)"

SPEC_FILE="$PROJECT_ROOT/docs/openapi.yaml"
OUTPUT_DIR="$PROJECT_ROOT/client"
GENERATE_RUNTIME=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec|-s)    SPEC_FILE="$2"; shift 2 ;;
    --output|-o)  OUTPUT_DIR="$2"; shift 2 ;;
    --runtime)    GENERATE_RUNTIME=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--spec <path>] [--output <dir>] [--runtime]"
      echo ""
      echo "Options:"
      echo "  --spec, -s     Path to OpenAPI spec (default: docs/openapi.yaml)"
      echo "  --output, -o   Output directory (default: client/)"
      echo "  --runtime      Also generate a runtime fetch client"
      exit 0
      ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

# Resolve relative paths
[[ "$SPEC_FILE" != /* ]] && SPEC_FILE="$PROJECT_ROOT/$SPEC_FILE"
[[ "$OUTPUT_DIR" != /* ]] && OUTPUT_DIR="$PROJECT_ROOT/$OUTPUT_DIR"

if [[ ! -f "$SPEC_FILE" ]]; then
  error "OpenAPI spec not found at: $SPEC_FILE"
  echo "  Generate it first: ./scripts/generate-openapi-docs.sh"
  exit 1
fi

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN} Nerva API Client Generator${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
info "Spec:   ${CYAN}$SPEC_FILE${NC}"
info "Output: ${CYAN}$OUTPUT_DIR${NC}"
echo ""

mkdir -p "$OUTPUT_DIR"
cd "$API_DIR"

if ! npx openapi-typescript --version &>/dev/null 2>&1; then
  info "Installing openapi-typescript..."
  pnpm add -D openapi-typescript
fi

info "Generating TypeScript types from OpenAPI spec..."

TYPES_FILE="$OUTPUT_DIR/api-types.d.ts"

if npx openapi-typescript "$SPEC_FILE" -o "$TYPES_FILE"; then
  success "Types generated at: $TYPES_FILE"
else
  error "Type generation failed."
  exit 1
fi

if [[ "$GENERATE_RUNTIME" == true ]]; then
  echo ""
  info "Generating runtime fetch client..."

  if ! pnpm list openapi-fetch &>/dev/null 2>&1; then
    info "Installing openapi-fetch..."
    pnpm add openapi-fetch
  fi

  CLIENT_FILE="$OUTPUT_DIR/client.ts"
  cat > "$CLIENT_FILE" << 'CLIENTEOF'
/**
 * Auto-generated typed API client for Nerva API.
 *
 * Usage:
 *   import { client } from './client';
 *   const { data, error } = await client.GET('/health');
 */

import createClient from 'openapi-fetch';
import type { paths } from './api-types.js';

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

export const client = createClient<paths>({
  baseUrl: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

export function createApiClient(options: {
  baseUrl?: string;
  headers?: Record<string, string>;
  token?: string;
}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  return createClient<paths>({
    baseUrl: options.baseUrl || BASE_URL,
    headers,
  });
}

export type { paths } from './api-types.js';
CLIENTEOF

  success "Runtime client generated at: $CLIENT_FILE"
fi

# Generate index file
INDEX_FILE="$OUTPUT_DIR/index.ts"
cat > "$INDEX_FILE" << 'INDEXEOF'
/**
 * Nerva API Client - Auto-generated from OpenAPI specification.
 */
export type { paths, components, operations } from './api-types.js';
INDEXEOF

if [[ "$GENERATE_RUNTIME" == true ]]; then
  echo "export { client, createApiClient } from './client.js';" >> "$INDEX_FILE"
fi

success "Index file generated at: $INDEX_FILE"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} Client generation complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  Files:"
echo "    $TYPES_FILE"
echo "    $INDEX_FILE"
[[ "$GENERATE_RUNTIME" == true ]] && echo "    $CLIENT_FILE"
echo ""
echo "  Usage:"
echo "    import type { paths } from '$(basename "$OUTPUT_DIR")';"
if [[ "$GENERATE_RUNTIME" == true ]]; then
  echo "    import { client } from '$(basename "$OUTPUT_DIR")';"
  echo "    const { data } = await client.GET('/health');"
fi
echo ""
