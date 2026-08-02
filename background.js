import {
  deriveKey,
  exportRawKey,
  importRawKey,
  encryptJSON,
  decryptJSON,
  newSalt,
  randomKey,
} from "./lib/crypto.js";
import { computeMatch } from "./lib/match.js";

const K_META = "jv_meta";
const K_VAULT = "jv_vault";
const S_KEY = "jv_key"; // the raw data key, base64, session only
const S_PENDING = "jv_pending";
const MAX_PIN_FAILS = 5;

// ---------- storage helpers ----------
const getLocal = (k) => chrome.storage.local.get(k).then((r) => r[k]);
const setLocal = (obj) => chrome.storage.local.set(obj);
const getSession = (k) => chrome.storage.session.get(k).then((r) => r[k]);
const setSession = (obj) => chrome.storage.session.set(obj);
const delSession = (k) => chrome.storage.session.remove(k);

async function hasVault() {
  return Boolean(await getLocal(K_META));
}

async function sessionDataKey() {
  const raw = await getSession(S_KEY);
  if (!raw) return null;
  try {
    return await importRawKey(raw);
  } catch {
    return null;
  }
}

async function readVault() {
  const dek = await sessionDataKey();
  if (!dek) return null;
  const blob = await getLocal(K_VAULT);
  if (!blob) return normalizeVault(emptyVault());
  try {
    return normalizeVault(await decryptJSON(dek, blob));
  } catch {
    return null;
  }
}

async function writeVault(vault) {
  const dek = await sessionDataKey();
  if (!dek) throw new Error("locked");
  await setLocal({ [K_VAULT]: await encryptJSON(dek, vault) });
}

function emptyVault(defaultEmail = "") {
  return {
    version: 2,
    entries: {},
    resume: { text: "", updatedAt: 0 },
    profile: { emails: defaultEmail ? [defaultEmail] : [], defaultEmail: defaultEmail || "" },
    settings: { autofill: true, autolockMinutes: 15, matchOnOpen: true },
  };
}

// keep older or partial vaults in a known shape
function normalizeVault(v) {
  if (!v) return v;
  v.entries = v.entries || {};
  v.resume = v.resume || { text: "", updatedAt: 0 };
  v.settings = Object.assign({ autofill: true, autolockMinutes: 15, matchOnOpen: true }, v.settings || {});
  if (!v.profile) {
    const legacy = v.settings.defaultEmail ? [v.settings.defaultEmail] : [];
    v.profile = { emails: legacy, defaultEmail: v.settings.defaultEmail || "" };
  }
  v.profile.emails = v.profile.emails || [];
  if (!v.profile.defaultEmail && v.profile.emails.length) v.profile.defaultEmail = v.profile.emails[0];
  return v;
}

// ---------- auto lock ----------
async function scheduleAutoLock() {
  const meta = await getLocal(K_META);
  const minutes = (meta && meta.autolockMinutes) || 15;
  if (minutes <= 0) return chrome.alarms.clear("autolock");
  chrome.alarms.create("autolock", { delayInMinutes: minutes });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "autolock") delSession(S_KEY);
});

// ---------- password generator ----------
const SETS = {
  lower: "abcdefghijkmnpqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*-_=+?",
};
function generatePassword(opts = {}) {
  const length = Math.max(8, Math.min(64, opts.length || 20));
  const sets = [];
  if (opts.lower !== false) sets.push(SETS.lower);
  if (opts.upper !== false) sets.push(SETS.upper);
  if (opts.digits !== false) sets.push(SETS.digits);
  if (opts.symbols !== false) sets.push(SETS.symbols);
  if (!sets.length) sets.push(SETS.lower, SETS.upper, SETS.digits);
  const pool = sets.join("");
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  const chars = [];
  for (let i = 0; i < length; i++) chars.push(pool[bytes[i] % pool.length]);
  const spots = crypto.getRandomValues(new Uint32Array(sets.length));
  sets.forEach((set, i) => {
    const pos = spots[i] % length;
    chars[pos] = set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  });
  return chars.join("");
}

// ---------- routing ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case "getState": {
      const meta = await getLocal(K_META);
      const dek = await sessionDataKey();
      return {
        ok: true,
        hasVault: Boolean(meta),
        unlocked: Boolean(dek),
        hasPin: Boolean(meta && meta.pin),
        pinLocked: Boolean(meta && (meta.pinFails || 0) >= MAX_PIN_FAILS),
      };
    }

    case "createVault": {
      if (await hasVault()) return { ok: false, error: "A vault already exists." };
      const vaultKey = await randomKey();
      const dekRaw = await exportRawKey(vaultKey);
      const masterSalt = newSalt();
      const masterKEK = await deriveKey(msg.password, masterSalt);
      const wrappedByMaster = await encryptJSON(masterKEK, dekRaw);
      await setLocal({
        [K_META]: { masterSalt, wrappedByMaster, pin: null, pinFails: 0, autolockMinutes: 15 },
      });
      await setSession({ [S_KEY]: dekRaw });
      await writeVault(emptyVault(msg.defaultEmail || ""));
      await scheduleAutoLock();
      return { ok: true };
    }

    case "unlock": {
      const meta = await getLocal(K_META);
      if (!meta) return { ok: false, error: "No vault yet." };

      // migrate an old style vault on the fly
      if (meta.verifier && !meta.wrappedByMaster) {
        return migrateAndUnlock(meta, msg.password);
      }

      let dekRaw;
      try {
        const kek = await deriveKey(msg.password, meta.masterSalt);
        dekRaw = await decryptJSON(kek, meta.wrappedByMaster);
      } catch {
        return { ok: false, error: "That master password does not match." };
      }
      await setSession({ [S_KEY]: dekRaw });
      meta.pinFails = 0;
      await setLocal({ [K_META]: meta });
      await scheduleAutoLock();
      return { ok: true };
    }

    case "unlockPin": {
      const meta = await getLocal(K_META);
      if (!meta || !meta.pin) return { ok: false, error: "No PIN set." };
      if ((meta.pinFails || 0) >= MAX_PIN_FAILS)
        return { ok: false, needMaster: true, error: "Too many tries. Use your master password." };
      let dekRaw;
      try {
        const kek = await deriveKey(msg.pin, meta.pin.salt);
        dekRaw = await decryptJSON(kek, meta.pin.wrapped);
      } catch {
        meta.pinFails = (meta.pinFails || 0) + 1;
        await setLocal({ [K_META]: meta });
        const left = MAX_PIN_FAILS - meta.pinFails;
        return {
          ok: false,
          needMaster: left <= 0,
          error: left > 0 ? `Wrong PIN. ${left} tr${left === 1 ? "y" : "ies"} left.` : "Locked. Use your master password.",
        };
      }
      await setSession({ [S_KEY]: dekRaw });
      meta.pinFails = 0;
      await setLocal({ [K_META]: meta });
      await scheduleAutoLock();
      return { ok: true };
    }

    case "setupPin": {
      const dekRaw = await getSession(S_KEY);
      if (!dekRaw) return { ok: false, error: "locked" };
      if (!/^\d{4,12}$/.test(msg.pin)) return { ok: false, error: "Use 4 to 12 digits." };
      const salt = newSalt();
      const kek = await deriveKey(msg.pin, salt);
      const wrapped = await encryptJSON(kek, dekRaw);
      const meta = await getLocal(K_META);
      meta.pin = { salt, wrapped, length: msg.pin.length };
      meta.pinFails = 0;
      await setLocal({ [K_META]: meta });
      return { ok: true };
    }

    case "disablePin": {
      const meta = await getLocal(K_META);
      if (!meta) return { ok: false };
      meta.pin = null;
      meta.pinFails = 0;
      await setLocal({ [K_META]: meta });
      return { ok: true };
    }

    case "lock": {
      await delSession(S_KEY);
      chrome.alarms.clear("autolock");
      return { ok: true };
    }

    case "getVault": {
      const vault = await readVault();
      if (!vault) return { ok: false, error: "locked" };
      return { ok: true, vault };
    }

    case "saveVault": {
      await writeVault(msg.vault);
      const meta = await getLocal(K_META);
      if (meta) {
        meta.autolockMinutes = msg.vault?.settings?.autolockMinutes ?? 15;
        await setLocal({ [K_META]: meta });
      }
      await scheduleAutoLock();
      return { ok: true };
    }

    case "changeMaster": {
      const dekRaw = await getSession(S_KEY);
      if (!dekRaw) return { ok: false, error: "locked" };
      const meta = await getLocal(K_META);
      const masterSalt = newSalt();
      const kek = await deriveKey(msg.newPassword, masterSalt);
      meta.masterSalt = masterSalt;
      meta.wrappedByMaster = await encryptJSON(kek, dekRaw);
      await setLocal({ [K_META]: meta });
      return { ok: true };
    }

    case "generatePassword":
      return { ok: true, password: generatePassword(msg.opts || {}) };

    case "pageInfo": {
      const vault = await readVault();
      if (!vault) return { ok: true, locked: true };
      const entry = vault.entries[msg.host];
      const p = vault.profile || { emails: [], defaultEmail: "" };
      const s = vault.settings || {};
      return {
        ok: true,
        locked: false,
        found: Boolean(entry),
        autofill: s.autofill !== false,
        matchOnOpen: s.matchOnOpen !== false,
        emails: p.emails || [],
        defaultEmail: p.defaultEmail || (p.emails && p.emails[0]) || "",
        hasResume: Boolean(vault.resume && vault.resume.text && vault.resume.text.trim()),
        email: entry ? entry.email : "",
        password: entry ? entry.password : "",
        company: entry ? entry.company || entry.host : "",
      };
    }

    case "capturePending": {
      const vault = await readVault();
      const record = {
        host: msg.host,
        url: msg.url,
        email: msg.email || "",
        password: msg.password || "",
        company: msg.company || msg.host,
        capturedAt: Date.now(),
      };
      if (!vault) {
        await setSession({ [S_PENDING]: record });
        return { ok: true, saved: false, locked: true };
      }
      const prev = vault.entries[msg.host];
      vault.entries[msg.host] = {
        host: msg.host,
        url: msg.url,
        email: record.email || prev?.email || "",
        password: record.password || prev?.password || "",
        company: record.company,
        note: prev?.note || "",
        createdAt: prev?.createdAt || Date.now(),
        updatedAt: Date.now(),
        usedCount: prev?.usedCount || 0,
      };
      // learn new emails into the profile
      if (record.email && !vault.profile.emails.includes(record.email)) {
        vault.profile.emails.push(record.email);
        if (!vault.profile.defaultEmail) vault.profile.defaultEmail = record.email;
      }
      await writeVault(vault);
      return { ok: true, saved: true, locked: false };
    }

    case "getPending": {
      return { ok: true, pending: (await getSession(S_PENDING)) || null };
    }
    case "clearPending": {
      await delSession(S_PENDING);
      return { ok: true };
    }

    case "matchJob": {
      const vault = await readVault();
      if (!vault) return { ok: true, locked: true };
      const resume = vault.resume && vault.resume.text;
      if (!resume || !resume.trim()) return { ok: true, locked: false, result: null };
      return { ok: true, locked: false, result: computeMatch(resume, msg.text || "") };
    }

    case "pingActivity": {
      if (await sessionDataKey()) await scheduleAutoLock();
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown request." };
  }
}

async function migrateAndUnlock(meta, password) {
  const VERIFY_TEXT = "jobvault-ok";
  let vaultObj;
  try {
    const oldKey = await deriveKey(password, meta.salt);
    const check = await decryptJSON(oldKey, meta.verifier);
    if (check !== VERIFY_TEXT) throw new Error("bad");
    const oldBlob = await getLocal(K_VAULT);
    vaultObj = oldBlob ? await decryptJSON(oldKey, oldBlob) : emptyVault();
  } catch {
    return { ok: false, error: "That master password does not match." };
  }
  const vaultKey = await randomKey();
  const dekRaw = await exportRawKey(vaultKey);
  const masterSalt = newSalt();
  const kek = await deriveKey(password, masterSalt);
  const wrappedByMaster = await encryptJSON(kek, dekRaw);
  await setLocal({
    [K_META]: { masterSalt, wrappedByMaster, pin: null, pinFails: 0, autolockMinutes: meta.autolockMinutes || 15 },
  });
  await setSession({ [S_KEY]: dekRaw });
  await setLocal({ [K_VAULT]: await encryptJSON(vaultKey, normalizeVault(vaultObj)) });
  await scheduleAutoLock();
  return { ok: true };
}
