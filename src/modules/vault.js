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

import { deriveVaultKey, seal, open as unseal, toB64url } from "./crypto.js";
import { readShares, writeShares, readTombstones, writeTombstones } from "./share.js";
import { debounce, readJSON } from "./util.js";
import { $, app, editor, MD_RE } from "./dom.js";
import { toast } from "./ui.js";
import { state } from "./state.js";
import { renderTree } from "./tree.js";
import { openDoc } from "./document.js";

/* v1 held only share links. v2 adds a document index; v1 blobs are migrated on
   read rather than rejected, so an existing vault keeps working. */
const VAULT_V = 2;

const DOCS_KEY = "markread:vault:docs";
const DOCS_TOMB_KEY = "markread:vault:docs:removed";
const MAX_DOC_BYTES = 1024 * 1024; // matches the Worker's per-document cap
const MAX_DOCS = 200;

/* The index (names, sizes) is kept locally so the sidebar can render without a
   round-trip. Document *bodies* are never cached in plaintext — they're fetched
   and decrypted on open, so nothing readable is left sitting on the device. */
export const readDocs = () => {
  const v = readJSON(DOCS_KEY);
  return Array.isArray(v) ? v : [];
};
export const writeDocs = (list) => localStorage.setItem(DOCS_KEY, JSON.stringify(list));

const readDocTombs = () => {
  const v = readJSON(DOCS_TOMB_KEY);
  return Array.isArray(v) ? v : [];
};
const writeDocTombs = (list) => localStorage.setItem(DOCS_TOMB_KEY, JSON.stringify(list));

const newDocId = () => toB64url(crypto.getRandomValues(new Uint8Array(9)));

/* Session-scoped, deliberately not persisted: the derived key lives in memory
   only, so closing the tab re-locks the vault. */
let vaultKey = null;

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
  lockVault();
  vaultState.signedIn = false;
}

/* Drops the derived key but keeps the session — the shared-machine case, and
   what closing the tab does implicitly. */
export function lockVault() {
  vaultKey = null;
  Object.assign(vaultState, { unlocked: false, email: "", lastError: "" });
}

/* ---------------- merge ----------------
   Union by id, minus anything tombstoned on either side. Last writer wins per
   record, which is fine because share records are immutable once created. */

function mergeList(localList, remoteList, localTombs, remoteTombs, sortBy) {
  const tombs = new Map();
  for (const t of [...(localTombs || []), ...(remoteTombs || [])]) {
    if (!tombs.has(t.id) || t.at > tombs.get(t.id).at) tombs.set(t.id, t);
  }

  const items = new Map();
  for (const s of [...(remoteList || []), ...(localList || [])]) {
    // Documents can genuinely change, so the newer edit wins rather than local.
    const prev = items.get(s.id);
    if (!prev || (s.updatedAt || 0) >= (prev.updatedAt || 0)) items.set(s.id, s);
  }
  for (const id of tombs.keys()) items.delete(id);

  return { items: [...items.values()].sort(sortBy), tombs: [...tombs.values()] };
}

function merge(local, remote) {
  const shares = mergeList(local.shares, remote.shares, local.removed, remote.removed, (a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  const docs = mergeList(local.docs, remote.docs, local.docsRemoved, remote.docsRemoved, (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { shares: shares.items, removed: shares.tombs, docs: docs.items, docsRemoved: docs.tombs };
}

const localSnapshot = () => ({
  shares: readShares(),
  removed: readTombstones(),
  docs: readDocs(),
  docsRemoved: readDocTombs(),
});

function applyLocally({ shares, removed, docs, docsRemoved }) {
  writeShares(shares);
  writeTombstones(removed);
  writeDocs(docs);
  writeDocTombs(docsRemoved);
}

/* ---------------- unlock / sync ---------------- */

/* Is there already a vault for this account? Asked *before* prompting, so
   first-time setup and a returning unlock can be worded differently instead of
   sharing one hedged screen. */
export async function vaultExists() {
  try {
    const { exists } = await api("/api/vault/status");
    return !!exists;
  } catch {
    return false;
  }
}

// Derives the key, pulls the remote blob, merges it in, and pushes the result.
// Used for both creating a vault and unlocking an existing one — the only
// difference is what the UI asked for beforehand.
export async function unlockVault(email, passphrase) {
  vaultState.lastError = "";
  vaultKey = await deriveVaultKey(email, passphrase);

  const remote = await pullVault();
  const merged = merge(localSnapshot(), remote || { shares: [], removed: [], docs: [], docsRemoved: [] });
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
  if (blob.v > VAULT_V) throw new Error("This vault was written by a newer version of mdread");
  // v1 predates document storage; the missing keys just default to empty.
  return { docs: [], docsRemoved: [], ...blob };
}

export async function pushVault() {
  if (!vaultKey) return;
  vaultState.syncing = true;
  renderVault();
  try {
    const snap = localSnapshot();
    const payload = await seal(vaultKey, JSON.stringify({ v: VAULT_V, ...snap, updatedAt: Date.now() }));
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

/* ---------------- documents ----------------
   Bodies are sealed with the same master-password key and stored one per
   request, so saving one document doesn't rewrite the rest. The index entry
   (name, size, timestamp) rides in the vault blob; the body never does. */

export const isUnlocked = () => !!vaultKey;
export const findDoc = (id) => readDocs().find((d) => d.id === id);

// Matching an existing entry by path means re-saving updates in place rather
// than piling up duplicates of the same file.
export const docForPath = (path) => readDocs().find((d) => d.path === path);

export async function saveDocToVault({ name, path, content }) {
  if (!vaultKey) throw new Error("Unlock your vault first");

  const bytes = new TextEncoder().encode(content || "").length;
  if (bytes > MAX_DOC_BYTES) throw new Error("That document is too large for the vault (1 MB maximum)");

  const existing = docForPath(path);
  if (!existing && readDocs().length >= MAX_DOCS) throw new Error(`The vault holds up to ${MAX_DOCS} documents`);

  const id = existing?.id || newDocId();
  const payload = await seal(vaultKey, JSON.stringify({ v: 1, name, path, content }));

  const res = await fetch(`/api/vault/doc/${id}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/octet-stream" },
    body: payload,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Could not save to the vault (${res.status})`);
  }

  const entry = { id, name, path, size: bytes, updatedAt: Date.now() };
  writeDocs([entry, ...readDocs().filter((d) => d.id !== id)]);
  await pushVault();
  return entry;
}

export async function fetchVaultDoc(id) {
  if (!vaultKey) throw new Error("Unlock your vault first");

  const res = await fetch(`/api/vault/doc/${id}`, { credentials: "same-origin" });
  if (res.status === 404) throw new Error("That document is no longer in your vault");
  if (!res.ok) throw new Error(`Could not open that document (${res.status})`);

  const payload = new Uint8Array(await res.arrayBuffer());
  const body = JSON.parse(await unseal(vaultKey, payload));
  return body;
}

export async function removeVaultDoc(id) {
  try {
    await fetch(`/api/vault/doc/${id}`, { method: "DELETE", credentials: "same-origin" });
  } catch {
    /* the index entry goes either way; a stray blob is unreadable regardless */
  }
  writeDocs(readDocs().filter((d) => d.id !== id));
  writeDocTombs([{ id, at: Date.now() }, ...readDocTombs().filter((t) => t.id !== id)]);
  await pushVault();
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
   Account controls live in their own dialog reached from the sidebar, not
   inside the per-document share dialog — signing in isn't a property of the
   document you happen to have open. Which pane shows is a data-vault attribute
   the stylesheet reacts to; no layout classes are toggled from JS.

   Panes: out → sent → (setup | locked) → on */

const EMAIL_KEY = "markread:vault:email";
const MIN_PASS = 10;
const el = (id) => $(`#${id}`);
const setPane = (name) => (el("vault").dataset.vault = name);
const knownEmail = () => localStorage.getItem(EMAIL_KEY) || "";

function showError(msg) {
  const e = el("vaultErr");
  if (!e) return;
  e.textContent = msg || "";
  e.hidden = !msg;
}

/* The sidebar entry and the share dialog's one-line summary both mirror vault
   state, so neither becomes the only place sync is visible. */
export function renderVault() {
  const btn = el("accountBtn");
  if (!btn) return;

  const mode = vaultState.unlocked ? "on" : vaultState.signedIn ? "locked" : "out";
  btn.dataset.acct = mode;
  el("accountLabel").textContent =
    mode === "on" ? (vaultState.syncing ? "Syncing…" : "Links synced") : mode === "locked" ? "Unlock your links" : "Sync your links";

  const line = el("shareSyncText");
  if (line) {
    line.textContent =
      mode === "on"
        ? `Synced to ${vaultState.email}`
        : mode === "locked"
          ? "Signed in — unlock to sync these links"
          : "These links live in this browser only";
    el("shareSyncAct").textContent = mode === "on" ? "Manage" : mode === "locked" ? "Unlock" : "Set up sync";
  }

  if (vaultState.unlocked) {
    const n = readShares().length;
    el("vaultCount").textContent = `${n} link${n === 1 ? "" : "s"}`;
    el("vaultWho").textContent = vaultState.email;
  }
  if (vaultState.lastError) showError(vaultState.lastError);
  renderVaultBox();
}

/* ---------------- the sidebar vault ---------------- */

const SIDEBAR_MAX = 5; // the sidebar previews; "Show all" opens the real thing

async function confirmRemove(d, btn) {
  btn.disabled = true;
  try {
    await removeVaultDoc(d.id);
    toast("Removed from vault");
  } catch {
    toast("Could not remove that");
    btn.disabled = false;
  }
  renderVaultBox();
  if (el("vaultDlg").open) renderVaultGrid();
}

const XMARK = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

// One row shape, two homes: the sidebar preview and the full grid.
function docRow(d, { wide }) {
  const row = document.createElement("div");
  row.className = wide ? "vcard" : "vrow";
  row.classList.toggle("is-current", state.current?.vaultId === d.id);

  const open = document.createElement("button");
  open.className = wide ? "vcard__open" : "vrow__open";
  open.title = d.path;

  const nm = document.createElement("span");
  nm.className = wide ? "vcard__name" : "vrow__name";
  nm.textContent = d.name.replace(MD_RE, "");

  const meta = document.createElement("span");
  meta.className = wide ? "vcard__meta" : "vrow__meta";
  meta.textContent = wide
    ? `${d.path} · ${fmtSize(d.size)} · saved ${fmtWhen(d.updatedAt)}`
    : `${fmtSize(d.size)} · ${fmtWhen(d.updatedAt)}`;

  open.append(nm, meta);
  open.addEventListener("click", async () => {
    await openFromVault(d);
    if (wide) el("vaultDlg").close();
  });

  const del = document.createElement("button");
  del.className = wide ? "vcard__del" : "vrow__del";
  del.setAttribute("aria-label", `Remove ${d.name} from your vault`);
  del.title = "Remove from vault";
  del.innerHTML = wide ? "Remove" : XMARK;
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    confirmRemove(d, del);
  });

  row.append(open, del);
  return row;
}

export function renderVaultBox() {
  const box = el("vaultBox");
  if (!box) return;

  const docs = readDocs();
  const mode = !vaultState.signedIn ? "out" : !vaultState.unlocked ? "locked" : docs.length ? "on" : "empty";
  box.dataset.state = mode;

  el("vaultBoxCount").textContent = mode === "on" ? String(docs.length) : "";
  el("vaultShowAll").hidden = mode !== "on";

  /* The add button lives in the topbar, with the document it acts on, rather
     than tucked into the sidebar. It states which of the two things it will do. */
  const add = el("vaultAddBtn");
  const canAdd = vaultState.unlocked && !!state.current && !state.shared;
  add.hidden = !canAdd;
  if (canAdd) {
    const already = docForPath(state.current.path);
    add.classList.toggle("is-saved", !!already);
    el("vaultAddLabel").textContent = already ? "In vault" : "Add to vault";
    add.title = already ? "Update the copy in your vault" : "Save this document to your vault";
  }

  const list = el("vaultList");
  list.innerHTML = "";
  const more = el("vaultMore");
  if (mode !== "on") {
    more.hidden = true;
    return;
  }

  for (const d of docs.slice(0, SIDEBAR_MAX)) list.append(docRow(d, { wide: false }));
  more.hidden = docs.length <= SIDEBAR_MAX;
  if (!more.hidden) more.textContent = `Show all ${docs.length}`;
}

/* ---------------- the full vault ---------------- */

export function renderVaultGrid() {
  const grid = el("vaultGrid");
  if (!grid) return;

  const q = el("vaultSearch").value.trim().toLowerCase();
  const all = readDocs();
  const docs = q ? all.filter((d) => `${d.name} ${d.path}`.toLowerCase().includes(q)) : all;

  el("vaultDlgStat").textContent = q
    ? `${docs.length} of ${all.length}`
    : `${all.length} document${all.length === 1 ? "" : "s"}`;

  grid.innerHTML = "";
  for (const d of docs) grid.append(docRow(d, { wide: true }));
  el("vaultNone").hidden = docs.length > 0 || !all.length;
}

function openVaultDialog() {
  el("vaultSearch").value = "";
  renderVaultGrid();
  const d = el("vaultDlg");
  if (!d.open) d.showModal();
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function fmtWhen(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(ts).toLocaleDateString();
}

async function openFromVault(entry) {
  try {
    const body = await fetchVaultDoc(entry.id);
    let f = state.files.find((x) => x.vaultId === entry.id);
    if (f) {
      f.content = body.content;
    } else {
      f = {
        name: body.name,
        path: body.path,
        content: body.content,
        handle: null,
        file: null,
        dirty: false,
        draft: false,
        vaultId: entry.id,
      };
      state.files.push(f);
      renderTree();
    }
    await openDoc(f);
    renderVaultBox();
  } catch (e) {
    toast(e.message || "Could not open that document");
  }
}

async function addCurrentToVault() {
  const f = state.current;
  if (!f) return;
  const btn = el("vaultAddBtn");
  btn.disabled = true;
  try {
    // Commit anything sitting in the editor before snapshotting.
    if (app.dataset.mode !== "read") f.content = editor.value;
    const entry = await saveDocToVault({ name: f.name, path: f.path, content: f.content ?? "" });
    f.vaultId = entry.id;
    toast("Saved to vault ✓");
  } catch (e) {
    toast(e.message || "Could not save to the vault");
  } finally {
    btn.disabled = false;
    renderVaultBox();
    if (el("vaultDlg").open) renderVaultGrid();
  }
}

async function doSend() {
  const btn = el("vaultSend");
  const email = el("vaultEmail").value.trim();
  showError("");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    await requestMagicLink(email);
    localStorage.setItem(EMAIL_KEY, email); // lets the next pane prefill it
    setPane("sent");
  } catch (e) {
    showError(e.message || "Could not send that");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send link";
  }
}

// Shared by "Create vault" and "Unlock" — same derivation, different wording.
async function enter(btn, email, pass, { confirm } = {}) {
  showError("");
  if (!email) return showError("Your email address is needed");
  if (!pass) return showError("Your master password is needed");
  if (confirm !== undefined) {
    if (pass.length < MIN_PASS) return showError(`Use at least ${MIN_PASS} characters — this is the only thing protecting your vault`);
    if (pass !== confirm) return showError("Those two passwords don't match");
  }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Working…"; // PBKDF2 takes about a second, on purpose
  try {
    await unlockVault(email, pass);
    localStorage.setItem(EMAIL_KEY, email);
    ["vaultPass", "vaultPass2", "vaultPassU"].forEach((id) => el(id) && (el(id).value = ""));
    setPane("on");
    renderVault();
    onSync();
    toast(confirm !== undefined ? "Vault created ✓" : "Vault unlocked ✓");
  } catch (e) {
    showError(e.message || "Could not unlock");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Chooses between setup and unlock, then shows the dialog.
async function openAccount() {
  showError("");
  const dlg = el("accountDlg");
  if (vaultState.unlocked) setPane("on");
  else if (!vaultState.signedIn) setPane("out");
  else {
    setPane((await vaultExists()) ? "locked" : "setup");
    const known = knownEmail();
    ["vaultEmail2", "vaultEmail3"].forEach((id) => el(id) && !el(id).value && (el(id).value = known));
  }
  if (!dlg.open) dlg.showModal();
}

export function wireVault() {
  if (!el("vault")) return;
  const dlg = el("accountDlg");

  el("accountBtn").addEventListener("click", openAccount);
  el("vaultAddBtn").addEventListener("click", addCurrentToVault);
  el("vaultBoxSignIn").addEventListener("click", openAccount);
  el("vaultBoxUnlock").addEventListener("click", openAccount);

  el("vaultShowAll").addEventListener("click", openVaultDialog);
  el("vaultMore").addEventListener("click", openVaultDialog);
  el("vaultDlgClose").addEventListener("click", () => el("vaultDlg").close());
  el("vaultDlg").addEventListener("click", (e) => e.target === el("vaultDlg") && el("vaultDlg").close());
  el("vaultSearch").addEventListener("input", debounce(renderVaultGrid, 120));
  el("shareSyncLine").addEventListener("click", () => {
    el("shareDlg").close();
    openAccount();
  });
  el("acctClose").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());

  el("vaultSend").addEventListener("click", doSend);
  el("vaultEmail").addEventListener("keydown", (e) => e.key === "Enter" && doSend());
  el("vaultBack").addEventListener("click", () => {
    showError("");
    setPane("out");
  });

  const create = () => enter(el("vaultCreate"), el("vaultEmail2").value.trim(), el("vaultPass").value, { confirm: el("vaultPass2").value });
  el("vaultCreate").addEventListener("click", create);
  el("vaultPass2").addEventListener("keydown", (e) => e.key === "Enter" && create());

  const unlock = () => enter(el("vaultUnlock"), el("vaultEmail3").value.trim(), el("vaultPassU").value);
  el("vaultUnlock").addEventListener("click", unlock);
  el("vaultPassU").addEventListener("keydown", (e) => e.key === "Enter" && unlock());

  // Drops the derived key without ending the session — useful on a shared machine.
  el("vaultLock").addEventListener("click", () => {
    lockVault();
    setPane("locked");
    el("vaultEmail3").value = knownEmail();
    renderVault();
    toast("Vault locked");
  });

  el("vaultOut").addEventListener("click", async () => {
    await signOut();
    setPane("out");
    renderVault();
    toast("Signed out");
  });

  renderVault();
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

  if (!(await refreshSession())) {
    renderVault();
    return;
  }
  renderVault();

  // Arriving fresh from a magic link, open the dialog rather than making the
  // user hunt for where to type the password they were just told about.
  if (signin === "ok") await openAccount();
}
