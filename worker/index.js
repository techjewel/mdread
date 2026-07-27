/* mdread API — router.
 *
 * Two features live here, and both are deliberately blind:
 *
 *   /api/share/*  end-to-end encrypted share links. The key rides in the URL
 *                 fragment, which browsers never transmit.
 *   /api/vault    your list of share links, synced across devices. Encrypted
 *                 with a master password we never receive and cannot reset.
 *   /api/auth/*   magic-link sign-in. Decides *which* ciphertext you get; it
 *                 does not, and cannot, decrypt any of it.
 *
 * Everything else is the static app, served straight from Workers Assets.
 * See src/modules/crypto.js for the other half of all of this.
 */

import { json } from "./lib.js";
import { createShare, getShare, deleteShare } from "./shares.js";
import { requestLink, verifyLink, whoami, logout } from "./auth.js";
import { getVault, putVault, vaultStatus, getDoc, putDoc, deleteDoc } from "./vault.js";

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  /* ---- shares ---- */
  const share = pathname.match(/^\/api\/share\/([A-Za-z0-9_-]{6,64})$/);
  if (pathname === "/api/share" || share) {
    if (!env.SHARES) return json({ error: "Sharing is not configured on this deployment" }, 501);
    if (pathname === "/api/share" && method === "POST") return createShare(request, env, url);
    if (share && method === "GET") return getShare(env, share[1]);
    if (share && method === "DELETE") return deleteShare(request, env, share[1]);
    return json({ error: "Not found" }, 404);
  }

  /* ---- accounts + vault ---- */
  if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/vault")) {
    if (!env.VAULT) return json({ error: "Accounts are not configured on this deployment" }, 501);
    if (pathname === "/api/auth/request" && method === "POST") return requestLink(request, env, url);
    if (pathname === "/api/auth/verify" && method === "GET") return verifyLink(request, env, url);
    if (pathname === "/api/auth/me" && method === "GET") return whoami(request, env);
    if (pathname === "/api/auth/logout" && method === "POST") return logout(request, env, url);
    const doc = pathname.match(/^\/api\/vault\/doc\/([A-Za-z0-9_-]{8,32})$/);
    if (doc && method === "GET") return getDoc(request, env, doc[1]);
    if (doc && method === "PUT") return putDoc(request, env, url, doc[1]);
    if (doc && method === "DELETE") return deleteDoc(request, env, url, doc[1]);

    if (pathname === "/api/vault/status" && method === "GET") return vaultStatus(request, env);
    if (pathname === "/api/vault" && method === "GET") return getVault(request, env);
    if (pathname === "/api/vault" && method === "PUT") return putVault(request, env, url);
    return json({ error: "Not found" }, 404);
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Everything that isn't the API is the static app. `run_worker_first` in
    // wrangler.jsonc means this branch is rarely reached, but a fork that drops
    // that setting still gets correct routing.
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(JSON.stringify({ msg: "api.error", path: url.pathname, error: String(err) }));
      return json({ error: "Something went wrong handling that request" }, 500);
    }
  },
};
