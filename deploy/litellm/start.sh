#!/bin/sh
set -eu

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
