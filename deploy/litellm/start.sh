#!/bin/sh
set -eu

VERCEL_AI_GATEWAY_API_BASE="${VERCEL_AI_GATEWAY_API_BASE:-https://ai-gateway.vercel.sh/v1}"
VERCEL_AI_GATEWAY_API_BASE="${VERCEL_AI_GATEWAY_API_BASE%/}"
export VERCEL_AI_GATEWAY_API_BASE
export VERCEL_AI_GATEWAY_LANGUAGE_MODEL_URL="${VERCEL_AI_GATEWAY_API_BASE%/v1}/v4/ai/language-model"
export VERCEL_AI_GATEWAY_GENERATION_URL="$VERCEL_AI_GATEWAY_API_BASE/generation"

if [ -n "${NEON_AI_GATEWAY_BASE_URL:-}" ]; then
  export NEON_AI_GATEWAY_CHAT_URL="${NEON_AI_GATEWAY_BASE_URL%/}/v1"
fi

if [ -n "${MIKKA_LITELLM_PRIVATE_CA_FILE:-}" ]; then
  # Keep public provider trust when adding the Cloudflare intercept CA.
  trust_bundle=$(mktemp)
  cat /etc/ssl/certs/ca-certificates.crt "$MIKKA_LITELLM_PRIVATE_CA_FILE" > "$trust_bundle"
  export SSL_CERT_FILE="$trust_bundle"
  export REQUESTS_CA_BUNDLE="$trust_bundle"
fi

exec litellm --config /app/config.yaml --port 4000 --host 0.0.0.0
