#!/bin/bash
# Double-click to stop ATEM Logger and remove it from login items.
cd "$(dirname "$0")"
bash scripts/uninstall-mac.sh
echo
read -n 1 -s -r -p "Press any key to close this window…"
