#!/bin/bash
# Removes the ATEM Logger service, CLI and sudoers rule. Must run as root:
#   sudo bash scripts/mac/uninstall-service.sh <user>
[ "$(id -u)" = 0 ] || { echo "uninstall-service.sh must run as root (sudo)"; exit 1; }
SVC_USER="$1"
LABEL="com.atem-logger"
launchctl bootout "system/$LABEL" 2>/dev/null && echo "Stopped the service." || true
rm -f "/Library/LaunchDaemons/$LABEL.plist" /etc/sudoers.d/atem-logger
[ -L /usr/local/bin/atem-logger ] && rm -f /usr/local/bin/atem-logger
if [ -n "$SVC_USER" ]; then
  SVC_UID="$(id -u "$SVC_USER" 2>/dev/null)"
  SVC_HOME="$(dscl . -read "/Users/$SVC_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [ -n "$SVC_UID" ] && launchctl bootout "gui/$SVC_UID/$LABEL.tray" 2>/dev/null
  [ -n "$SVC_UID" ] && launchctl bootout "gui/$SVC_UID/$LABEL" 2>/dev/null
  [ -n "$SVC_HOME" ] && rm -f "$SVC_HOME/Library/LaunchAgents/$LABEL.tray.plist" "$SVC_HOME/Library/LaunchAgents/$LABEL.plist"
fi
pkill -x ATEMLoggerTray 2>/dev/null || true
echo "ATEM Logger service, tray icon and command removed. Settings in ~/.atem-logger were kept."
