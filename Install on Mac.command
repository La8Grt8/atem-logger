#!/bin/bash
# Double-click to install ATEM Logger on this Mac.
cd "$(dirname "$0")"
bash scripts/install-mac.sh
echo
read -n 1 -s -r -p "Press any key to close this window…"
