// All encryption happens on your machine. Nothing here ever touches a network.
// Master password is stretched with PBKDF2 and used to unlock an AES-GCM vault.

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 250000;

export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function newSalt() {
  return toB64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKey(password, saltB64) {
  const salt = fromB64(saltB64);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
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
  return crypto.subtle.importKey(
    "raw",
    fromB64(b64),
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}

// A fresh random data key. The vault is encrypted with this, and this key is
// then wrapped separately by the master password and by the PIN. That way,
// changing either one only re-wraps this key and never touches the vault.
export async function randomKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(key, payload) {
  const iv = fromB64(payload.iv);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    fromB64(payload.ct)
  );
  return JSON.parse(dec.decode(pt));
}
