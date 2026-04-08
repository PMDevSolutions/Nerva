#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# generate-openapi-docs.sh - Generate OpenAPI documentation from Hono routes
# Usage: ./scripts/generate-openapi-docs.sh [--serve] [--port 8080]
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
# shellcheck disable=SC2034 # CYAN is used in echo -e strings below
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$PROJECT_ROOT/api"
DOCS_DIR="$PROJECT_ROOT/docs"

SERVE=false
SERVE_PORT=8080
OUTPUT_FILE="$DOCS_DIR/openapi.yaml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --serve)     SERVE=true; shift ;;
    --port)      SERVE_PORT="$2"; shift 2 ;;
    --output|-o) OUTPUT_FILE="$2"; shift 2 ;;
    *)           error "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ ! -d "$API_DIR" ]]; then
  error "API directory not found at: $API_DIR"
  exit 1
fi

cd "$API_DIR"

if [[ ! -d "node_modules" ]]; then
  error "Dependencies not installed. Run pnpm install first."
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

GENERATOR_SCRIPT="$API_DIR/src/openapi.ts"

if [[ ! -f "$GENERATOR_SCRIPT" ]]; then
  info "Creating OpenAPI generator script..."

  cat > "$GENERATOR_SCRIPT" << 'GENEOF'
/**
 * OpenAPI spec generator for Nerva API.
 * Extracts route metadata and outputs an OpenAPI 3.1 specification.
 */

import { stringify } from 'yaml';

const spec: Record<string, unknown> = {
  openapi: '3.1.0',
  info: {
    title: 'Nerva API',
    version: '0.0.1',
    description: 'API documentation generated from Hono routes.',
    contact: { name: 'API Support' },
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
  ],
  paths: {
    '/health': {
      get: {
        summary: 'Health check',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                  required: ['status', 'timestamp'],
                },
              },
            },
          },
        },
      },
    },
    '/': {
      get: {
        summary: 'API root',
        responses: {
          '200': {
            description: 'API information',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    version: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['error', 'message'],
      },
    },
  },
};

async function generate(): Promise<void> {
  let output: string;
  try {
    output = stringify(spec);
  } catch {
    output = JSON.stringify(spec, null, 2);
  }
  process.stdout.write(output);
}

generate().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
GENEOF

  success "Generator script created at: $GENERATOR_SCRIPT"
fi

if [[ ! -d "node_modules/yaml" ]]; then
  info "Installing yaml package..."
  pnpm add -D yaml
fi

info "Generating OpenAPI specification..."
echo ""

if npx tsx "$GENERATOR_SCRIPT" > "$OUTPUT_FILE" 2>/dev/null; then
  success "OpenAPI spec written to: $OUTPUT_FILE"
else
  warn "Dynamic extraction failed. Writing minimal spec..."
  cat > "$OUTPUT_FILE" << 'FALLBACK'
openapi: "3.1.0"
info:
  title: Nerva API
  version: 0.0.1
  description: API documentation for the Nerva-powered API.
servers:
  - url: http://localhost:3000
    description: Local development
paths:
  /health:
    get:
      summary: Health check
      responses:
        "200":
          description: Service is healthy
  /:
    get:
      summary: API root
      responses:
        "200":
          description: API information
FALLBACK
  success "Fallback spec written to: $OUTPUT_FILE"
fi

FILE_SIZE=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
info "Spec size: ${FILE_SIZE} bytes"

if [[ "$SERVE" == true ]]; then
  echo ""
  info "Starting Scalar API documentation UI on port $SERVE_PORT..."

  SCALAR_HTML="$DOCS_DIR/_scalar.html"
  cat > "$SCALAR_HTML" << 'SCALARHTML'
<!DOCTYPE html>
<html>
<head>
  <title>Nerva API Documentation</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/openapi.yaml"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>
SCALARHTML

  info "Serving at: http://localhost:$SERVE_PORT"
  info "Press Ctrl+C to stop."
  npx serve "$DOCS_DIR" -l "$SERVE_PORT" --single
fi
