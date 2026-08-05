import {
  deriveKey, exportRawKey, importRawKey, encryptJSON, decryptJSON,
  newSalt, randomKey, generatePassword, entropyBits,
  DEFAULT_ITERATIONS, LEGACY_ITERATIONS,
} from "./lib/crypto.js";
import { computeMatch } from "./lib/match.js";
import { normalizeProfile, emptyProfile, fillValues, completeness } from "./lib/profile.js";
import { checkForUpdate, readBuild, DEFAULT_REPO, DEFAULT_BRANCH } from "./lib/update.js";
import { ATS, atsName, originPattern, hostOf as siteHostOf } from "./lib/sites.js";

const K_META = "jv_meta";
const K_VAULT = "jv_vault";
const K_UPDATE = "jv_update";
const K_BOOT = "jv_boot_sha";
const K_SNAP = "jv_snap_";        // one key per rolling backup
const K_SAFETY = "jv_safety";     // last export, last snapshot, read failures
const S_KEY = "jv_key";
const S_PENDING = "jv_pending";
const S_DEADLINE = "jv_lock_at";
const MAX_PIN_FAILS = 5;

// Bumping this means older builds must refuse to touch newer vaults rather than
// normalize away fields they do not understand.
const VAULT_VERSION = 3;
const MAX_SNAPSHOTS = 12;

const NATIVE_HOST = "com.jobvault.updater";

const getLocal = (k) => chrome.storage.local.get(k).then((r) => r[k]);
const setLocal = (o) => chrome.storage.local.set(o);
const getSession = (k) => chrome.storage.session.get(k).then((r) => r[k]);
const setSession = (o) => chrome.storage.session.set(o);
const delSession = (k) => chrome.storage.session.remove(k);

const now = () => Date.now();
const DAY = 86400000;
const uid = () => crypto.randomUUID().slice(0, 12);

// ------------------------------------------------------------------ vault io

async function meta() { return getLocal(K_META); }

async function sessionDataKey() {
  const raw = await getSession(S_KEY);
  if (!raw) return null;
  if (await lockExpired()) { await hardLock(); return null; }
  try { return await importRawKey(raw); } catch { return null; }
}

/**
 * Every vault write runs one at a time.
 *
 * Without this, two read-modify-write cycles overlap and the slower one writes a
 * vault it read before the other's change existed, silently erasing it. That is
 * not a rare race: saving a job from a page while the dashboard autosaves a
 * profile edit is enough to trigger it.
 */
let writeChain = Promise.resolve();
let writesInFlight = 0;

function serialize(fn) {
  writesInFlight += 1;
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => { writesInFlight -= 1; },
    () => { writesInFlight -= 1; },
  );
  return run;
}

/** True while a vault write could still be in progress. Reloads wait for this. */
const vaultBusy = () => writesInFlight > 0;

class VaultTooNewError extends Error {}
class VaultUnreadableError extends Error {}

async function decryptVault(dek) {
  const blob = await getLocal(K_VAULT);
  if (!blob) return emptyVault();
  let raw;
  try {
    raw = await decryptJSON(dek, blob);
  } catch {
    // The ciphertext stays exactly where it is. A failed read must never become
    // a reason to write, or one bad decrypt turns into a wiped vault.
    await noteSafety({ lastReadFailAt: now() });
    throw new VaultUnreadableError("The vault could not be decrypted.");
  }
  if (Number(raw?.version) > VAULT_VERSION) {
    throw new VaultTooNewError(
      `This vault was written by a newer version of JobVault (v${raw.version}). ` +
      `Update the extension before opening it, so nothing is lost.`,
    );
  }
  return normalizeVault(raw);
}

async function readVault() {
  const dek = await sessionDataKey();
  if (!dek) return null;
  try { return await decryptVault(dek); } catch { return null; }
}

/** Read that reports why it failed, for callers that must not guess. */
async function readVaultStrict() {
  const dek = await sessionDataKey();
  if (!dek) throw new Error("Vault is locked.");
  return decryptVault(dek);
}

async function writeVault(vault) {
  const dek = await sessionDataKey();
  if (!dek) throw new Error("Vault is locked.");
  vault.updatedAt = now();
  vault.rev = Number(vault.rev || 0) + 1;
  await setLocal({ [K_VAULT]: await encryptJSON(dek, vault) });
  return vault;
}

/**
 * Read, mutate, write, serialized. Every writer goes through this, so a caller
 * always mutates the vault as it exists right now rather than a stale copy.
 */
async function mutate(fn) {
  return serialize(async () => {
    const vault = await readVaultStrict();
    const result = await fn(vault);
    await writeVault(vault);
    refreshBadge();
    return result;
  });
}

const DEFAULT_SETTINGS = {
  autofillLogins: true,
  autofillOnlyWhenSingleMatch: true,
  showFieldBadge: true,
  showDock: true,
  extraSites: [],
  autofillApplication: false,
  matchOnOpen: true,
  autoTrackApplications: true,
  followUpDays: 7,
  autolockMinutes: 15,
  avoidAmbiguous: true,
  genLength: 20,
};

const DEFAULT_UPDATES = {
  repo: DEFAULT_REPO,
  branch: DEFAULT_BRANCH,
  token: "",
  autoCheck: true,
  autoReload: true,
  nativeUpdater: false,
};

function emptyVault(defaultEmail = "") {
  const profile = emptyProfile();
  if (defaultEmail) {
    profile.emails = [defaultEmail];
    profile.defaultEmail = defaultEmail;
    profile.values.email = defaultEmail;
  }
  return {
    version: 3,
    logins: {},
    jobs: [],
    snippets: [],
    profile,
    resume: { text: "", updatedAt: 0, fileName: "" },
    settings: { ...DEFAULT_SETTINGS },
    updates: { ...DEFAULT_UPDATES },
    updatedAt: now(),
  };
}

/** Brings any older vault shape up to v3 without losing a byte of it. */
function normalizeVault(v) {
  // A missing or non-object vault has to come back as a usable empty one. Handing
  // the caller undefined here is how a corrupt storage read turns into a blank
  // screen instead of a working, if empty, vault.
  if (!v || typeof v !== "object" || Array.isArray(v)) return emptyVault();
  const out = { ...v };
  out.version = 3;
  out.logins = v.logins || v.entries || {};   // 1.x called them entries
  delete out.entries;
  out.jobs = Array.isArray(v.jobs) ? v.jobs : [];
  out.snippets = Array.isArray(v.snippets) ? v.snippets : [];
  out.resume = v.resume || { text: "", updatedAt: 0, fileName: "" };
  out.settings = { ...DEFAULT_SETTINGS, ...(v.settings || {}) };
  out.updates = { ...DEFAULT_UPDATES, ...(v.updates || {}) };

  // 1.x kept a bare `emails` array at the top level of the vault; 2.x has a full
  // profile with that list inside it. Gather every place an address could have
  // been recorded, because losing these means the user retypes all of them.
  const legacyEmails = [
    ...(Array.isArray(v.profile?.emails) ? v.profile.emails : []),
    ...(Array.isArray(v.emails) ? v.emails : []),
    ...(v.settings?.defaultEmail ? [v.settings.defaultEmail] : []),
    ...(v.defaultEmail ? [v.defaultEmail] : []),
    // Addresses only ever saved against a login still belong in the profile.
    ...Object.values(out.logins || {}).map((e) => e && e.email).filter(Boolean),
  ];
  const emails = [...new Set(legacyEmails.map((s) => String(s).trim()).filter(Boolean))];
  delete out.emails;
  out.profile = normalizeProfile({
    ...(v.profile || {}),
    emails,
    defaultEmail: v.profile?.defaultEmail || v.settings?.defaultEmail || v.defaultEmail || emails[0] || "",
  });

  for (const [host, e] of Object.entries(out.logins)) {
    e.id = e.id || uid();
    e.host = e.host || host;
    e.url = e.url || `https://${e.host}`;
    // 1.x never stored a company, so every row would otherwise render blank.
    // Derive one from the hostname and, for board URLs like /stripe, the path.
    if (!e.company) {
      let path = "";
      try { path = new URL(e.url).pathname; } catch { path = ""; }
      e.company = prettyCompany(e.host, path) || e.host;
    }
    e.aliases = Array.isArray(e.aliases) ? e.aliases : [];
    e.usedCount = e.usedCount || 0;
    e.createdAt = e.createdAt || now();
    e.updatedAt = e.updatedAt || e.createdAt;
  }
  for (const j of out.jobs) {
    j.id = j.id || uid();
    j.status = j.status || "saved";
    j.events = Array.isArray(j.events) ? j.events : [];
  }
  return out;
}

// ------------------------------------------------------------------ snapshots

/**
 * Rolling local backups.
 *
 * Each is the whole vault, encrypted with the same data key, under its own
 * storage key. They exist because the operations most likely to lose data are
 * the ones a person only performs once and cannot undo: importing the wrong
 * file, changing the master password, restoring, or an update landing at a bad
 * moment. One is taken automatically before each of those, plus once a day.
 *
 * They live in the same profile as the vault, so they survive a bad update but
 * not an uninstall. The exported file is still the real offsite backup, and the
 * dashboard says so.
 */
async function noteSafety(patch) {
  const cur = (await getLocal(K_SAFETY)) || {};
  await setLocal({ [K_SAFETY]: { ...cur, ...patch } });
}

async function listSnapshots() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(K_SNAP))
    .map(([k, v]) => ({
      key: k,
      at: v?.at || 0,
      reason: v?.reason || "",
      counts: v?.counts || null,
      version: v?.version || 0,
      bytes: JSON.stringify(v?.blob || "").length,
    }))
    .sort((a, b) => b.at - a.at);
}

function vaultCounts(vault) {
  return {
    jobs: (vault.jobs || []).length,
    logins: Object.keys(vault.logins || {}).length,
    answers: (vault.snippets || []).length,
    profileFields: Object.values(vault.profile?.values || {}).filter(Boolean).length,
    resumeChars: (vault.resume?.text || "").length,
  };
}

/**
 * Takes a snapshot. Never throws into the caller: a backup that fails must not
 * block the operation it was protecting, but it must be recorded so the
 * dashboard can say the safety net is not there.
 */
async function snapshot(reason, vaultMaybe = null) {
  try {
    const dek = await sessionDataKey();
    if (!dek) return null;
    const vault = vaultMaybe || (await decryptVault(dek));
    const rec = {
      at: now(),
      reason,
      version: vault.version || VAULT_VERSION,
      rev: vault.rev || 0,
      counts: vaultCounts(vault),
      blob: await encryptJSON(dek, vault),
    };
    const key = K_SNAP + rec.at + "_" + uid().slice(0, 4);
    await setLocal({ [key]: rec });

    const all = await listSnapshots();
    const stale = all.slice(MAX_SNAPSHOTS).map((s) => s.key);
    if (stale.length) await chrome.storage.local.remove(stale);

    await noteSafety({ lastSnapshotAt: rec.at, snapshotError: "" });
    return key;
  } catch (err) {
    await noteSafety({ snapshotError: String(err?.message || err) });
    return null;
  }
}

/** At most one automatic snapshot a day, so routine edits do not churn storage. */
async function dailySnapshot() {
  const s = (await getLocal(K_SAFETY)) || {};
  if (s.lastSnapshotAt && now() - s.lastSnapshotAt < DAY) return;
  await snapshot("daily automatic backup");
}

async function restoreSnapshot(key) {
  return serialize(async () => {
    const dek = await sessionDataKey();
    if (!dek) throw new Error("Vault is locked.");
    const rec = await getLocal(key);
    if (!rec?.blob) throw new Error("That backup is no longer there.");
    const restored = normalizeVault(await decryptJSON(dek, rec.blob));
    // Snapshot the current state first, so restoring is itself undoable.
    const current = await decryptVault(dek).catch(() => null);
    if (current) await snapshot("replaced by a restore", current);
    restored.rev = Number(current?.rev || 0) + 1;
    await writeVault(restored);
    refreshBadge();
    return vaultCounts(restored);
  });
}

// ------------------------------------------------------------------ locking

async function lockExpired() {
  const at = await getSession(S_DEADLINE);
  return Boolean(at && now() > at);
}

async function armAutolock() {
  const m = (await meta()) || {};
  const minutes = m.autolockMinutes ?? DEFAULT_SETTINGS.autolockMinutes;
  if (!minutes || minutes <= 0) {
    await setSession({ [S_DEADLINE]: 0 });
    return chrome.alarms.clear("autolock");
  }
  await setSession({ [S_DEADLINE]: now() + minutes * 60000 });
  chrome.alarms.create("autolock", { delayInMinutes: minutes });
}

async function hardLock() {
  await delSession(S_KEY);
  await delSession(S_DEADLINE);
  chrome.alarms.clear("autolock");
  refreshBadge();
}

// --------------------------------------------------------- host / url logic

const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp",
  "co.in", "co.za", "com.br", "com.mx", "com.sg", "com.hk", "co.kr", "com.tr", "on.ca", "qc.ca",
]);

function baseDomain(host) {
  const p = String(host || "").toLowerCase().split(".");
  if (p.length <= 2) return p.join(".");
  const last2 = p.slice(-2).join(".");
  return MULTI_SUFFIX.has(last2) ? p.slice(-3).join(".") : last2;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/**
 * The whole reason this extension exists: every employer gets its own Workday
 * address, and the tenant is the only part that differs. Splitting it out lets
 * the interface show you which company a credential actually belongs to.
 */
export function tenantParts(host) {
  const h = String(host || "").toLowerCase();
  const labels = h.split(".");
  const workday = /myworkdayjobs\.com$|myworkdaysite\.com$|\.wd\d+\./.test(h);
  if (workday && labels.length > 2 && labels[0] !== "www") {
    return { tenant: labels[0], rest: "." + labels.slice(1).join("."), ats: "Workday" };
  }
  const generic = { tenant: labels.length > 2 && labels[0] !== "www" ? labels[0] : labels[0], rest: "", ats: "" };
  const idx = h.indexOf(generic.tenant);
  return { tenant: generic.tenant, rest: h.slice(idx + generic.tenant.length), ats: "" };
}

function prettyCompany(host, pathname = "") {
  const h = String(host || "").toLowerCase();
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const labels = h.split(".");
  if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(h)) {
    const first = labels[0];
    if (first && first !== "www" && !/^wd\d+$/.test(first)) return cap(first);
    const seg = pathname.split("/").filter(Boolean).find((s) => s.length > 2 && !/^en(-|_)/i.test(s));
    if (seg) return cap(seg.replace(/careers?$|externalcareersite$/i, "").replace(/[-_]/g, " ").trim());
  }
  // job-board hosts carry the company in the path, not the hostname
  if (/greenhouse\.io$|lever\.co$|ashbyhq\.com$|smartrecruiters\.com$|workable\.com$|teamtailor\.com$|breezy\.hr$|recruitee\.com$|jobvite\.com$|bamboohr\.com$/.test(h)) {
    const seg = pathname.split("/").filter(Boolean)[0];
    if (seg && !/^(en|jobs|embed|o|j|careers|api)$/i.test(seg)) return cap(seg.replace(/[-_]/g, " "));
    const sub = labels[0];
    if (sub && !["www", "jobs", "boards", "job-boards", "apply", "careers"].includes(sub)) return cap(sub);
  }
  const known = ["com", "org", "net", "io", "co", "ai", "app", "jobs", "careers"];
  let main = labels[labels.length - 2] || labels[0];
  if (labels.length >= 3 && known.includes(labels[labels.length - 2])) main = labels[labels.length - 3];
  if (["www", "jobs", "careers", "apply", "boards"].includes(main) && labels.length >= 3) {
    main = labels[labels.length - 2];
  }
  return cap(main);
}

/** Ranked credential candidates for a URL. Exact host always wins. */
function candidatesFor(vault, url) {
  const host = hostOf(url);
  if (!host) return [];
  const out = [];
  for (const e of Object.values(vault.logins || {})) {
    const eh = String(e.host || "").toLowerCase();
    if (eh === host) { out.push({ entry: e, rank: 0, why: "exact" }); continue; }
    if ((e.aliases || []).some((a) => String(a).toLowerCase() === host)) {
      out.push({ entry: e, rank: 1, why: "alias" }); continue;
    }
    if (eh && baseDomain(eh) === baseDomain(host)) {
      // Workday tenants share a base domain, so never treat a different tenant
      // as the same account. That mix-up is the bug this product was built for.
      const a = tenantParts(eh), b = tenantParts(host);
      if (a.ats === "Workday" || b.ats === "Workday") {
        if (a.tenant === b.tenant) out.push({ entry: e, rank: 2, why: "same-tenant" });
        continue;
      }
      out.push({ entry: e, rank: 3, why: "same-domain" });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || (b.entry.usedCount || 0) - (a.entry.usedCount || 0));
}

function normalizeJobUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (/^(gh_jid|jobid|job_id|id|req|reqid|posting|jk|lever|jobId)$/i.test(k)) keep.set(k, v);
    }
    u.search = keep.toString();
    u.pathname = u.pathname.replace(/\/+$/, "").replace(/^\/(en-[A-Za-z]{2}|en|fr-CA)\//i, "/");
    return u.origin + u.pathname + (u.search ? "?" + u.search : "");
  } catch { return url; }
}

function findJob(vault, { url, id }) {
  if (id) return vault.jobs.find((j) => j.id === id) || null;
  const norm = normalizeJobUrl(url || "");
  return vault.jobs.find((j) => normalizeJobUrl(j.url || "") === norm) || null;
}

// ------------------------------------------------------------------- badge

let badgeBusy = false;
async function refreshBadge() {
  if (badgeBusy) return;
  badgeBusy = true;
  try {
    const upd = (await getLocal(K_UPDATE)) || {};
    if (upd.behind) {
      await chrome.action.setBadgeBackgroundColor({ color: "#d9a441" });
      await chrome.action.setBadgeText({ text: "\u2191" });
      await chrome.action.setTitle({ title: `JobVault \u2014 update available (${upd.latestShortSha || upd.latestVersion || ""})` });
      return;
    }
    const vault = await readVault();
    if (!vault) {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "JobVault \u2014 locked" });
      return;
    }
    const due = dueFollowUps(vault);
    await chrome.action.setBadgeBackgroundColor({ color: "#4fb6c4" });
    await chrome.action.setBadgeText({ text: due.length ? String(due.length) : "" });
    await chrome.action.setTitle({
      title: due.length ? `JobVault \u2014 ${due.length} application${due.length === 1 ? "" : "s"} to follow up` : "JobVault",
    });
  } catch { /* a locked or half-written vault must never break the icon */ }
  finally { badgeBusy = false; }
}

function dueFollowUps(vault) {
  const days = vault.settings?.followUpDays ?? 7;
  if (!days) return [];
  return vault.jobs.filter((j) => {
    if (j.status !== "applied") return false;
    if (j.followUpDone) return false;
    const at = j.followUpAt || (j.appliedAt ? j.appliedAt + days * DAY : 0);
    return at && now() >= at;
  });
}

// ------------------------------------------------------------------ updates

async function runUpdateCheck({ silent = true } = {}) {
  const vault = await readVault();
  const cfg = vault?.updates || DEFAULT_UPDATES;
  if (!cfg.autoCheck && silent) return (await getLocal(K_UPDATE)) || null;

  const status = await checkForUpdate({ repo: cfg.repo, branch: cfg.branch, token: cfg.token });
  const prev = (await getLocal(K_UPDATE)) || {};
  await setLocal({ [K_UPDATE]: status });
  refreshBadge();

  if (status.ok && status.behind && status.latestSha !== prev.notifiedSha) {
    await setLocal({ [K_UPDATE]: { ...status, notifiedSha: status.latestSha } });
    try {
      await chrome.notifications.create("jv-update", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "JobVault update available",
        message: status.latestSubject
          ? `${status.latestSubject} (${status.latestShortSha})`
          : `New commit on ${status.branch}`,
        buttons: [{ title: "Open JobVault" }],
      });
    } catch { /* notifications can be off at the OS level */ }
  }
  return status;
}

/**
 * Reloading the extension is how an update finishes, but it kills the service
 * worker and every open page instantly. Doing that while a write is in flight,
 * or while the dashboard is holding a debounced edit, loses whatever was in
 * flight. So a reload is a request, not an order.
 *
 * Order of events: ask open pages to flush, wait for the write queue to drain,
 * take a snapshot, then reload. If anything is still busy, back off and retry
 * rather than forcing it.
 */
let reloadPending = null;

async function requestReload({ reason = "an update", force = false } = {}) {
  reloadPending = { reason, since: reloadPending?.since || now(), attempts: (reloadPending?.attempts || 0) + 1 };

  // Ask any open popup or dashboard to write out pending edits now. They reply
  // when done; a page that is gone simply does not answer, which is fine.
  try {
    await Promise.race([
      chrome.runtime.sendMessage({ type: "jvFlushForReload", reason }).catch(() => {}),
      new Promise((r) => setTimeout(r, 600)),
    ]);
  } catch { /* no receivers */ }

  // Let the flush land, then wait for the queue.
  for (let i = 0; i < 20 && vaultBusy(); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (vaultBusy() && !force) {
    if (reloadPending.attempts < 10) {
      chrome.alarms.create("reloadRetry", { delayInMinutes: 0.5 });
      return { ok: false, deferred: true, reason: "a save is still in progress" };
    }
    // Ten deferrals over five minutes means something is stuck, not busy.
  }

  await snapshot(`before reloading for ${reason}`);
  reloadPending = null;
  chrome.runtime.reload();
  return { ok: true };
}

/**
 * Compares the commit on disk with the one this worker booted from. Unpacked
 * extensions serve files straight from the folder, so the running code can see a
 * new commit while the running code is still the old one. That gap is the signal
 * to reload, which is what turns `git pull` into a finished update.
 */
async function watchDisk() {
  const disk = await readBuild();
  if (!disk.sha) return;
  const boot = await getSession(K_BOOT);
  if (!boot) return setSession({ [K_BOOT]: disk.sha });
  if (disk.sha === boot) return;

  // A half-finished checkout can leave a stamp that does not match the files.
  // Waiting one cycle costs a minute and avoids reloading into a broken tree.
  const settled = await getSession("jv_disk_seen");
  if (settled !== disk.sha) {
    await setSession({ jv_disk_seen: disk.sha });
    return;
  }

  const vault = await readVault();
  // With the vault locked there is nothing to lose, so a locked browser is the
  // best possible moment to apply an update.
  if (vault && vault.updates?.autoReload === false) {
    await setLocal({ [K_UPDATE]: { ...((await getLocal(K_UPDATE)) || {}), diskSha: disk.sha, diskReady: true } });
    return refreshBadge();
  }
  await setSession({ [K_BOOT]: disk.sha });
  await requestReload({ reason: "a new commit on disk" });
}

async function nativeUpdate() {
  const has = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  if (!has) throw new Error("The updater helper needs the native messaging permission. Turn it on in Settings.");
  const vault = await readVault();
  const cfg = vault?.updates || DEFAULT_UPDATES;
  const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    action: "pull",
    branch: cfg.branch || DEFAULT_BRANCH,
  });
  if (!res) throw new Error("The updater helper did not respond. Run scripts/install-updater first.");
  if (!res.ok) throw new Error(res.error || "The updater helper could not pull.");
  return res;
}

// ------------------------------------------------------------------ routing

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg || {}, sender)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    // ------------------------------------------------------------ lifecycle
    case "getState": {
      const m = await meta();
      const dek = await sessionDataKey();
      const upd = (await getLocal(K_UPDATE)) || null;
      const safety = (await getLocal(K_SAFETY)) || {};
      let follow = 0, jobCount = 0, loginCount = 0, profilePct = 0;
      let readError = "";
      if (dek) {
        try {
          const v = await decryptVault(dek);
          follow = dueFollowUps(v).length;
          jobCount = v.jobs.length;
          loginCount = Object.keys(v.logins).length;
          profilePct = completeness(v.profile).pct;
        } catch (err) {
          // Say which problem it is. "Wrong password" for a vault written by a
          // newer build would send someone hunting for a password that was fine.
          readError = err instanceof VaultTooNewError
            ? err.message
            : "The vault is present but could not be read. Do not create a new one; restore a backup instead.";
        }
      }
      const snaps = dek ? await listSnapshots() : [];
      return {
        ok: true,
        hasVault: Boolean(m),
        unlocked: Boolean(dek),
        hasPin: Boolean(m && m.pin),
        pinLocked: Boolean(m && (m.pinFails || 0) >= MAX_PIN_FAILS),
        pinLength: m?.pin?.length || 0,
        needsRehardening: Boolean(m && (m.iterations || LEGACY_ITERATIONS) < DEFAULT_ITERATIONS),
        update: upd,
        counts: { follow, jobs: jobCount, logins: loginCount, profilePct },
        version: chrome.runtime.getManifest().version,
        vaultVersion: VAULT_VERSION,
        readError,
        extensionId: chrome.runtime.id,
        safety: {
          ...safety,
          snapshotCount: snaps.length,
          newestSnapshotAt: snaps[0]?.at || 0,
          hasLegacyBackup: Boolean(await getLocal("jv_legacy_backup")),
        },
      };
    }

    case "createVault": {
      if (await meta()) return { ok: false, error: "A vault already exists on this browser." };
      if (String(msg.password || "").length < 8) return { ok: false, error: "Use at least 8 characters." };
      const dekRaw = await exportRawKey(await randomKey());
      const masterSalt = newSalt();
      const kek = await deriveKey(msg.password, masterSalt, DEFAULT_ITERATIONS);
      await setLocal({
        [K_META]: {
          masterSalt,
          wrappedByMaster: await encryptJSON(kek, dekRaw),
          iterations: DEFAULT_ITERATIONS,
          pin: null,
          pinFails: 0,
          autolockMinutes: DEFAULT_SETTINGS.autolockMinutes,
        },
      });
      await setSession({ [S_KEY]: dekRaw });
      await writeVault(emptyVault(msg.defaultEmail || ""));
      await armAutolock();
      refreshBadge();
      return { ok: true };
    }

    case "unlock": {
      const m = await meta();
      if (!m) return { ok: false, error: "No vault on this browser yet." };
      if (m.verifier && !m.wrappedByMaster) return migrateAndUnlock(m, msg.password);
      let dekRaw;
      try {
        const kek = await deriveKey(msg.password, m.masterSalt, m.iterations || LEGACY_ITERATIONS);
        dekRaw = await decryptJSON(kek, m.wrappedByMaster);
      } catch {
        return { ok: false, error: "That master password does not match." };
      }
      await setSession({ [S_KEY]: dekRaw });
      m.pinFails = 0;
      await setLocal({ [K_META]: m });
      await armAutolock();
      refreshBadge();
      return { ok: true };
    }

    case "unlockPin": {
      const m = await meta();
      if (!m || !m.pin) return { ok: false, error: "No PIN is set." };
      if ((m.pinFails || 0) >= MAX_PIN_FAILS) {
        return { ok: false, needMaster: true, error: "Too many tries. Use your master password." };
      }
      let dekRaw;
      try {
        const kek = await deriveKey(msg.pin, m.pin.salt, m.pin.iterations || m.iterations || LEGACY_ITERATIONS);
        dekRaw = await decryptJSON(kek, m.pin.wrapped);
      } catch {
        m.pinFails = (m.pinFails || 0) + 1;
        await setLocal({ [K_META]: m });
        const left = MAX_PIN_FAILS - m.pinFails;
        return {
          ok: false,
          needMaster: left <= 0,
          error: left > 0 ? `Wrong PIN. ${left} tr${left === 1 ? "y" : "ies"} left.` : "Locked. Use your master password.",
        };
      }
      await setSession({ [S_KEY]: dekRaw });
      m.pinFails = 0;
      await setLocal({ [K_META]: m });
      await armAutolock();
      refreshBadge();
      return { ok: true };
    }

    case "setupPin": {
      const dekRaw = await getSession(S_KEY);
      if (!dekRaw) return { ok: false, error: "Vault is locked." };
      if (!/^\d{4,12}$/.test(msg.pin || "")) return { ok: false, error: "Use 4 to 12 digits." };
      const salt = newSalt();
      const kek = await deriveKey(msg.pin, salt, DEFAULT_ITERATIONS);
      const m = await meta();
      m.pin = { salt, wrapped: await encryptJSON(kek, dekRaw), length: msg.pin.length, iterations: DEFAULT_ITERATIONS };
      m.pinFails = 0;
      await setLocal({ [K_META]: m });
      return { ok: true };
    }

    case "disablePin": {
      const m = await meta();
      if (!m) return { ok: false, error: "No vault." };
      m.pin = null; m.pinFails = 0;
      await setLocal({ [K_META]: m });
      return { ok: true };
    }

    case "changeMaster": {
      const dekRaw = await getSession(S_KEY);
      if (!dekRaw) return { ok: false, error: "Vault is locked." };
      if (String(msg.newPassword || "").length < 8) return { ok: false, error: "Use at least 8 characters." };
      // If the new password is mistyped or forgotten, this snapshot is the only
      // thing standing between the user and an unopenable vault.
      await snapshot("before changing the master password");
      const m = await meta();
      const masterSalt = newSalt();
      m.masterSalt = masterSalt;
      m.iterations = DEFAULT_ITERATIONS;
      m.wrappedByMaster = await encryptJSON(await deriveKey(msg.newPassword, masterSalt, DEFAULT_ITERATIONS), dekRaw);
      await setLocal({ [K_META]: m });
      return { ok: true, note: "Your PIN still works. The vault contents were not re-encrypted." };
    }

    case "reharden": {
      // Re-wrap an old vault at the current iteration count. Needs the master
      // password because the wrapping key has to be derived again from scratch.
      const dekRaw = await getSession(S_KEY);
      if (!dekRaw) return { ok: false, error: "Vault is locked." };
      await snapshot("before re-wrapping at a higher iteration count");
      const m = await meta();
      try {
        const check = await deriveKey(msg.password, m.masterSalt, m.iterations || LEGACY_ITERATIONS);
        await decryptJSON(check, m.wrappedByMaster);
      } catch {
        return { ok: false, error: "That master password does not match." };
      }
      const masterSalt = newSalt();
      m.masterSalt = masterSalt;
      m.iterations = DEFAULT_ITERATIONS;
      m.wrappedByMaster = await encryptJSON(await deriveKey(msg.password, masterSalt, DEFAULT_ITERATIONS), dekRaw);
      m.pin = null;
      await setLocal({ [K_META]: m });
      return { ok: true, note: `Re-wrapped at ${DEFAULT_ITERATIONS.toLocaleString()} iterations. Set your PIN again.` };
    }

    case "lock": await hardLock(); return { ok: true };
    case "ping": if (await sessionDataKey()) await armAutolock(); return { ok: true };

    // ---------------------------------------------------------------- vault
    case "getVault": {
      const vault = await readVault();
      if (!vault) return { ok: false, error: "locked" };
      const upd = (await getLocal(K_UPDATE)) || null;
      return { ok: true, vault, update: upd, build: await readBuild(), version: chrome.runtime.getManifest().version };
    }

    /**
     * Saves only the sections the editor actually changed, merged into a fresh
     * read inside the write queue.
     *
     * The old version wrote a whole-vault snapshot taken when the dashboard
     * loaded. Anything the background changed in the meantime, a job saved from a
     * page or a status flipped by a confirmation screen, was erased by an
     * unrelated profile edit.
     */
    case "patchVault": {
      const sections = msg.sections || {};
      const allowed = ["profile", "resume", "snippets", "settings", "updates", "logins"];
      const applied = [];
      const out = await mutate((v) => {
        for (const name of allowed) {
          if (!(name in sections)) continue;
          v[name] = sections[name];
          applied.push(name);
        }
        return { rev: v.rev, sections: applied };
      });
      const m = await meta();
      if (m && "settings" in sections) {
        m.autolockMinutes = sections.settings?.autolockMinutes ?? DEFAULT_SETTINGS.autolockMinutes;
        await setLocal({ [K_META]: m });
      }
      await armAutolock();
      return { ok: true, rev: out.rev, applied };
    }

    // Kept so an older open tab cannot fail silently, but routed through the
    // same merge rather than overwriting everything it did not know about.
    case "saveVault": {
      const v = normalizeVault(msg.vault);
      const sections = {
        profile: v.profile, resume: v.resume, snippets: v.snippets,
        settings: v.settings, updates: v.updates, logins: v.logins,
      };
      return handle({ type: "patchVault", sections }, sender);
    }

    // -------------------------------------------------------- data safety
    case "listSnapshots": {
      const s = (await getLocal(K_SAFETY)) || {};
      return { ok: true, snapshots: await listSnapshots(), safety: s, max: MAX_SNAPSHOTS };
    }
    case "makeSnapshot": {
      const key = await snapshot(msg.reason || "saved by hand");
      if (!key) {
        const s = (await getLocal(K_SAFETY)) || {};
        return { ok: false, error: s.snapshotError || "Could not take a backup." };
      }
      return { ok: true, key, snapshots: await listSnapshots() };
    }
    case "restoreSnapshot": {
      const counts = await restoreSnapshot(msg.key);
      return { ok: true, counts };
    }
    case "deleteSnapshot":
      await chrome.storage.local.remove(msg.key);
      return { ok: true, snapshots: await listSnapshots() };
    case "noteExported":
      await noteSafety({ lastExportAt: now(), lastExportCounts: msg.counts || null });
      return { ok: true };
    case "prepareImport": {
      // A snapshot of what is about to be replaced, so a wrong import is undoable.
      const key = await snapshot("before importing a backup file");
      return { ok: true, key };
    }
    case "flushDone":
      return { ok: true };

    case "generatePassword": {
      const pw = generatePassword(msg.opts || {});
      return { ok: true, password: pw, bits: entropyBits(pw, msg.opts || {}) };
    }

    // --------------------------------------------------- what is this page?
    case "pageContext": {
      // Deliberately returns no secrets. The content script gets metadata only;
      // an actual password is handed over just in time, in `fillLogin`, and only
      // for the origin the user acted on.
      const vault = await readVault();
      const url = msg.url || sender?.url || "";
      const host = hostOf(url);
      const company = prettyCompany(host, (() => { try { return new URL(url).pathname; } catch { return ""; } })());
      if (!vault) return { ok: true, locked: true, host, company };

      const cands = candidatesFor(vault, url);
      const s = vault.settings;
      const job = findJob(vault, { url });
      const p = normalizeProfile(vault.profile);
      return {
        ok: true,
        locked: false,
        host,
        company,
        tenant: tenantParts(host),
        matches: cands.map((c) => ({
          id: c.entry.id,
          host: c.entry.host,
          company: c.entry.company || c.entry.host,
          email: c.entry.email,
          why: c.why,
          exact: c.why === "exact" || c.why === "alias",
        })),
        settings: {
          autofillLogins: s.autofillLogins !== false,
          onlyWhenSingle: s.autofillOnlyWhenSingleMatch !== false,
          showFieldBadge: s.showFieldBadge !== false,
          autofillApplication: s.autofillApplication === true,
          matchOnOpen: s.matchOnOpen !== false,
          autoTrack: s.autoTrackApplications !== false,
        },
        emails: p.emails,
        defaultEmail: p.defaultEmail,
        hasProfile: completeness(p).done > 0,
        profileFields: Object.keys(fillValues(p)).length,
        hasResume: Boolean(vault.resume?.text?.trim()),
        job: job ? { id: job.id, status: job.status, title: job.title, company: job.company, appliedAt: job.appliedAt } : null,
      };
    }

    case "fillLogin": {
      const url = msg.url || sender?.url || "";
      // Runs inside the write queue: this bumps a usage counter, and doing that
      // with a bare read-modify-write let a fill from a page overwrite whatever
      // the dashboard had saved a moment earlier.
      let result = null;
      await mutate((vault) => {
        const cands = candidatesFor(vault, url);
        const chosen = msg.id ? cands.find((c) => c.entry.id === msg.id) : cands[0];
        if (!chosen) { result = { ok: false, error: "No saved login matches this site." }; return; }
        chosen.entry.usedCount = (chosen.entry.usedCount || 0) + 1;
        chosen.entry.lastUsedAt = now();
        result = {
          ok: true,
          credential: { email: chosen.entry.email || "", password: chosen.entry.password || "" },
          company: chosen.entry.company || chosen.entry.host,
          why: chosen.why,
        };
      });
      return result || { ok: false, error: "No saved login matches this site." };
    }

    case "fillApplication": {
      const vault = await readVault();
      if (!vault) return { ok: false, error: "locked" };
      const p = normalizeProfile(vault.profile);
      return {
        ok: true,
        values: fillValues(p, msg.email),
        workHistory: p.workHistory,
        education: p.education,
        resumeText: msg.includeResume ? vault.resume?.text || "" : "",
      };
    }

    case "captureLogin": {
      const record = {
        host: msg.host, url: msg.url, email: msg.email || "", password: msg.password || "",
        company: msg.company || msg.host, capturedAt: now(), isNew: Boolean(msg.isNew),
      };
      if (!(await sessionDataKey())) {
        await setSession({ [S_PENDING]: record });
        return { ok: true, saved: false, locked: true };
      }
      // Inside the queue for the same reason as fillLogin: this fires from a page
      // submit, which is exactly when the dashboard may also be saving.
      let outcome = null;
      await mutate((vault) => {
        const existing = vault.logins[record.host];
        // Don't silently overwrite a working password with something typed wrong.
        if (existing && existing.password && record.password && existing.password !== record.password) {
          outcome = { ok: true, saved: false, needsConfirm: true, pending: { ...record, conflict: true } };
          return;
        }
        upsertLogin(vault, record);
        outcome = { ok: true, saved: true };
      });
      if (outcome?.pending) {
        await setSession({ [S_PENDING]: outcome.pending });
        delete outcome.pending;
      }
      return outcome || { ok: false, error: "Could not save that login." };
    }

    case "getPending": return { ok: true, pending: (await getSession(S_PENDING)) || null };
    case "clearPending": await delSession(S_PENDING); return { ok: true };
    case "savePending": {
      const p = await getSession(S_PENDING);
      if (!p) return { ok: false, error: "Nothing waiting to be saved." };
      await mutate((v) => upsertLogin(v, p));
      await delSession(S_PENDING);
      return { ok: true };
    }

    // ---------------------------------------------------------------- jobs
    case "saveJob": {
      const j = msg.job || {};
      return mutate((vault) => {
        const existing = findJob(vault, { url: j.url, id: j.id });
        if (existing) {
          Object.assign(existing, {
            title: j.title || existing.title,
            company: j.company || existing.company,
            location: j.location || existing.location,
            jdText: j.jdText || existing.jdText,
            jdSavedAt: j.jdText ? now() : existing.jdSavedAt,
            matchScore: j.matchScore ?? existing.matchScore,
            updatedAt: now(),
          });
          return { ok: true, id: existing.id, duplicate: true, job: existing };
        }
        const job = {
          id: uid(),
          url: j.url || "",
          host: hostOf(j.url || ""),
          ats: j.ats || "",
          company: j.company || prettyCompany(hostOf(j.url || "")),
          title: j.title || "Untitled role",
          location: j.location || "",
          status: j.status || "saved",
          savedAt: now(),
          updatedAt: now(),
          appliedAt: j.status === "applied" ? now() : 0,
          deadline: j.deadline || 0,
          salary: j.salary || "",
          source: j.source || "",
          notes: j.notes || "",
          jdText: j.jdText || "",
          jdSavedAt: j.jdText ? now() : 0,
          matchScore: j.matchScore ?? null,
          followUpDone: false,
          events: [{ at: now(), to: j.status || "saved", note: "Saved" }],
        };
        vault.jobs.unshift(job);
        return { ok: true, id: job.id, duplicate: false, job };
      });
    }

    case "findJob": {
      const vault = await readVault();
      if (!vault) return { ok: false, error: "locked" };
      const job = findJob(vault, { url: msg.url, id: msg.id });
      return { ok: true, job: job || null };
    }

    case "updateJob": {
      return mutate((vault) => {
        const job = vault.jobs.find((j) => j.id === msg.id);
        if (!job) throw new Error("That job is no longer in the tracker.");
        const patch = msg.patch || {};
        if (patch.status && patch.status !== job.status) {
          job.events.push({ at: now(), from: job.status, to: patch.status, note: patch.note || "" });
          if (patch.status === "applied" && !job.appliedAt) job.appliedAt = now();
          if (patch.status !== "applied") job.followUpDone = false;
        }
        Object.assign(job, patch, { updatedAt: now() });
        return { ok: true, job };
      });
    }

    case "deleteJob":
      return mutate((vault) => {
        const i = vault.jobs.findIndex((j) => j.id === msg.id);
        if (i >= 0) vault.jobs.splice(i, 1);
        return { ok: true };
      });

    case "markApplied": {
      // Fired by the content script when it sees a submission confirmation.
      return mutate((vault) => {
        if (vault.settings.autoTrackApplications === false) return { ok: true, skipped: true };
        let job = findJob(vault, { url: msg.url });
        if (!job && msg.company) {
          const c = String(msg.company).toLowerCase();
          job = vault.jobs.find((j) => String(j.company).toLowerCase() === c && j.status === "saved");
        }
        if (!job) {
          job = {
            id: uid(), url: msg.url || "", host: hostOf(msg.url || ""), ats: msg.ats || "",
            company: msg.company || prettyCompany(hostOf(msg.url || "")), title: msg.title || "Untitled role",
            location: msg.location || "", status: "applied", savedAt: now(), updatedAt: now(),
            appliedAt: now(), deadline: 0, salary: "", source: "", notes: "", jdText: msg.jdText || "",
            jdSavedAt: msg.jdText ? now() : 0, matchScore: null, followUpDone: false,
            events: [{ at: now(), to: "applied", note: "Detected on the confirmation page" }],
          };
          vault.jobs.unshift(job);
          return { ok: true, created: true, job };
        }
        if (job.status === "saved") {
          job.events.push({ at: now(), from: job.status, to: "applied", note: "Detected on the confirmation page" });
          job.status = "applied";
          job.appliedAt = now();
          job.updatedAt = now();
          return { ok: true, updated: true, job };
        }
        return { ok: true, unchanged: true, job };
      });
    }

    case "snoozeFollowUp":
      return mutate((vault) => {
        const job = vault.jobs.find((j) => j.id === msg.id);
        if (job) { job.followUpAt = now() + (msg.days || 7) * DAY; job.followUpDone = false; }
        return { ok: true };
      });

    // -------------------------------------------------------------- resume
    case "matchJob": {
      const vault = await readVault();
      if (!vault) return { ok: true, locked: true };
      const resume = vault.resume?.text || "";
      if (!resume.trim()) return { ok: true, locked: false, result: null, noResume: true };
      return { ok: true, locked: false, result: computeMatch(resume, msg.text || "") };
    }

    // -------------------------------------------------------------- update
    case "checkUpdate": return { ok: true, status: await runUpdateCheck({ silent: false }) };
    case "getUpdate": return { ok: true, status: (await getLocal(K_UPDATE)) || null, build: await readBuild() };
    case "reloadExtension": {
      // Even a deliberate click waits for pending writes and takes a backup.
      const r = await requestReload({ reason: "a manual reload", force: Boolean(msg.force) });
      return { ok: true, ...r };
    }
    case "nativeUpdate": {
      const res = await nativeUpdate();
      return { ok: true, result: res };
    }
    case "requestNativePermission": {
      const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
      return { ok: granted, error: granted ? "" : "Permission was not granted." };
    }
    case "hasNativePermission":
      return { ok: true, granted: await chrome.permissions.contains({ permissions: ["nativeMessaging"] }) };

    /**
     * Run on a page JobVault was not granted in advance.
     *
     * The content script is scoped to known applicant tracking systems, so a
     * company running something bespoke gets nothing by default. `activeTab`
     * covers exactly this: a click in the popup is the user gesture that grants
     * access to that one tab, for this one visit, and nothing else.
     */
    case "runHere": {
      const tabId = msg.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!tabId) return { ok: false, error: "No page to run on." };
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["content.js"],
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: "Chrome would not allow it here: " + err.message };
      }
    }

    /** Remember a site so it works without asking every time. */
    case "addSite": {
      const pattern = msg.pattern;
      if (!/^https?:\/\/[^/]+\/\*$/.test(String(pattern || ""))) {
        return { ok: false, error: "That is not a site pattern I can register." };
      }
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) return { ok: false, error: "Permission was not granted, so nothing changed." };
      const id = "jv-site-" + pattern.replace(/[^a-z0-9]+/gi, "-");
      try {
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
        if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
        await chrome.scripting.registerContentScripts([{
          id, matches: [pattern], js: ["content.js"],
          runAt: "document_idle", allFrames: true, persistAcrossSessions: true,
        }]);
      } catch (err) {
        return { ok: false, error: "Could not register that site: " + err.message };
      }
      await mutate((v) => {
        v.settings.extraSites = [...new Set([...(v.settings.extraSites || []), pattern])];
      }).catch(() => {});
      return { ok: true, pattern };
    }

    case "removeSite": {
      const pattern = msg.pattern;
      const id = "jv-site-" + String(pattern).replace(/[^a-z0-9]+/gi, "-");
      try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch { /* already gone */ }
      try { await chrome.permissions.remove({ origins: [pattern] }); } catch { /* keep going */ }
      await mutate((v) => {
        v.settings.extraSites = (v.settings.extraSites || []).filter((p) => p !== pattern);
      }).catch(() => {});
      return { ok: true };
    }

    case "listSites": {
      const registered = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
      return {
        ok: true,
        extra: registered.filter((s) => s.id.startsWith("jv-site-")).flatMap((s) => s.matches),
        builtIn: ATS.map((a) => a.name),
      };
    }

    case "siteStatus": {
      const url = msg.url || "";
      const host = siteHostOf(url);
      const known = atsName(host);
      const pattern = originPattern(url);
      const registered = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
      const added = registered.some((s) => s.id.startsWith("jv-site-") && (s.matches || []).includes(pattern));
      return { ok: true, host, ats: known, supported: Boolean(known) || added, added, pattern };
    }

    case "openDashboard":
      await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html" + (msg.hash || "")) });
      return { ok: true };

    case "openUrls": {
      for (const u of (msg.urls || []).slice(0, 20)) await chrome.tabs.create({ url: u, active: false });
      return { ok: true, count: Math.min((msg.urls || []).length, 20) };
    }

    default:
      return { ok: false, error: `Unknown request: ${msg.type}` };
  }
}

function upsertLogin(vault, record) {
  const prev = vault.logins[record.host];
  vault.logins[record.host] = {
    id: prev?.id || uid(),
    host: record.host,
    url: record.url || prev?.url || `https://${record.host}`,
    company: record.company || prev?.company || record.host,
    email: record.email || prev?.email || "",
    password: record.password || prev?.password || "",
    aliases: prev?.aliases || [],
    note: prev?.note || "",
    createdAt: prev?.createdAt || now(),
    updatedAt: now(),
    usedCount: prev?.usedCount || 0,
    lastUsedAt: prev?.lastUsedAt || 0,
  };
  const p = vault.profile;
  if (record.email && !p.emails.includes(record.email)) {
    p.emails.push(record.email);
    if (!p.defaultEmail) p.defaultEmail = record.email;
    if (!p.values.email) p.values.email = record.email;
  }
  return { ok: true, host: record.host };
}

/**
 * Upgrades a 1.x vault in place.
 *
 * Two things matter here, because this runs exactly once per user and there is
 * no second attempt if it goes wrong.
 *
 * First, the original ciphertext and meta are copied aside untouched before
 * anything is written. They stay there afterwards. Recovering a 1.x vault later
 * needs nothing but the old master password.
 *
 * Second, the new meta and the new vault body are committed in a single
 * storage write. They are encrypted with different keys, so writing them
 * separately leaves a window where a crash strands the vault under a key that no
 * longer exists anywhere. One call closes that window.
 */
async function migrateAndUnlock(m, password) {
  const VERIFY = "jobvault-ok";
  let vaultObj;
  const originalBlob = await getLocal(K_VAULT);
  try {
    const oldKey = await deriveKey(password, m.salt, LEGACY_ITERATIONS);
    if ((await decryptJSON(oldKey, m.verifier)) !== VERIFY) throw new Error("bad");
    vaultObj = originalBlob ? await decryptJSON(oldKey, originalBlob) : emptyVault();
  } catch {
    return { ok: false, error: "That master password does not match." };
  }

  const migrated = normalizeVault(vaultObj);
  migrated.updatedAt = now();
  migrated.rev = Number(migrated.rev || 0) + 1;

  const dekRaw = await exportRawKey(await randomKey());
  const dek = await importRawKey(dekRaw);
  const masterSalt = newSalt();

  const newMeta = {
    masterSalt,
    wrappedByMaster: await encryptJSON(await deriveKey(password, masterSalt, DEFAULT_ITERATIONS), dekRaw),
    iterations: DEFAULT_ITERATIONS,
    pin: null, pinFails: 0, autolockMinutes: m.autolockMinutes || 15,
  };
  const newBlob = await encryptJSON(dek, migrated);

  // Everything below is prepared in memory first, then committed at once.
  await setLocal({
    jv_legacy_backup: {
      at: now(),
      note: "Your vault exactly as version 1.x left it. Opens with the master password you used then.",
      meta: m,
      vault: originalBlob || null,
      counts: vaultCounts(migrated),
    },
    [K_META]: newMeta,
    [K_VAULT]: newBlob,
  });

  await setSession({ [S_KEY]: dekRaw });
  await armAutolock();
  await snapshot("just after upgrading from version 1", migrated);
  refreshBadge();
  return { ok: true, migrated: true, counts: vaultCounts(migrated) };
}

// ------------------------------------------------------------ browser hooks

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "autolock") await hardLock();
  if (a.name === "updateCheck") await runUpdateCheck({ silent: true });
  if (a.name === "diskWatch") await watchDisk();
  if (a.name === "followUps") await sweepFollowUps();
  if (a.name === "dailySnap") await dailySnapshot();
  if (a.name === "reloadRetry" && reloadPending) {
    await requestReload({ reason: reloadPending.reason });
  }
});

async function sweepFollowUps() {
  const vault = await readVault();
  if (!vault) return refreshBadge();
  const due = dueFollowUps(vault);
  refreshBadge();
  if (!due.length) return;
  const first = due[0];
  const days = Math.max(1, Math.round((now() - (first.appliedAt || now())) / DAY));
  try {
    await chrome.notifications.create("jv-follow-" + first.id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: due.length === 1 ? "Time to follow up" : `${due.length} applications to follow up`,
      message:
        due.length === 1
          ? `${first.company} \u2014 ${first.title}. Applied ${days} day${days === 1 ? "" : "s"} ago.`
          : `Starting with ${first.company}, applied ${days} day${days === 1 ? "" : "s"} ago.`,
      buttons: [{ title: "Open tracker" }],
    });
  } catch { /* fine if the OS suppresses it */ }
}

chrome.notifications.onClicked.addListener((id) => {
  chrome.tabs.create({ url: chrome.runtime.getURL(id.startsWith("jv-update") ? "dashboard.html#settings" : "dashboard.html#jobs") });
  chrome.notifications.clear(id);
});
chrome.notifications.onButtonClicked.addListener((id) => {
  chrome.tabs.create({ url: chrome.runtime.getURL(id.startsWith("jv-update") ? "dashboard.html#settings" : "dashboard.html#jobs") });
  chrome.notifications.clear(id);
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const map = { "fill-login": "fillLoginNow", "fill-application": "fillApplicationNow", "save-job": "saveJobNow" };
  const action = map[command];
  if (!action) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: action });
  } catch {
    // No content script on this page (a chrome:// tab, or the extension was
    // reloaded and the page has not been refreshed). Say so rather than nothing.
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "JobVault could not reach this page",
        message: "Reload the tab and try the shortcut again.",
      });
    } catch { /* ignore */ }
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "jv-save-job", title: "Save this job to JobVault", contexts: ["page", "link", "selection"] });
    chrome.contextMenus.create({ id: "jv-fill-login", title: "Fill login here", contexts: ["editable"] });
    chrome.contextMenus.create({ id: "jv-fill-app", title: "Fill application form", contexts: ["editable", "page"] });
  });
  await bootAlarms();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#welcome") });
  }
  refreshBadge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const map = { "jv-save-job": "saveJobNow", "jv-fill-login": "fillLoginNow", "jv-fill-app": "fillApplicationNow" };
  const action = map[info.menuItemId];
  if (action) { try { await chrome.tabs.sendMessage(tab.id, { type: action }); } catch { /* ignore */ } }
});

async function bootAlarms() {
  chrome.alarms.create("updateCheck", { periodInMinutes: 360, delayInMinutes: 1 });
  chrome.alarms.create("diskWatch", { periodInMinutes: 1, delayInMinutes: 1 });
  chrome.alarms.create("followUps", { periodInMinutes: 240, delayInMinutes: 2 });
  chrome.alarms.create("dailySnap", { periodInMinutes: 180, delayInMinutes: 3 });
}

chrome.runtime.onStartup.addListener(async () => {
  await hardLock();          // a fresh browser session always starts locked
  await bootAlarms();
  refreshBadge();
});

// Runs on every service-worker wake-up, including after `chrome.runtime.reload`.
(async () => {
  await bootAlarms();
  const disk = await readBuild();
  if (disk.sha) await setSession({ [K_BOOT]: disk.sha });
  if (await lockExpired()) await hardLock();
  refreshBadge();
})();
