/* Pure crypto + compression primitives for end-to-end encrypted sharing.
   No app state here — just bytes in, bytes out (the util.js of the share path).

   Everything runs in the browser. The AES key produced by `newKey()` is never
   transmitted: callers put it in a URL fragment, which browsers do not send. */

const IV_BYTES = 12; // AES-GCM standard nonce length
const FORMAT = 1; // payload format version
const FLAG_GZIP = 1 << 0;

/* ---------------- base64url ---------------- */

export function toB64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(str) {
  const b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
  let bin;
  try {
    bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    // Mangled links are the common case here, not hostile input.
    throw new Error("This link is damaged — it was probably cut short or altered when it was copied");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- gzip ----------------
   CompressionStream is in every browser that has the File System Access API,
   but it is feature-detected anyway so the flag byte stays honest. */

export const supportsGzip = typeof CompressionStream === "function" && typeof DecompressionStream === "function";

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const gzip = (bytes) => pipe(bytes, new CompressionStream("gzip"));
const gunzip = (bytes) => pipe(bytes, new DecompressionStream("gzip"));

/* ---------------- keys ---------------- */

export function newKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/* The vault key is stretched from the user's master password and never leaves
   this function's caller. 600k PBKDF2-SHA256 iterations is the current OWASP
   figure — roughly a second of work here, and the reason a stolen vault blob
   is not worth grinding.

   The salt is derived from the email rather than stored: it is unique per
   account (which is all a salt must be), and it means unlocking needs no
   server round-trip before the key exists. */
const PBKDF2_ITERS = 600_000;

export const normalizeEmail = (email) => String(email).trim().toLowerCase();

export async function deriveVaultKey(email, passphrase) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("mdread-vault:v1:" + normalizeEmail(email))));
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function exportKey(key) {
  return toB64url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export function importKey(str) {
  const raw = fromB64url(str);
  // WebCrypto's own error here ("AES key data must be 128 or 256 bits") is
  // useless to a reader whose link simply got truncated in a chat client.
  if (raw.length !== 32) throw new Error("This link's key is incomplete — copy the whole link and try again");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

/* ---------------- seal / open ----------------
   Payload layout:  [0] format  [1] flags  [2..13] iv  [14..] ciphertext */

export async function seal(key, text) {
  let body = new TextEncoder().encode(text);
  let flags = 0;
  if (supportsGzip) {
    body = await gzip(body);
    flags |= FLAG_GZIP;
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body));

  const payload = new Uint8Array(2 + IV_BYTES + ct.length);
  payload[0] = FORMAT;
  payload[1] = flags;
  payload.set(iv, 2);
  payload.set(ct, 2 + IV_BYTES);
  return payload;
}

export async function open(key, payload) {
  if (payload.length < 2 + IV_BYTES + 1) throw new Error("Share payload is truncated");
  if (payload[0] !== FORMAT) throw new Error(`Unsupported share format (v${payload[0]})`);

  const flags = payload[1];
  const iv = payload.subarray(2, 2 + IV_BYTES);
  const ct = payload.subarray(2 + IV_BYTES);

  // A wrong key surfaces here as an OperationError from AES-GCM's auth tag check.
  let body;
  try {
    body = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  } catch {
    throw new Error("Could not decrypt — the link's key is wrong or incomplete");
  }
  if (flags & FLAG_GZIP) body = await gunzip(body);
  return new TextDecoder().decode(body);
}
