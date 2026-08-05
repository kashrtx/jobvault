#!/usr/bin/env bash
# Installs git hooks that restamp build.json whenever the checkout moves.
#
# Run this once. After that, your own commits, merges, pulls and branch switches
# all restamp automatically, which means the running extension notices and
# reloads itself. Edit code, commit, and the browser picks it up.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git checkout. Nothing to install."
  exit 1
fi

HOOKS="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS"

for hook in post-commit post-merge post-checkout post-rewrite; do
  target="$HOOKS/$hook"
  if [ -f "$target" ] && ! grep -q "jobvault-stamp" "$target" 2>/dev/null; then
    echo "Skipping $hook, you already have one. Add this line to it yourself:"
    echo "  \"\$(git rev-parse --show-toplevel)/scripts/stamp.sh\" >/dev/null 2>&1 || true  # jobvault-stamp"
    continue
  fi
  cat > "$target" <<'HOOK'
#!/usr/bin/env bash
# jobvault-stamp: keeps build.json in step with HEAD so the extension can tell
# when the folder on disk has changed and reload itself.
#
# Verifies first. Stamping is what triggers the reload, so stamping a commit that
# does not parse would push a broken extension into the running browser. If the
# check fails the stamp is skipped and the browser keeps the version it has.
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -x "$root/scripts/stamp.sh" ] || exit 0
if [ -x "$root/scripts/verify.sh" ] && ! "$root/scripts/verify.sh" >/dev/null 2>&1; then
  echo "jobvault: this commit does not look loadable, so the extension was not"
  echo "jobvault: told to reload. Run ./scripts/verify.sh to see what is wrong."
  exit 0
fi
"$root/scripts/stamp.sh" >/dev/null 2>&1
exit 0
HOOK
  chmod +x "$target"
  echo "Installed $hook"
done

./scripts/stamp.sh
echo
echo "Done. build.json now tracks HEAD automatically."
