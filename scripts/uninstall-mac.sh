#!/bin/bash
# ATEM Logger — remove the macOS service, menu-bar icon and `atem-logger` command.
# Settings (~/.atem-logger) and EDL files are kept; delete the app folder yourself if you want it gone.
cd "$(dirname "$0")/.."
echo "Removing the ATEM Logger service — enter your Mac password if asked."
if [ -t 0 ]; then
  sudo bash "$(pwd)/scripts/mac/uninstall-service.sh" "$USER"
else
  /usr/bin/osascript -e "do shell script \"bash '$(pwd)/scripts/mac/uninstall-service.sh' '$USER'\" with administrator privileges"
fi
