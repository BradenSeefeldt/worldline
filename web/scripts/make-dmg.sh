#!/bin/bash
# Package the built app as a disk image: open it, drag the app onto the Applications folder. (Tauri can make one too,
# but it drives Finder with AppleScript to style the window, which needs extra permissions; this is plain hdiutil.)
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=$(node -p "require('./src-tauri/tauri.conf.json').productName")
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP="src-tauri/target/release/bundle/macos/$NAME.app"
[ -d "$APP" ] || { echo "No $APP — run: npm run app:build" >&2; exit 1; }
mkdir -p release
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
OUT="release/$NAME-$VERSION.dmg"
rm -f "$OUT"
hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$OUT"
rm -rf "$STAGE"
echo "Made $OUT"
