/* The vault: one opaque blob per account.

   This is the second place in mdread where the server holds bytes it cannot
   read. The blob is sealed with a key stretched from the user's master password
   (PBKDF2, client-side, see src/modules/crypto.js). We store it, we hand it
   back, and that is the whole extent of our involvement.

   No TTL: unlike a share, a vault is meant to persist. */

import { json, readCapped, crossOrigin } from "./lib.js";
import { sessionAccount } from "./auth.js";

const MAX_VAULT = 256 * 1024; // the index: share links + a document listing
const MAX_DOC = 1024 * 1024; // one document body
const vaultKey = (acct) => `vault:${acct}`;

/* Document bodies live one-per-key rather than inside the index blob, so saving
   a document doesn't rewrite every other one, and the index stays small enough
   to fetch on every unlock. Both are sealed with the same master-password key —
   this Worker can read neither. */
const docKey = (acct, id) => `vaultdoc:${acct}:${id}`;

export async function getDoc(request, env, id) {
  const acct = await sessionAccount(request, env);
  if (!acct) return json({ error: "Not signed in" }, 401);

  const value = await env.VAULT.get(docKey(acct, id), { type: "arrayBuffer" });
  if (!value) return json({ error: "That document isn't in your vault" }, 404);

  return new Response(value, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

export async function putDoc(request, env, url, id) {
  if (crossOrigin(request, url)) return json({ error: "Cross-origin writes are not allowed" }, 403);

  const acct = await sessionAccount(request, env);
  if (!acct) return json({ error: "Not signed in" }, 401);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_DOC) return json({ error: "That document is too large for the vault (1 MB maximum)" }, 413);

  const payload = await readCapped(request.body, MAX_DOC);
  if (!payload) return json({ error: "That document is too large for the vault (1 MB maximum)" }, 413);
  if (payload.length < 16) return json({ error: "Empty or malformed document" }, 400);

  await env.VAULT.put(docKey(acct, id), payload);
  console.log(JSON.stringify({ msg: "vault.doc_saved", bytes: payload.length }));
  return json({ ok: true, bytes: payload.length });
}

export async function deleteDoc(request, env, url, id) {
  if (crossOrigin(request, url)) return json({ error: "Cross-origin writes are not allowed" }, 403);

  const acct = await sessionAccount(request, env);
  if (!acct) return json({ error: "Not signed in" }, 401);

  await env.VAULT.delete(docKey(acct, id)); // idempotent
  console.log(JSON.stringify({ msg: "vault.doc_removed" }));
  return json({ ok: true });
}

/* Lets the client ask "is this a first-time setup or a returning unlock?"
   before prompting for a password, so the two can be worded differently. Only
   ever reports on the caller's own account, so there is nothing to leak. */
export async function vaultStatus(request, env) {
  const acct = await sessionAccount(request, env);
  if (!acct) return json({ error: "Not signed in" }, 401);
  const existing = await env.VAULT.get(vaultKey(acct), { type: "stream" });
  if (existing?.cancel) await existing.cancel(); // presence is all we needed
  return json({ exists: !!existing });
}

export async function getVault(request, env) {
  const acct = await sessionAccount(request, env);
  if (!acct) return json({ error: "Not signed in" }, 401);

  const value = await env.VAULT.get(vaultKey(acct), { type: "arrayBuffer" });
  if (!value) return json({ error: "No vault yet" }, 404);

  return new Response(value, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

export async function putVault(request, env, url) {
  if (crossOrigin(request, url)) return json({ error: "Cross-origin writes are not allowed" }, 403);

  const acct = await sessionAccount(request, env);
  if (!acct) return json({ error: "Not signed in" }, 401);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_VAULT) return json({ error: "That vault is too large" }, 413);

  const payload = await readCapped(request.body, MAX_VAULT);
  if (!payload) return json({ error: "That vault is too large" }, 413);
  if (payload.length < 16) return json({ error: "Empty or malformed vault" }, 400);

  await env.VAULT.put(vaultKey(acct), payload);
  console.log(JSON.stringify({ msg: "vault.saved", bytes: payload.length }));
  return json({ ok: true });
}
