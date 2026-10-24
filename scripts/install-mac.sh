#!/bin/bash
# ATEM Logger — macOS installer.
# Builds the app and installs it as a system service that starts at boot (no login needed),
# plus the `atem-logger` command and a menu-bar icon. Re-run any time to update (e.g. after `git pull`).
# Asks for your Mac password once (admin account required).
set -e
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
PORT="${PORT:-9920}"

echo "== ATEM Logger installer =="
echo "App folder: $APP_DIR"

# --- Node.js ---------------------------------------------------------------
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && ! command -v node >/dev/null 2>&1 && . "$HOME/.nvm/nvm.sh" >/dev/null
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Node.js not found — installing with Homebrew…"
    brew install node
  else
    echo
    echo "Node.js is required (version 20 or newer)."
    echo "Install the LTS version from https://nodejs.org, then run this installer again."
    open "https://nodejs.org/en/download" 2>/dev/null || true
    exit 1
  fi
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js $("$NODE_BIN" -v) is too old — version 20 or newer is required (https://nodejs.org)."
  exit 1
fi
echo "Using Node.js $("$NODE_BIN" -v) at $NODE_BIN"

# --- Build -----------------------------------------------------------------
echo "Installing dependencies…"
npm ci --include=dev --ignore-scripts --no-fund --no-audit --loglevel=error
echo "Building…"
npm run build --silent

# Menu-bar app: rebuild from source if the Swift compiler is available, else use the prebuilt copy.
if command -v swiftc >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then
  bash tray/mac/build.sh >/dev/null 2>&1 || echo "(Using the prebuilt menu-bar app.)"
fi
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true

# --- Service (needs admin) ---------------------------------------------------
echo
echo "Installing the background service — enter your Mac password if asked."
if [ -t 0 ]; then
  sudo bash "$APP_DIR/scripts/mac/install-service.sh" "$USER" "$APP_DIR" "$NODE_BIN" "$PORT"
else
  # No terminal (e.g. run from another app): use the standard macOS admin prompt.
  /usr/bin/osascript -e "do shell script \"bash '$APP_DIR/scripts/mac/install-service.sh' '$USER' '$APP_DIR' '$NODE_BIN' '$PORT'\" with administrator privileges"
fi

# --- Wait for it -----------------------------------------------------------
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/status"; then
    echo
    echo "ATEM Logger is running as a service: http://localhost:$PORT"
    IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [ -n "$IP" ] && echo "From other devices on the network: http://$IP:$PORT"
    echo
    echo "It starts automatically when the Mac boots — no login needed."
    echo "Control it from the menu-bar icon, or in Terminal:"
    echo "  atem-logger status | start | stop | restart | open | logs"
    open "http://localhost:$PORT"
    exit 0
  fi
  sleep 1
done
echo "The service didn't respond on port $PORT. Check the log: ~/.atem-logger/logger.log"
exit 1
