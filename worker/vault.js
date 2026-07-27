/* The vault: one opaque blob per account.

   This is the second place in mdread where the server holds bytes it cannot
   read. The blob is sealed with a key stretched from the user's master password
   (PBKDF2, client-side, see src/modules/crypto.js). We store it, we hand it
   back, and that is the whole extent of our involvement.

   No TTL: unlike a share, a vault is meant to persist. */

import { json, readCapped, crossOrigin } from "./lib.js";
import { sessionAccount } from "./auth.js";

const MAX_VAULT = 256 * 1024; // a share list, not a document store
const vaultKey = (acct) => `vault:${acct}`;

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
