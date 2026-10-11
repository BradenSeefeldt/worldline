#!/bin/sh
# Install (or update) Worldline, the Mac app, from the newest published release:
#   curl -fsSL https://bradenseefeldt.github.io/worldline/install.sh | sh
# It downloads Worldline.dmg, copies Worldline.app into /Applications (or ~/Applications if that isn't writable), and
# opens it. Files downloaded by Terminal aren't flagged by macOS, so there's no "Open Anyway" step. A Worldline
# already there is moved to the Trash (never deleted). Published on GitHub Pages by vite.guest.config.ts.
#
# Everything is inside main(), called on the last line: if the download of this script is cut short, nothing runs.
set -eu

main() {
  url="${WORLDLINE_DMG:-https://github.com/BradenSeefeldt/worldline/releases/latest/download/Worldline.dmg}" # (override: testing)

  if [ "$(uname -s)" != "Darwin" ]; then
    echo "Worldline's app is for macOS. On an iPhone, open https://bradenseefeldt.github.io/worldline/app/ in Safari."
    exit 1
  fi
  if pgrep -f "/Worldline.app/Contents/MacOS/" >/dev/null 2>&1; then
    echo "Worldline is open. Quit it first (Worldline → Quit, or ⌘Q), then run this again."
    exit 1
  fi

  dest="${WORLDLINE_DEST:-/Applications}"
  [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
  tmp=$(mktemp -d)
  trap 'hdiutil detach -quiet "$tmp/mnt" 2>/dev/null || true; rm -rf "$tmp" "$dest/Worldline.app.new"' EXIT INT TERM

  echo "Downloading Worldline…"
  curl -fL --progress-bar -o "$tmp/Worldline.dmg" "$url"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$tmp/mnt" "$tmp/Worldline.dmg"
  [ -d "$tmp/mnt/Worldline.app" ] || { echo "The download doesn't contain Worldline.app — try again later."; exit 1; }

  ditto "$tmp/mnt/Worldline.app" "$dest/Worldline.app.new"
  if [ -e "$dest/Worldline.app" ]; then
    old="$HOME/.Trash/Worldline $(date +%Y-%m-%d\ %H.%M.%S).app"
    mv "$dest/Worldline.app" "$old"
    echo "The previous Worldline.app is in the Trash."
  fi
  mv "$dest/Worldline.app.new" "$dest/Worldline.app"

  echo "Installed in $dest. Opening Worldline…"
  open "$dest/Worldline.app"
}

main "$@"
