#!/usr/bin/env bash
# Checks that this folder is a loadable extension.
#
# Run before stamping build.json. The stamp is what tells the running extension
# to reload, so stamping a broken tree is how you turn a bad commit into a
# browser that cannot load JobVault at all. Verify first, stamp second.
#
# Exit 0 = safe to load. Exit 1 = do not stamp.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0
note() { printf '  %s\n' "$1"; }

# 1. The manifest has to be valid JSON, or Chrome rejects the extension outright.
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import json,sys; json.load(open('manifest.json'))" 2>/dev/null; then
    note "manifest.json is not valid JSON"
    fail=1
  fi
elif command -v node >/dev/null 2>&1; then
  if ! node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))" 2>/dev/null; then
    note "manifest.json is not valid JSON"
    fail=1
  fi
fi

# 2. Every file the manifest names must exist.
if [ "$fail" -eq 0 ] && command -v python3 >/dev/null 2>&1; then
  missing=$(python3 - <<'PY'
import json, os
refs = set()
def walk(o):
    if isinstance(o, str):
        if o.endswith((".js", ".html", ".css", ".png", ".json")):
            refs.add(o)
    elif isinstance(o, dict):
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(json.load(open("manifest.json")))
print(" ".join(sorted(r for r in refs if not os.path.exists(r))))
PY
)
  if [ -n "$missing" ]; then
    note "files named in the manifest are missing: $missing"
    fail=1
  fi
fi

# 3. Every script must parse. A syntax error in the service worker means the
#    extension loads but does nothing, which is harder to diagnose than a
#    refusal, so it is worth catching here.
if command -v node >/dev/null 2>&1; then
  for f in background.js content.js popup.js dashboard.js lib/*.js; do
    [ -f "$f" ] || continue
    if ! node --check "$f" >/dev/null 2>&1; then
      note "$f has a syntax error"
      fail=1
    fi
  done
else
  note "node is not installed, so scripts were not syntax checked"
fi

# 4. The entry points have to be there whether or not the manifest names them.
for f in manifest.json background.js content.js popup.html dashboard.html; do
  if [ ! -f "$f" ]; then
    note "$f is missing"
    fail=1
  fi
done

# 5. Event handlers must not use a concise arrow body that can evaluate to false.
#    `el.onkeydown = (e) => e.key === "Enter" && go()` returns false on every
#    other key, and a DOM0 handler returning false cancels the keystroke, so the
#    field silently refuses to accept typing. It is valid JavaScript, so nothing
#    above catches it.
if command -v grep >/dev/null 2>&1; then
  # After the arrow, the first non-space character must be a brace. Without the
  # [[:space:]] class the space itself satisfies [^{] and the check flags correct
  # code as broken, which is how the first version of this rule failed.
  hits=$(grep -rnE '\.on[a-z]+[[:space:]]*=[[:space:]]*\([^)]*\)[[:space:]]*=>[[:space:]]*[^{[:space:]].*(&&|\|\||===)' -- *.js 2>/dev/null || true)
  if [ -n "$hits" ]; then
    note "event handler with a concise arrow body that can return false:"
    printf '%s\n' "$hits" | sed 's/^/    /'
    note "wrap the body in braces so nothing is returned"
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "verify: this tree is NOT safe to load"
  exit 1
fi
echo "verify: tree looks loadable"
exit 0
