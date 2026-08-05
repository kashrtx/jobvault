#!/usr/bin/env python3
"""
JobVault updater helper.

Optional. Without it, updating is `./scripts/update.sh` and the extension
reloads itself. With it, the Update now button in the dashboard does the pull
too, so updating never leaves the browser.

It speaks Chrome's native messaging protocol on stdin/stdout: a 4-byte
little-endian length followed by that many bytes of JSON.

Deliberately narrow. It accepts two actions, it only ever runs git inside its
own checkout, and the branch name is validated before it reaches a command line.
"""

import json
import os
import re
import struct
import subprocess
import sys
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAFE_BRANCH = re.compile(r"^[A-Za-z0-9._/-]{1,120}$")
TIMEOUT = 120


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack("<I", header)[0]
    if length > 1_000_000:
        return None
    body = sys.stdin.buffer.read(length)
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def write_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def git(*args):
    return subprocess.run(
        ["git", *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )


def head_sha():
    r = git("rev-parse", "HEAD")
    return r.stdout.strip() if r.returncode == 0 else ""


def manifest_version():
    try:
        with open(os.path.join(REPO, "manifest.json"), encoding="utf-8") as fh:
            return json.load(fh).get("version", "")
    except (OSError, ValueError):
        return ""


def is_dirty():
    # Mode-only differences (a chmod after unzipping) are not uncommitted work.
    return (
        git("-c", "core.fileMode=false", "diff", "--quiet").returncode != 0
        or git("-c", "core.fileMode=false", "diff", "--cached", "--quiet").returncode != 0
    )


def stamp():
    sha = head_sha()
    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
    payload = {
        "sha": sha,
        "shortSha": sha[:7],
        "branch": branch,
        "version": manifest_version(),
        "dirty": is_dirty(),
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    with open(os.path.join(REPO, "build.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    return payload


def do_status():
    return {"ok": True, "repo": REPO, "build": stamp(), "dirty": is_dirty()}


def verify_tree():
    """
    Checks the checkout is loadable. Returns (ok, problems).

    Stamping build.json is what makes the running extension reload, so a broken
    commit must never get that far. Same reasoning as scripts/verify.sh, done in
    Python so it works identically on Windows.
    """
    problems = []
    manifest_path = os.path.join(REPO, "manifest.json")
    data = None
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        problems.append("manifest.json is missing")
    except ValueError as exc:
        problems.append(f"manifest.json is not valid JSON: {exc}")

    if data is not None:
        refs = set()

        def walk(node):
            if isinstance(node, str):
                if node.endswith((".js", ".html", ".css", ".png", ".json")):
                    refs.add(node)
            elif isinstance(node, dict):
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(data)
        for ref in sorted(refs):
            if not os.path.exists(os.path.join(REPO, ref)):
                problems.append(f"missing file named in the manifest: {ref}")

    for required in ("background.js", "content.js", "popup.html", "dashboard.html"):
        if not os.path.exists(os.path.join(REPO, required)):
            problems.append(f"{required} is missing")

    return (not problems), problems


def do_pull(branch, force=False):
    if git("rev-parse", "--git-dir").returncode != 0:
        return {"ok": False, "error": f"{REPO} is not a git checkout, so there is nothing to pull."}
    if not SAFE_BRANCH.match(branch):
        return {"ok": False, "error": "That branch name is not one I will pass to git."}

    fetched = git("fetch", "origin", branch)
    if fetched.returncode != 0:
        return {"ok": False, "error": "git fetch failed: " + (fetched.stderr.strip()[:400] or "unknown error")}

    before = head_sha()
    remote = git("rev-parse", f"origin/{branch}").stdout.strip()
    if not remote:
        return {"ok": False, "error": f"origin/{branch} does not exist."}

    if before == remote:
        return {"ok": True, "changed": False, "message": f"Already on {before[:7]}.", "build": stamp()}

    if is_dirty() and not force:
        return {
            "ok": False,
            "error": "There are uncommitted changes in the checkout. Commit or stash them, then try again.",
        }

    step = git("reset", "--hard", f"origin/{branch}") if force else git("merge", "--ff-only", f"origin/{branch}")
    if step.returncode != 0:
        return {
            "ok": False,
            "error": "Could not fast-forward. Your branch has commits that are not on the remote: "
            + (step.stderr.strip()[:300] or "unknown error"),
        }

    ok, problems = verify_tree()
    if not ok:
        # Put the working version back and do not stamp, so the browser carries on
        # with the build it already has instead of reloading into a broken one.
        git("reset", "--hard", before)
        stamp()
        return {
            "ok": False,
            "rolledBack": True,
            "error": "The new commit does not look loadable, so it was rolled back and not applied: "
            + "; ".join(problems[:4]),
        }

    log = git("log", "--oneline", f"{before}..{head_sha()}")
    subjects = [line for line in log.stdout.strip().splitlines() if line][:20]
    return {
        "ok": True,
        "changed": True,
        "message": f"Pulled {len(subjects)} commit{'' if len(subjects) == 1 else 's'} up to {head_sha()[:7]}.",
        "commits": subjects,
        "build": stamp(),
    }


def main():
    msg = read_message()
    if msg is None:
        write_message({"ok": False, "error": "No readable request."})
        return
    action = msg.get("action")
    try:
        if action == "pull":
            write_message(do_pull(msg.get("branch") or "main", bool(msg.get("force"))))
        elif action == "status":
            write_message(do_status())
        else:
            write_message({"ok": False, "error": f"Unknown action: {action}"})
    except subprocess.TimeoutExpired:
        write_message({"ok": False, "error": "git took too long and was stopped."})
    except Exception as exc:  # a crash here would look like a silent failure in the UI
        write_message({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
