/* Share storage — opaque ciphertext under a random id, with a TTL.
 *
 * The browser seals a share bundle with AES-GCM (see src/modules/crypto.js) and
 * the key travels in the URL fragment, which is not transmitted. All we hold is
 * bytes. We cannot read shares, and neither can anyone who compromises this KV
 * namespace without also having the links.
 */

import { json, randomId, tokenMatches, readCapped, crossOrigin } from "./lib.js";

const MAX_PAYLOAD = 1024 * 1024; // 1 MB of ciphertext — matches the client cap
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const MIN_TTL = 60; // Workers KV rejects expirationTtl below 60s
const ID_BYTES = 9; // -> 12 base64url chars
const TOKEN_BYTES = 24;

export async function createShare(request, env, url) {
  // Same-origin only: keeps the endpoint from being used as free storage by other sites.
  if (crossOrigin(request, url)) return json({ error: "Cross-origin shares are not allowed" }, 403);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_PAYLOAD) return json({ error: "That share is too large (1 MB encrypted maximum)" }, 413);

  if (env.SHARE_LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    const { success } = await env.SHARE_LIMIT.limit({ key: ip });
    if (!success) return json({ error: "Too many links created just now — try again in a minute" }, 429);
  }

  const payload = await readCapped(request.body, MAX_PAYLOAD);
  if (!payload) return json({ error: "That share is too large (1 MB encrypted maximum)" }, 413);
  if (payload.length < 16) return json({ error: "Empty or malformed share" }, 400);

  const days = Math.min(MAX_DAYS, Math.max(1, Number(request.headers.get("x-mdread-expiry-days")) || DEFAULT_DAYS));
  const ttl = Math.max(MIN_TTL, days * 86400);
  const id = randomId(ID_BYTES);
  const deleteToken = randomId(TOKEN_BYTES);
  const expiresAt = Date.now() + ttl * 1000;

  await env.SHARES.put(id, payload, { expirationTtl: ttl, metadata: { t: deleteToken, exp: expiresAt } });

  console.log(JSON.stringify({ msg: "share.created", id, bytes: payload.length, days }));
  return json({ id, deleteToken, expiresAt }, 201);
}

export async function getShare(env, id) {
  const { value, metadata } = await env.SHARES.getWithMetadata(id, { type: "arrayBuffer" });
  if (!value) return json({ error: "This share has expired or been revoked" }, 404);

  return new Response(value, {
    headers: {
      "content-type": "application/octet-stream",
      // Revocation should take effect immediately, so this is never cached.
      "cache-control": "no-store",
      "x-mdread-expires-at": String(metadata?.exp ?? ""),
      // Ciphertext is inert, but make certain nothing tries to interpret it.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

export async function deleteShare(request, env, id) {
  const { value, metadata } = await env.SHARES.getWithMetadata(id, { type: "stream" });
  if (!value) return json({ ok: true }); // already gone — revocation is idempotent
  if (value.cancel) await value.cancel(); // we only needed the metadata

  const supplied = request.headers.get("x-mdread-delete-token");
  if (!(await tokenMatches(supplied, metadata?.t))) return json({ error: "Not allowed" }, 403);

  await env.SHARES.delete(id);
  console.log(JSON.stringify({ msg: "share.revoked", id }));
  return json({ ok: true });
}
