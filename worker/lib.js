/* Small shared helpers for the mdread API. No bindings, no routing — just
   bytes, ids, and responses. */

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const randomId = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export const sha256 = (str) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));

export async function sha256hex(str) {
  const buf = new Uint8Array(await sha256(str));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fixed-size hashes keep the comparison timing-independent of where they differ.
export async function tokenMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

// Bounded read: never buffer more than `max`, regardless of what content-length claims.
export async function readCapped(body, max) {
  if (!body) return null;
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// Same-origin guard for state-changing requests. Browsers always send Origin on
// those, so a missing header means a non-browser client, which we allow.
export function crossOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

export const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

// Deliberately loose: we only need to know it can receive mail, not to police it.
export const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;

export function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function cookieHeader(name, value, { maxAge, url }) {
  // Chrome treats http://localhost as a secure context, but other browsers are
  // stricter, so Secure is dropped only for plain-http local development.
  const local = url.protocol === "http:" && /^(localhost|127\.0\.0\.1)(:|$)/.test(url.host);
  const bits = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (!local) bits.push("Secure");
  return bits.join("; ");
}
