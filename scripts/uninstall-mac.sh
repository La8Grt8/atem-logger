#!/bin/bash
# ATEM Logger — remove the macOS background service. Your settings (~/.atem-logger)
# and EDL files are left in place; delete the app folder yourself if you want it gone.
LABEL="com.atem-logger"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Stopped ATEM Logger." || echo "ATEM Logger was not running."
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed it from login items. Settings kept in ~/.atem-logger"
