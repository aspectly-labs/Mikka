#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: verify.sh <docker-image>}"

docker run --rm --network none --cap-drop ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --shm-size=512m \
  "$image" bash -euo pipefail -c '
    node_ver="$(node -v)"
    pnpm_ver="$(pnpm -v)"
    test "$node_ver" = "v24.22.1" || { echo "Expected node v24.22.1, got $node_ver" >&2; exit 1; }
    test "$pnpm_ver" = "10.34.3" || { echo "Expected pnpm 10.34.3, got $pnpm_ver" >&2; exit 1; }
    test "$(command -v node)" = "/usr/local/bin/node" || test "$(readlink -f "$(command -v node)")" = "/usr/local/bin/node"
    test "$PLAYWRIGHT_BROWSERS_PATH" = "/ms-playwright"
    test "$PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD" = "1"

    git --version >/dev/null
    zip -v >/dev/null
    unzip -v >/dev/null
    curl --version >/dev/null

    # Ensure Firefox was stripped and both Chromium + WebKit are pre-baked.
    if compgen -G "/ms-playwright/firefox*" >/dev/null; then
      echo "Unexpected firefox browser left in /ms-playwright" >&2
      exit 1
    fi

    chromium_bin="$(find /ms-playwright -maxdepth 4 -type f \( -name chrome -o -name chrome-headless-shell \) | head -n 1)"
    test -n "$chromium_bin" && test -x "$chromium_bin" || { echo "Missing Chromium binary in /ms-playwright" >&2; exit 1; }
    "$chromium_bin" --version

    webkit_bin="$(find /ms-playwright -maxdepth 4 -type f -name MiniBrowser | head -n 1)"
    test -n "$webkit_bin" && test -x "$webkit_bin" || { echo "Missing WebKit MiniBrowser binary in /ms-playwright" >&2; exit 1; }
    if ldd "$webkit_bin" | grep -q "not found"; then
      echo "Missing shared library for WebKit:" >&2
      ldd "$webkit_bin" | grep "not found" >&2
      exit 1
    fi

    probe="/tmp/playwright-ci-probe-$$"
    printf "ok\n" > "$probe"
    rm -f "$probe"

    echo "Verified Playwright CI image: node=$node_ver pnpm=$pnpm_ver chromium=$chromium_bin webkit=$webkit_bin"
  '
