#!/bin/bash
# Installs ATEM Logger as a macOS system service (LaunchDaemon). Must run as root:
#   sudo bash scripts/mac/install-service.sh <user> <app-dir> <node-path> [port]
# The service runs as <user> (so settings, drives and file ownership stay theirs), starts at boot
# with nobody logged in, restarts if it crashes, and stays stopped when stopped on purpose.
set -e
[ "$(id -u)" = 0 ] || { echo "install-service.sh must run as root (sudo)"; exit 1; }
SVC_USER="$1"; APP_DIR="$2"; NODE_BIN="$3"; PORT="${4:-9920}"
[ -n "$SVC_USER" ] && [ -d "$APP_DIR" ] && [ -x "$NODE_BIN" ] || { echo "usage: install-service.sh <user> <app-dir> <node-path> [port]"; exit 1; }

LABEL="com.atem-logger"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
SVC_HOME="$(dscl . -read "/Users/$SVC_USER" NFSHomeDirectory | awk '{print $2}')"
SVC_UID="$(id -u "$SVC_USER")"
DATA_DIR="$SVC_HOME/.atem-logger"

# 1. Retire the older per-user login item, if present.
launchctl bootout "gui/$SVC_UID/$LABEL" 2>/dev/null || true
rm -f "$SVC_HOME/Library/LaunchAgents/$LABEL.plist"

# 2. Data folder owned by the service user.
mkdir -p "$DATA_DIR"
chown "$SVC_USER" "$DATA_DIR"

# 3. LaunchDaemon.
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
  <key>UserName</key><string>$SVC_USER</string>
  <key>GroupName</key><string>staff</string>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOME</key><string>$SVC_HOME</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash, but stay stopped after a clean stop (atem-logger stop / tray). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$DATA_DIR/logger.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/logger.log</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"; chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null

# 4. Let admins start/stop/restart this one service without a password (used by the CLI and tray).
SUDOERS="/etc/sudoers.d/atem-logger"
TMP="$(mktemp)"
cat > "$TMP" <<EOF
# ATEM Logger: allow admins to start/stop/restart the service without a password.
%admin ALL=(root) NOPASSWD: /bin/launchctl kickstart system/$LABEL, /bin/launchctl kickstart -k system/$LABEL, /bin/launchctl kill SIGTERM system/$LABEL
EOF
if visudo -cf "$TMP" >/dev/null; then install -m 440 -o root -g wheel "$TMP" "$SUDOERS"; else echo "warning: sudoers rule failed validation; start/stop will ask for a password"; fi
rm -f "$TMP"

# 5. Command-line tool.
mkdir -p /usr/local/bin
chmod 755 "$APP_DIR/scripts/mac/atem-logger"
ln -sf "$APP_DIR/scripts/mac/atem-logger" /usr/local/bin/atem-logger

# 6. Menu-bar icon, started at login for the service user. It runs straight from the app folder,
#    so app updates also update the icon. It restarts if killed (e.g. after an update) unless you Quit it.
TRAY_APP="$APP_DIR/tray/mac/ATEM Logger.app"
TRAY_PLIST="$SVC_HOME/Library/LaunchAgents/$LABEL.tray.plist"
if [ -d "$TRAY_APP" ]; then
  launchctl bootout "gui/$SVC_UID/$LABEL.tray" 2>/dev/null || true
  pkill -x ATEMLoggerTray 2>/dev/null || true
  xattr -dr com.apple.quarantine "$TRAY_APP" 2>/dev/null || true
  mkdir -p "$SVC_HOME/Library/LaunchAgents"
  cat > "$TRAY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL.tray</string>
  <key>ProgramArguments</key><array><string>$TRAY_APP/Contents/MacOS/ATEMLoggerTray</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
EOF
  chown "$SVC_USER":staff "$TRAY_PLIST"
  launchctl bootstrap "gui/$SVC_UID" "$TRAY_PLIST" 2>/dev/null || true   # start now if logged in
fi

# 7. (Re)start the service.
launchctl bootout "system/$LABEL" 2>/dev/null || true
sleep 1
launchctl enable "system/$LABEL"
launchctl bootstrap system "$PLIST"
echo "Service installed: $LABEL (runs as $SVC_USER, port $PORT)"
