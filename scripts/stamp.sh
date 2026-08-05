#!/usr/bin/env bash
# Writes build.json describing the commit currently checked out.
#
# The extension re-reads this file from disk while it is running. That is how it
# notices a `git pull` (or your own commit) and reloads itself, so this file is
# the whole mechanism behind "always up to date".
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "stamp: not a git checkout, skipping build.json" >&2
  exit 0
fi

SHA=$(git rev-parse HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)
DIRTY=false
if ! git -c core.fileMode=false diff --quiet 2>/dev/null || ! git -c core.fileMode=false diff --cached --quiet 2>/dev/null; then DIRTY=true; fi

cat > build.json <<EOF
{
  "sha": "$SHA",
  "shortSha": "${SHA:0:7}",
  "branch": "$BRANCH",
  "version": "$VERSION",
  "dirty": $DIRTY,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "stamp: ${SHA:0:7} on $BRANCH (v$VERSION)"
