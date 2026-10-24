#!/bin/bash
# Builds "ATEM Logger.app" (menu-bar icon) as a universal binary into tray/mac/ATEM Logger.app
# Requires Xcode Command Line Tools (swiftc). A prebuilt copy is committed to the repo.
set -e
cd "$(dirname "$0")"
APP="ATEM Logger.app"
TMP="$(mktemp -d)"
swiftc -O -target arm64-apple-macos13 -o "$TMP/arm64" main.swift
swiftc -O -target x86_64-apple-macos13 -o "$TMP/x86_64" main.swift
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
lipo -create -output "$APP/Contents/MacOS/ATEMLoggerTray" "$TMP/arm64" "$TMP/x86_64"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
rm -rf "$TMP"
echo "Built $(pwd)/$APP"
