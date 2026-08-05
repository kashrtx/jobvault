#!/usr/bin/env bash
# Pull the latest JobVault and let the extension reload itself.
#
#   ./scripts/update.sh            update the current branch
#   ./scripts/update.sh main       update a specific branch
#   ./scripts/update.sh main force discard local changes and take the remote
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
HERE=$(pwd)

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "This folder is not a git checkout, so there is nothing to pull."
  echo "Clone the repo and load that folder in your browser instead:"
  echo "  git clone https://github.com/kashrtx/jobvault.git"
  exit 1
fi

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
FORCE="${2:-}"

echo "Fetching origin/$BRANCH ..."
git fetch --quiet origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already on the latest commit (${LOCAL:0:7})."
  ./scripts/stamp.sh
  exit 0
fi

DIRTY=false
# core.fileMode=false so a chmod (which a downloaded zip makes necessary)
# does not read as "you have uncommitted work" and block the update.
if ! git -c core.fileMode=false diff --quiet || ! git -c core.fileMode=false diff --cached --quiet; then DIRTY=true; fi

if [ "$DIRTY" = true ] && [ "$FORCE" != "force" ]; then
  echo
  echo "You have uncommitted changes in $HERE."
  echo "Commit them, stash them, or run:"
  echo "  ./scripts/update.sh $BRANCH force     # throws your local edits away"
  exit 1
fi

echo "Updating ${LOCAL:0:7} -> ${REMOTE:0:7}"
git --no-pager log --oneline "$LOCAL..$REMOTE" | sed 's/^/  /' || true

if [ "$FORCE" = "force" ]; then
  git reset --hard "origin/$BRANCH"
elif ! git merge --ff-only "origin/$BRANCH"; then
  echo
  echo "Your branch has commits that are not on origin/$BRANCH, so a fast-forward"
  echo "is not possible. Either push your work, or take the remote version with:"
  echo "  ./scripts/update.sh $BRANCH force"
  exit 1
fi

# Check the tree before stamping. The stamp is the signal that makes the running
# extension reload, so stamping a broken commit is what would turn a bad push
# into a browser that cannot load JobVault. Roll back instead.
if ! ./scripts/verify.sh; then
  echo
  echo "The pulled commit does not look loadable, so it was NOT applied."
  echo "Rolling back to ${LOCAL:0:7}, which was working."
  git reset --hard "$LOCAL" --quiet
  ./scripts/stamp.sh >/dev/null
  echo "Rolled back. Your browser keeps running the version it already had."
  exit 1
fi

./scripts/stamp.sh

echo
echo "Done. JobVault reloads itself within a minute, after finishing any save"
echo "that is in progress and taking a backup first."
echo "In a hurry: open JobVault -> Settings -> Reload the extension."
