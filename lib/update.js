// Update checking against a GitHub repo.
//
// This is the only part of JobVault that touches a network, it only ever talks
// to github.com, it sends nothing but the repo name, and it can be switched off
// in Settings. Nothing from the vault is transmitted.
//
// A browser extension cannot rewrite its own files, so "updating" means getting
// the new commit onto disk (git pull, or the optional updater helper) and then
// reloading the extension. This module's job is to notice that a newer commit
// exists and to know exactly what is currently on disk.

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

export const DEFAULT_REPO = "kashrtx/jobvault";
export const DEFAULT_BRANCH = "main";

export function semverCmp(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * What is actually on disk right now.
 *
 * For an unpacked extension the browser serves extension resources straight
 * from the folder, so re-fetching build.json with a cache buster reflects a
 * `git pull` that happened after the extension started. That is what makes the
 * auto-reload watcher possible.
 */
export async function readBuild() {
  try {
    const res = await fetch(chrome.runtime.getURL("build.json") + "?t=" + Date.now(), {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("no build.json");
    const b = await res.json();
    return { sha: b.sha || "", builtAt: b.builtAt || "", branch: b.branch || DEFAULT_BRANCH, version: b.version || "" };
  } catch {
    return { sha: "", builtAt: "", branch: DEFAULT_BRANCH, version: "" };
  }
}

function headers(token) {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghJSON(url, token) {
  const res = await fetch(url, { headers: headers(token), cache: "no-store" });
  if (res.status === 404) {
    const e = new Error(
      "GitHub returned 404. Either the repo name is wrong, or it is private and needs a token."
    );
    e.code = "notfound";
    throw e;
  }
  if (res.status === 401 || res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const e = new Error(
      remaining === "0"
        ? "GitHub rate limit reached. It resets within the hour, or add a token to raise the limit."
        : "GitHub refused the request. If the repo is private, check the token."
    );
    e.code = "auth";
    throw e;
  }
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);
  return res.json();
}

/**
 * Look up the head of the branch plus the version in the repo's manifest.
 * Returns `{ ok:false, error }` rather than throwing, so a failed check never
 * takes down the alarm that scheduled it.
 */
export async function fetchRemote({ repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, token = "" } = {}) {
  try {
    const commit = await ghJSON(`${API}/repos/${repo}/commits/${encodeURIComponent(branch)}`, token);
    const sha = commit.sha || "";
    let version = "";
    try {
      // Read the manifest at that exact commit so version and sha always agree.
      const url = token
        ? `${API}/repos/${repo}/contents/manifest.json?ref=${sha}`
        : `${RAW}/${repo}/${sha}/manifest.json`;
      if (token) {
        const file = await ghJSON(url, token);
        version = JSON.parse(atob(String(file.content || "").replace(/\n/g, ""))).version || "";
      } else {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) version = (await res.json()).version || "";
      }
    } catch {
      /* version is a nicety; the sha is what matters */
    }
    return {
      ok: true,
      sha,
      shortSha: sha.slice(0, 7),
      version,
      subject: String(commit.commit?.message || "").split("\n")[0],
      author: commit.commit?.author?.name || "",
      date: commit.commit?.author?.date || "",
      url: commit.html_url || `https://github.com/${repo}/commits/${branch}`,
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || "error" };
  }
}

/** Commit subjects between what is on disk and the branch head. */
export async function commitsSince({ repo = DEFAULT_REPO, base, head, token = "" }) {
  if (!base || !head || base === head) return [];
  try {
    const cmp = await ghJSON(`${API}/repos/${repo}/compare/${base}...${head}`, token);
    return (cmp.commits || [])
      .slice(-25)
      .reverse()
      .map((c) => ({
        sha: (c.sha || "").slice(0, 7),
        subject: String(c.commit?.message || "").split("\n")[0],
        date: c.commit?.author?.date || "",
        url: c.html_url || "",
      }));
  } catch {
    return [];
  }
}

/**
 * Full status: what is installed, what is on the branch, and whether the gap is
 * something the user needs to act on.
 */
export async function checkForUpdate(cfg = {}) {
  const installedVersion = chrome.runtime.getManifest().version;
  const build = await readBuild();
  const remote = await fetchRemote(cfg);

  const base = {
    checkedAt: Date.now(),
    installedVersion,
    installedSha: build.sha,
    installedShortSha: build.sha.slice(0, 7),
    builtAt: build.builtAt,
    repo: cfg.repo || DEFAULT_REPO,
    branch: cfg.branch || DEFAULT_BRANCH,
  };

  if (!remote.ok) return { ...base, ok: false, error: remote.error, code: remote.code, behind: false };

  const versionNewer = remote.version ? semverCmp(remote.version, installedVersion) > 0 : false;
  // If build.json is missing we cannot compare commits, so fall back to version
  // alone rather than claiming an update that may not exist.
  const shaDiffers = Boolean(build.sha && remote.sha && build.sha !== remote.sha);
  const behind = versionNewer || shaDiffers;

  const commits = behind ? await commitsSince({ repo: base.repo, base: build.sha, head: remote.sha, token: cfg.token }) : [];

  return {
    ...base,
    ok: true,
    behind,
    reason: versionNewer ? "version" : shaDiffers ? "commit" : "",
    latestVersion: remote.version,
    latestSha: remote.sha,
    latestShortSha: remote.shortSha,
    latestSubject: remote.subject,
    latestDate: remote.date,
    latestUrl: remote.url,
    commits,
    knowsLocalSha: Boolean(build.sha),
  };
}
