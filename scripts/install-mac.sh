#!/bin/bash
# ATEM Logger — macOS installer.
# Builds the app and installs a LaunchAgent so it runs in the background and starts at login.
# Re-run any time to update (e.g. after `git pull`).
set -e
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
PORT="${PORT:-9920}"
LABEL="com.atem-logger"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_DIR="$HOME/.atem-logger"

echo "== ATEM Logger installer =="
echo "App folder: $APP_DIR"

# --- Node.js ---------------------------------------------------------------
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
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

# --- LaunchAgent -----------------------------------------------------------
mkdir -p "$DATA_DIR" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/logger.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/logger.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# --- Wait for it -----------------------------------------------------------
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/status"; then
    echo
    echo "ATEM Logger is running: http://localhost:$PORT"
    IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [ -n "$IP" ] && echo "From other devices on the network: http://$IP:$PORT"
    echo "It starts automatically when you log in. Log: $DATA_DIR/logger.log"
    echo
    echo "If macOS asks to allow \"node\" to find devices on your local network, click Allow —"
    echo "it needs that to reach the switcher."
    open "http://localhost:$PORT"
    exit 0
  fi
  sleep 1
done
echo "The app didn't respond on port $PORT. Check the log: $DATA_DIR/logger.log"
exit 1
