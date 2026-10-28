#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(node -e 'const fs = require("node:fs"); const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!config.projectPath) process.exit(2); process.stdout.write(config.projectPath);' "$SCRIPT_DIR/config.json")"

if [[ ! -f "$PROJECT_DIR/package.json" || ! -f "$PROJECT_DIR/sync.mjs" ]]; then
  echo "Проверь projectPath в config.json"
  exit 1
fi

npm run sync --prefix "$PROJECT_DIR"
