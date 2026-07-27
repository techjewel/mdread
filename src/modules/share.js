/* End-to-end encrypted sharing.

   mdread stays local-first: nothing leaves the device until you press Share,
   and even then the server only ever holds ciphertext. The AES key lives in
   the URL *fragment*, which browsers never transmit — so the link is the
   capability, and we cannot read what you shared.

   Two link shapes, both handled by `bootShare()` at startup:
     /s/<id>#k=<key>   stored  — ciphertext in Workers KV, expires
     #d=<payload>      self-contained — nothing is uploaded at all

   A share bundle is JSON: { v, kind, name, files: [{ path, name, content }] }
   It is gzipped and sealed by crypto.js before it ever touches the network. */

import { state } from "./state.js";
import { $, $$, app, MD_RE } from "./dom.js";
import { readJSON } from "./util.js";
import { newKey, exportKey, importKey, seal, open as unseal, toB64url, fromB64url } from "./crypto.js";
import { renderTree } from "./tree.js";
import { openDoc } from "./document.js";
import { toast } from "./ui.js";
import { syncSoon, onVaultChange } from "./vault.js";

const BUNDLE_V = 1;
const KEY_BYTES = 32; // raw AES-256 key, appended to self-contained payloads
const MAX_PLAINTEXT = 2 * 1024 * 1024; // 2 MB of markdown is a very large folder
const MAX_PAYLOAD = 1024 * 1024; // matches the Worker's cap
const INLINE_MAX = 8000; // base64url chars — keeps self-contained links pasteable
const SHARES_KEY = "markread:shares";

/* ---------------- the local record of what you've shared ----------------
   Kept so you can re-copy or revoke a link later. The key is stored too:
   it's your own document, on your own device, and without it the entry
   would be useless. Never sent anywhere. */

export const readShares = () => {
  const v = readJSON(SHARES_KEY);
  return Array.isArray(v) ? v : [];
};
export const writeShares = (list) => localStorage.setItem(SHARES_KEY, JSON.stringify(list));

/* Revocations need to survive a merge, or a share deleted on one device would
   be resurrected by the next sync from another. Tombstones are kept for a year,
   comfortably longer than the maximum share lifetime. */
const TOMB_KEY = "markread:shares:removed";
const TOMB_TTL = 400 * 86400000;

export const readTombstones = () => {
  const v = readJSON(TOMB_KEY);
  return (Array.isArray(v) ? v : []).filter((t) => Date.now() - t.at < TOMB_TTL);
};
export const writeTombstones = (list) => localStorage.setItem(TOMB_KEY, JSON.stringify(list));

function rememberShare(rec) {
  writeShares([rec, ...readShares().filter((s) => s.id !== rec.id)].slice(0, 200));
  syncSoon();
}

function forgetShare(id) {
  writeShares(readShares().filter((s) => s.id !== id));
  writeTombstones([{ id, at: Date.now() }, ...readTombstones().filter((t) => t.id !== id)]);
  syncSoon();
}

/* ---------------- building a bundle ---------------- */

async function contentOf(f) {
  if (f.content != null) return f.content;
  if (f.handle) return (await f.handle.getFile()).text();
  if (f.file) return f.file.text();
  return "";
}

async function buildBundle(scope) {
  const picked = scope === "folder" ? state.files : [state.current];
  const files = [];
  let total = 0;

  for (const f of picked) {
    if (!f) continue;
    let content;
    try {
      content = await contentOf(f);
    } catch {
      continue; // a file we can no longer read just drops out of the bundle
    }
    total += content.length;
    if (total > MAX_PLAINTEXT) throw new Error("That's too much to share at once (over 2 MB of text)");
    files.push({ path: f.path, name: f.name, content });
  }

  if (!files.length) throw new Error("Nothing to share");
  const name = scope === "folder" ? state.rootName || "Shared folder" : files[0].name.replace(MD_RE, "");
  return { v: BUNDLE_V, kind: scope, name, files };
}

/* ---------------- creating a share ---------------- */

export async function createShare({ scope, inline, expiryDays }) {
  const bundle = await buildBundle(scope);
  const key = await newKey();
  const payload = await seal(key, JSON.stringify(bundle));
  const keyStr = await exportKey(key);

  if (inline) {
    // Nothing is uploaded, so there is no `#k=` to carry the key separately —
    // it rides along at the tail of the payload. Still never sent anywhere:
    // the whole thing lives in the fragment.
    const raw = fromB64url(keyStr);
    const withKey = new Uint8Array(payload.length + raw.length);
    withKey.set(payload, 0);
    withKey.set(raw, payload.length);

    const data = toB64url(withKey);
    if (data.length > INLINE_MAX) throw new Error("Too long for a self-contained link — use an encrypted link instead");
    return { url: `${location.origin}/#d=${data}`, inline: true, name: bundle.name };
  }

  if (payload.length > MAX_PAYLOAD) throw new Error("That's too much to share at once (over 1 MB encrypted)");

  const res = await fetch("/api/share", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-mdread-expiry-days": String(expiryDays) },
    body: payload,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Share failed (${res.status})`);
  }

  const { id, deleteToken, expiresAt } = await res.json();
  const url = `${location.origin}/s/${id}#k=${keyStr}`;
  rememberShare({ id, key: keyStr, deleteToken, name: bundle.name, kind: scope, count: bundle.files.length, expiresAt });
  return { url, inline: false, name: bundle.name, expiresAt };
}

export async function revokeShare(id) {
  const rec = readShares().find((s) => s.id === id);
  if (!rec) return;
  try {
    await fetch(`/api/share/${id}`, { method: "DELETE", headers: { "x-mdread-delete-token": rec.deleteToken } });
  } catch {
    /* the local record goes either way — a stale server entry still expires on its own */
  }
  forgetShare(id);
}

/* ---------------- receiving a share ---------------- */

function incomingLink() {
  const hash = location.hash || "";
  if (hash.startsWith("#d=")) return { inline: true, data: hash.slice(3) };

  const m = location.pathname.match(/^\/s\/([A-Za-z0-9_-]{6,64})\/?$/);
  const k = hash.startsWith("#k=") ? hash.slice(3) : "";
  if (m) return { inline: false, id: m[1], keyStr: k };
  return null;
}

// Returns true when the app booted into a shared document, so init() can skip
// restoring the local library.
export async function bootShare() {
  const link = incomingLink();
  if (!link) return false;

  app.dataset.shared = "loading";
  try {
    let payload, keyStr;

    if (link.inline) {
      const all = fromB64url(link.data);
      if (all.length <= KEY_BYTES) throw new Error("This link looks truncated");
      // A self-contained link carries its own key at the end of the payload.
      const split = all.length - KEY_BYTES;
      keyStr = toB64url(all.subarray(split));
      payload = all.subarray(0, split);
    } else {
      if (!link.keyStr) throw new Error("This link is missing its key — it may have been truncated when it was copied");
      keyStr = link.keyStr;
      const res = await fetch(`/api/share/${link.id}`);
      if (res.status === 404) throw new Error("This share has expired or been revoked");
      if (!res.ok) throw new Error(`Could not load this share (${res.status})`);
      payload = new Uint8Array(await res.arrayBuffer());
    }

    const json = await unseal(await importKey(keyStr), payload);
    const bundle = JSON.parse(json);
    if (bundle.v !== BUNDLE_V) throw new Error("This link was made by a newer version of mdread");

    await mountBundle(bundle);
    return true;
  } catch (e) {
    app.dataset.shared = "error";
    $("#sharedError").textContent = e.message || "This share could not be opened";
    return true; // still "handled" — don't fall through to the local library
  }
}

async function mountBundle(bundle) {
  state.shared = true;
  state.rootName = bundle.name;
  state.files = bundle.files.map((f) => ({
    name: f.name,
    path: f.path,
    content: f.content,
    handle: null,
    file: null,
    dirty: false,
    draft: false,
    fromShare: true,
  }));

  app.dataset.shared = "on";
  $("#sharedName").textContent = bundle.name;
  $("#sharedCount").textContent =
    bundle.kind === "folder" ? `${state.files.length} file${state.files.length === 1 ? "" : "s"}` : "shared document";

  renderTree();
  await openDoc(state.files[0]);
}

/* ---------------- the share dialog ---------------- */

const dlg = () => $("#shareDlg");

function syncDialog() {
  const folderScope = $("#shareScopeFolder");
  const n = state.files.length;
  folderScope.disabled = n < 2;
  folderScope.closest(".share__opt").hidden = n < 2;
  $("#shareFolderCount").textContent = `${n} file${n === 1 ? "" : "s"}`;
  $("#shareExpiryRow").hidden = $("#shareInline").checked;
  renderShareList();
}

function renderShareList() {
  const list = $("#shareList");
  const shares = readShares();
  $("#shareListWrap").hidden = !shares.length;
  list.innerHTML = "";

  for (const s of shares) {
    const row = document.createElement("div");
    row.className = "share__row";
    const left = document.createElement("div");
    left.className = "share__row-main";
    const title = document.createElement("span");
    title.className = "share__row-name";
    title.textContent = s.name;
    const meta = document.createElement("span");
    meta.className = "share__row-meta";
    const days = Math.max(0, Math.round((s.expiresAt - Date.now()) / 86400000));
    meta.textContent = `${s.kind === "folder" ? `${s.count} files` : "1 file"} · expires in ${days}d`;
    left.append(title, meta);

    const copy = document.createElement("button");
    copy.className = "btn btn--tiny";
    copy.textContent = "Copy link";
    copy.addEventListener("click", () => copyLink(`${location.origin}/s/${s.id}#k=${s.key}`));

    const kill = document.createElement("button");
    kill.className = "btn btn--tiny btn--danger";
    kill.textContent = "Revoke";
    kill.addEventListener("click", async () => {
      kill.disabled = true;
      await revokeShare(s.id);
      renderShareList();
      toast("Link revoked");
    });

    row.append(left, copy, kill);
    list.append(row);
  }
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied ✓");
  } catch {
    toast("Copy failed — select the link and copy manually");
  }
}

export function openShareDialog() {
  if (state.shared) return; // you're reading someone else's share — nothing of yours to share
  if (!state.current) return toast("Open a document first");
  $("#shareResult").hidden = true;
  $("#shareCreate").hidden = false;
  $("#shareError").hidden = true;
  syncDialog();
  dlg().showModal();
}

export function wireShare() {
  const d = dlg();
  if (!d) return;

  $("#shareBtn").addEventListener("click", openShareDialog);
  $("#shareClose").addEventListener("click", () => d.close());
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close(); // backdrop
  });
  $$("input[name=shareLinkType]").forEach((r) => r.addEventListener("change", syncDialog));

  $("#shareCreate").addEventListener("click", async () => {
    const btn = $("#shareCreate");
    const err = $("#shareError");
    btn.disabled = true;
    btn.textContent = "Encrypting…";
    err.hidden = true;
    try {
      const out = await createShare({
        scope: $("#shareScopeFolder").checked ? "folder" : "file",
        inline: $("#shareInline").checked,
        expiryDays: +$("#shareExpiry").value,
      });
      $("#shareUrl").value = out.url;
      $("#shareResult").hidden = false;
      btn.hidden = true;
      $("#shareUrl").select();
      renderShareList();
    } catch (e) {
      err.textContent = e.message || "Could not create the link";
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Create link";
    }
  });

  $("#shareCopy").addEventListener("click", () => copyLink($("#shareUrl").value));

  // A vault pull can add links made on another device, so the list re-renders
  // whenever a sync settles.
  onVaultChange(renderShareList);
}
