#!/usr/bin/env bash
# Registers the optional updater helper with your browser.
#
#   ./scripts/install-updater.sh <extension-id>
#
# The extension id is shown in JobVault -> Settings once you tick the updater
# box, and on chrome://extensions with developer mode on. It is required because
# a native messaging host only answers the extensions it names.
#
# Uninstall:  ./scripts/install-updater.sh --remove
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO=$(pwd)
HOST_NAME="com.jobvault.updater"
SCRIPT="$REPO/native/jobvault_updater.py"

targets=()
case "$(uname -s)" in
  Darwin)
    base="$HOME/Library/Application Support"
    targets=(
      "$base/Google/Chrome/NativeMessagingHosts"
      "$base/Google/Chrome Beta/NativeMessagingHosts"
      "$base/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$base/Chromium/NativeMessagingHosts"
      "$base/Microsoft Edge/NativeMessagingHosts"
      "$base/Vivaldi/NativeMessagingHosts"
    )
    ;;
  Linux)
    targets=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      "$HOME/.config/vivaldi/NativeMessagingHosts"
    )
    ;;
  *)
    echo "This installer handles macOS and Linux. On Windows use scripts\\install-updater.ps1." >&2
    exit 1
    ;;
esac

if [ "${1:-}" = "--remove" ]; then
  for dir in "${targets[@]}"; do
    rm -f "$dir/$HOST_NAME.json" 2>/dev/null && echo "Removed from $dir"
  done
  echo "Done."
  exit 0
fi

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: ./scripts/install-updater.sh <extension-id>" >&2
  echo "Find the id in JobVault -> Settings, or on chrome://extensions." >&2
  exit 1
fi
if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "\"$EXT_ID\" does not look like an extension id (32 letters, a through p)." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is not on your PATH. The helper needs it; install Python 3 and re-run." >&2
  exit 1
fi

chmod +x "$SCRIPT"

manifest=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "JobVault git updater",
  "path": "$SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

installed=0
for dir in "${targets[@]}"; do
  parent=$(dirname "$dir")
  # Only register with browsers that are actually installed, so we do not create
  # profile folders for browsers this machine has never run.
  [ -d "$parent" ] || continue
  mkdir -p "$dir"
  printf '%s\n' "$manifest" > "$dir/$HOST_NAME.json"
  echo "Installed -> $dir/$HOST_NAME.json"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "No Chromium browser profiles found in the usual places." >&2
  echo "Copy this manifest into your browser's NativeMessagingHosts folder by hand:" >&2
  printf '%s\n' "$manifest"
  exit 1
fi

echo
echo "Registered with $installed browser profile(s)."
echo "Restart the browser, then use Update now in JobVault -> Settings."
