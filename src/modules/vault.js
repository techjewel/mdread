/* The vault: your list of share links, synced across devices without the
   server ever being able to read it.

   Two credentials doing two different jobs:

     email          identity. A magic link proves you control it, which lets you
                    *fetch* your blob. The server stores only SHA-256(email).
     master password the key. Stretched with PBKDF2 in crypto.js and never sent
                    anywhere, in any form, ever.

   That split is what makes "the server can't read it" survive having accounts.
   It also means a forgotten master password is unrecoverable — by us or by
   anyone. That is the deal, and the UI says so before you set one.

   The blob itself is sealed with the same AES-GCM format as a share bundle. */

import { deriveVaultKey, seal, open as unseal } from "./crypto.js";
import { readShares, writeShares, readTombstones, writeTombstones } from "./share.js";
import { debounce } from "./util.js";
import { $ } from "./dom.js";
import { toast } from "./ui.js";

const VAULT_V = 1;

/* Session-scoped, deliberately not persisted: the derived key lives in memory
   only, so closing the tab re-locks the vault. */
let vaultKey = null;
let vaultEmail = "";

export const vaultState = {
  signedIn: false, // a valid session cookie exists
  unlocked: false, // …and the master password has been entered this session
  email: "",
  syncing: false,
  lastError: "",
};

/* ---------------- server calls ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export async function requestMagicLink(email) {
  await api("/api/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function refreshSession() {
  try {
    const me = await api("/api/auth/me");
    vaultState.signedIn = !!me?.signedIn;
  } catch {
    vaultState.signedIn = false;
  }
  return vaultState.signedIn;
}

export async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* the local session is dropped either way */
  }
  vaultKey = null;
  vaultEmail = "";
  Object.assign(vaultState, { signedIn: false, unlocked: false, email: "", lastError: "" });
}

/* ---------------- merge ----------------
   Union by id, minus anything tombstoned on either side. Last writer wins per
   record, which is fine because share records are immutable once created. */

function merge(local, remote) {
  const tombs = new Map();
  for (const t of [...(local.removed || []), ...(remote.removed || [])]) {
    if (!tombs.has(t.id) || t.at > tombs.get(t.id).at) tombs.set(t.id, t);
  }

  const shares = new Map();
  for (const s of [...(remote.shares || []), ...(local.shares || [])]) shares.set(s.id, s);
  for (const id of tombs.keys()) shares.delete(id);

  return {
    shares: [...shares.values()].sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0)),
    removed: [...tombs.values()],
  };
}

const localSnapshot = () => ({ shares: readShares(), removed: readTombstones() });

function applyLocally({ shares, removed }) {
  writeShares(shares);
  writeTombstones(removed);
}

/* ---------------- unlock / sync ---------------- */

// Derives the key, pulls the remote blob, merges it in, and pushes the result.
// `isNew` skips the "wrong password" diagnosis for a vault being created.
export async function unlockVault(email, passphrase) {
  vaultState.lastError = "";
  vaultKey = await deriveVaultKey(email, passphrase);
  vaultEmail = email;

  const remote = await pullVault();
  const merged = merge(localSnapshot(), remote || { shares: [], removed: [] });
  applyLocally(merged);

  vaultState.unlocked = true;
  vaultState.email = email;
  await pushVault();
  return merged;
}

async function pullVault() {
  const res = await fetch("/api/vault", { credentials: "same-origin" });
  if (res.status === 404) return null; // first use — nothing stored yet
  if (!res.ok) throw new Error(`Could not reach your vault (${res.status})`);

  const payload = new Uint8Array(await res.arrayBuffer());
  if (!payload.length) return null;

  let json;
  try {
    json = await unseal(vaultKey, payload);
  } catch {
    // The blob is intact; the key is what's wrong.
    vaultKey = null;
    throw new Error("That master password doesn't match this vault");
  }
  const blob = JSON.parse(json);
  if (blob.v !== VAULT_V) throw new Error("This vault was written by a newer version of mdread");
  return blob;
}

export async function pushVault() {
  if (!vaultKey) return;
  vaultState.syncing = true;
  renderVault();
  try {
    const { shares, removed } = localSnapshot();
    const payload = await seal(vaultKey, JSON.stringify({ v: VAULT_V, shares, removed, updatedAt: Date.now() }));
    const res = await fetch("/api/vault", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    });
    if (!res.ok) throw new Error(`Sync failed (${res.status})`);
    vaultState.lastError = "";
  } catch (e) {
    vaultState.lastError = e.message || "Sync failed";
  } finally {
    vaultState.syncing = false;
    renderVault();
    onSync();
  }
}

/* Share create/revoke call this; it coalesces bursts into one upload. */
export const syncSoon = debounce(() => {
  if (vaultKey) pushVault();
}, 800);

/* share.js owns the link list rendering; it registers a callback rather than
   being imported here, since vault is imported *by* share. */
let onSync = () => {};
export const onVaultChange = (fn) => (onSync = fn);

/* ---------------- UI ----------------
   The account panel lives at the foot of the share dialog. Which pane shows is
   a data-vault attribute the stylesheet reacts to — no layout classes from JS. */

const EMAIL_KEY = "markread:vault:email";
const el = (id) => $(`#${id}`);
const setPane = (name) => (el("vault").dataset.vault = name);

function showError(msg) {
  const e = el("vaultErr");
  e.textContent = msg || "";
  e.hidden = !msg;
}

export function renderVault() {
  const status = el("vaultStatus");
  if (!status) return;

  if (vaultState.syncing) status.textContent = "syncing…";
  else if (vaultState.lastError) status.textContent = "sync failed";
  else if (vaultState.unlocked) status.textContent = "synced";
  else status.textContent = "";

  if (vaultState.unlocked) {
    const n = readShares().length;
    el("vaultCount").textContent = `${n} link${n === 1 ? "" : "s"}`;
    el("vaultWho").textContent = vaultState.email;
  }
  if (vaultState.lastError) showError(vaultState.lastError);
}

async function doSend() {
  const btn = el("vaultSend");
  const email = el("vaultEmail").value.trim();
  showError("");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    await requestMagicLink(email);
    localStorage.setItem(EMAIL_KEY, email); // so the unlock pane can prefill it
    setPane("sent");
  } catch (e) {
    showError(e.message || "Could not send that");
  } finally {
    btn.disabled = false;
    btn.textContent = "Email me a link";
  }
}

async function doUnlock() {
  const btn = el("vaultUnlock");
  const email = el("vaultEmail2").value.trim();
  const pass = el("vaultPass").value;
  showError("");
  if (!email || !pass) return showError("Both your email and master password are needed");

  btn.disabled = true;
  btn.textContent = "Unlocking…"; // PBKDF2 takes about a second on purpose
  try {
    await unlockVault(email, pass);
    localStorage.setItem(EMAIL_KEY, email);
    el("vaultPass").value = "";
    setPane("on");
    renderVault();
    onSync();
    toast("Vault unlocked ✓");
  } catch (e) {
    showError(e.message || "Could not unlock");
  } finally {
    btn.disabled = false;
    btn.textContent = "Unlock";
  }
}

export function wireVault() {
  if (!el("vault")) return;

  el("vaultSend").addEventListener("click", doSend);
  el("vaultEmail").addEventListener("keydown", (e) => e.key === "Enter" && doSend());
  el("vaultBack").addEventListener("click", () => {
    showError("");
    setPane("out");
  });
  el("vaultUnlock").addEventListener("click", doUnlock);
  el("vaultPass").addEventListener("keydown", (e) => e.key === "Enter" && doUnlock());
  el("vaultOut").addEventListener("click", async () => {
    await signOut();
    setPane("out");
    renderVault();
    toast("Signed out");
  });
}

// Called at boot. A surviving session cookie tells us *who* you are; the master
// password is still needed before any of it can be decrypted.
export async function bootVault() {
  const params = new URLSearchParams(location.search);
  const signin = params.get("signin");
  if (signin) {
    // Drop the marker so a reload doesn't repeat the message.
    history.replaceState(null, "", location.pathname + location.hash);
    if (signin === "expired") toast("That sign-in link has expired — request a new one");
  }

  if (!(await refreshSession())) return;

  const known = localStorage.getItem(EMAIL_KEY) || "";
  if (el("vaultEmail2")) el("vaultEmail2").value = known;
  setPane("locked");
  if (signin === "ok") toast("Signed in — enter your master password to sync");
}
