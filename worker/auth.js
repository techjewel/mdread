/* Magic-link authentication.

   What the server learns about you: SHA-256 of your email address, and nothing
   else. The address itself is used to send one message and is never written to
   storage, so the account row is an opaque hash with a blob attached.

   Authentication is not authorisation to *read* anything — the vault blob is
   encrypted with a master password the server never receives. Signing in only
   decides which ciphertext you get handed. */

import { sendMagicLink } from "./email.js";
import { json, randomId, sha256hex, normalizeEmail, looksLikeEmail, readCookie, cookieHeader, crossOrigin } from "./lib.js";

const MAGIC_TTL = 15 * 60; // seconds
const SESSION_TTL = 30 * 86400;
const SESSION_COOKIE = "mdr_sess";
const TOKEN_BYTES = 32;

const magicKey = (t) => `magic:${t}`;
const sessKey = (t) => `sess:${t}`;

/* ---------------- request a link ---------------- */

export async function requestLink(request, env, url) {
  if (crossOrigin(request, url)) return json({ error: "Cross-origin sign-in is not allowed" }, 403);

  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!looksLikeEmail(email)) return json({ error: "That doesn't look like an email address" }, 400);

  if (env.AUTH_LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    const { success } = await env.AUTH_LIMIT.limit({ key: ip });
    if (!success) return json({ error: "Too many sign-in attempts — try again in a minute" }, 429);
  }

  const token = randomId(TOKEN_BYTES);
  const acct = await sha256hex(email);
  await env.VAULT.put(magicKey(token), "", { expirationTtl: MAGIC_TTL, metadata: { acct } });

  const link = `${url.origin}/api/auth/verify?token=${token}`;
  try {
    await sendMagicLink(env, email, link);
  } catch {
    return json({ error: "Could not send the sign-in email — try again shortly" }, 502);
  }

  // Always the same answer, whether or not that address has an account: the
  // response must not reveal who is registered.
  return json({ ok: true });
}

/* ---------------- consume a link ---------------- */

export async function verifyLink(request, env, url) {
  const token = url.searchParams.get("token") || "";
  const bad = () => Response.redirect(`${url.origin}/?signin=expired`, 302);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return bad();

  const { value, metadata } = await env.VAULT.getWithMetadata(magicKey(token));
  if (value === null || !metadata?.acct) return bad();

  // Single use. Delete before issuing the session so a replayed link is dead
  // even if the rest of this handler fails.
  await env.VAULT.delete(magicKey(token));

  const sess = randomId(TOKEN_BYTES);
  await env.VAULT.put(sessKey(sess), "", { expirationTtl: SESSION_TTL, metadata: { acct: metadata.acct } });

  console.log(JSON.stringify({ msg: "auth.signed_in" }));
  return new Response(null, {
    status: 302,
    headers: {
      location: `${url.origin}/?signin=ok`,
      "set-cookie": cookieHeader(SESSION_COOKIE, sess, { maxAge: SESSION_TTL, url }),
      "cache-control": "no-store",
    },
  });
}

/* ---------------- session ---------------- */

// Returns the opaque account id for a valid session, or null.
export async function sessionAccount(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { value, metadata } = await env.VAULT.getWithMetadata(sessKey(token));
  if (value === null) return null;
  return metadata?.acct || null;
}

export async function whoami(request, env) {
  return json({ signedIn: !!(await sessionAccount(request, env)) });
}

export async function logout(request, env, url) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.VAULT.delete(sessKey(token));
  return json({ ok: true }, 200, { "set-cookie": cookieHeader(SESSION_COOKIE, "", { maxAge: 0, url }) });
}
