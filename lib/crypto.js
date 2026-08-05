// Everything here runs on your machine. No key material ever leaves it.
//
// Layout: a random 256-bit data key (DEK) encrypts the vault. The DEK is then
// wrapped separately by a key derived from your master password and by one
// derived from your PIN. Changing either only re-wraps the DEK, so the vault
// itself is never re-encrypted and can never be left half converted.

const enc = new TextEncoder();
const dec = new TextDecoder();

// New vaults use this. Older vaults keep the iteration count recorded in their
// own meta so they stay openable — never assume a global constant.
export const DEFAULT_ITERATIONS = 600000;
export const LEGACY_ITERATIONS = 250000;

export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function newSalt() {
  return toB64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKey(password, saltB64, iterations = DEFAULT_ITERATIONS) {
  const salt = fromB64(saltB64);
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportRawKey(key) {
  return toB64(await crypto.subtle.exportKey("raw", key));
}

export async function importRawKey(b64) {
  return crypto.subtle.importKey("raw", fromB64(b64), { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function randomKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(obj))
  );
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(key, payload) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(payload.iv) },
    key,
    fromB64(payload.ct)
  );
  return JSON.parse(dec.decode(pt));
}

// ---------------------------------------------------------------- generator

const SETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*-_=+?.,:",
};
// Characters people misread when copying a password off a screen.
const AMBIGUOUS = /[Il1O0o|`'"~;{}[\]()<>\\/]/g;

// Uniform pick with rejection sampling. `bytes[i] % pool.length` biases toward
// the front of the pool whenever 256 is not a multiple of the pool size.
function pick(pool) {
  const limit = Math.floor(256 / pool.length) * pool.length;
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return pool[buf[0] % pool.length];
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Some application portals silently reject long passwords or particular
 * symbols, then tell you your password is wrong at sign-in. `rules` lets a
 * site pack cap the length or restrict the symbol set up front.
 */
export function generatePassword(opts = {}) {
  const rules = opts.rules || {};
  const maxLen = Math.min(128, rules.maxLength || 64);
  const length = Math.max(8, Math.min(maxLen, opts.length || 20));

  const sets = [];
  if (opts.lower !== false) sets.push(SETS.lower);
  if (opts.upper !== false) sets.push(SETS.upper);
  if (opts.digits !== false) sets.push(SETS.digits);
  if (opts.symbols !== false && rules.symbols !== false) {
    sets.push(rules.symbolSet || SETS.symbols);
  }
  if (!sets.length) sets.push(SETS.lower, SETS.upper, SETS.digits);

  const clean = (s) => (opts.avoidAmbiguous ? s.replace(AMBIGUOUS, "") || s : s);
  const usable = sets.map(clean).filter(Boolean);
  const pool = usable.join("");

  // One guaranteed character from every required set, then fill the rest, then
  // shuffle so the guaranteed ones are not stuck in known positions.
  const chars = usable.map((s) => pick(s));
  while (chars.length < length) chars.push(pick(pool));
  return shuffle(chars).slice(0, length).join("");
}

/** Real entropy of the generator's output, not a vibes-based 0-100 score. */
export function entropyBits(password, opts = {}) {
  if (!password) return 0;
  // Site rules narrow the pool the generator actually drew from, so they have to
  // narrow this number too, or the readout overstates a password the site forced
  // to be weaker.
  const rules = opts.rules || {};
  let pool = 0;
  if (opts.lower !== false) pool += 26;
  if (opts.upper !== false) pool += 26;
  if (opts.digits !== false && rules.digits !== false) pool += 10;
  if (opts.symbols !== false && rules.symbols !== false) {
    pool += (rules.symbolSet || SETS.symbols).length;
  }
  if (opts.avoidAmbiguous) pool = Math.round(pool * 0.82);
  return Math.round(password.length * Math.log2(Math.max(pool, 26)));
}
