#!/bin/bash
# Warm a Claude Code on the web session: install deps (and prime the Next build
# cache) so `pnpm lint` / `pnpm build` / `pnpm dev` are ready immediately.
set -euo pipefail

# Only run in the remote (web) environment; local sessions manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Enable pnpm via corepack if the binary isn't already on PATH.
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
fi

# Idempotent: pnpm install is a no-op when the store + lockfile already match.
pnpm install --prefer-offline

# Prime the Next/Turbopack build cache so the first real build is fast.
pnpm build || true
