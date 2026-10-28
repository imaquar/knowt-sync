#!/bin/zsh
set -e
umask 077
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
mkdir -p runtime/npm-cache runtime/browsers
export npm_config_cache="$ROOT/runtime/npm-cache"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/browsers"
npm ci
npx playwright install chromium
npm run check
npm run login
