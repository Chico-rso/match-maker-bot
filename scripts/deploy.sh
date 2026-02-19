#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DEPLOY_PATH:-$(pwd)}"
PM2_APP_NAME="${PM2_APP_NAME:-bot}"

# Prefer Node from nvm in non-login shells (GitHub Actions SSH).
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
fi

if [[ -d "$HOME/.nvm/versions/node" ]]; then
  LATEST_NODE_BIN="$(ls -1d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "${LATEST_NODE_BIN}" ]]; then
    export PATH="${LATEST_NODE_BIN}:$PATH"
  fi
fi

cd "$APP_DIR"

if [[ ! -f package.json ]]; then
  echo "package.json not found in $APP_DIR"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node.js >=18 is required, current: $(node -v)"
  exit 1
fi

echo "Installing production dependencies..."
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "Restarting PM2 process: $PM2_APP_NAME"
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME"
else
  pm2 start bot.js --name "$PM2_APP_NAME"
fi

pm2 save
echo "Deploy completed successfully."
