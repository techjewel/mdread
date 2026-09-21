/* Live co-editing — a CRDT over the same end-to-end encryption as sharing.
 *
 * SPIKE. Wired behind the "Live co-editing" checkbox in the share dialog.
 * Known gaps are listed at the bottom of this file.
 *
 * The unit of sync is a Yjs *update* — a few dozen bytes for a burst of
 * typing — not the document. Each one is sealed by crypto.js before it hits
 * the socket, so worker/room.js relays frames it cannot read; merging happens
 * here, in the browser, after decryption. The whole document only crosses the
 * wire when you join a room, exactly as it would without encryption.
 *
 * This module is only ever reached by dynamic import, so a reader who never
 * co-edits does not download Yjs.
 */

import * as Y from "yjs";
import { state } from "./state.js";
import { $, app, editor, docName, readingScroll } from "./dom.js";
import { debounce } from "./util.js";
import { sealBytes, openBytes, importKeyRW } from "./crypto.js";
import { renderMarkdown } from "./markdown.js";
import { renderTree } from "./tree.js";
import { setMode } from "./view.js";
import { updateSub } from "./document.js";
import { toast } from "./ui.js";

// Mirrors worker/room.js — change one, change both.
const T = { UPDATE: 1, SNAPSHOT: 2, SYNCED: 3, PEERS: 4, COMPACT: 5 };

// Transaction origins, so the binding can tell its own echo from a peer's edit.
const LOCAL = Symbol("collab:local");
const REMOTE = Symbol("collab:remote");

const BATCH_MS = 60; // merge a burst of keystrokes into one frame
const RETRY_MAX = 10000;

let room = null;
let lastRendered = null;

/* Re-rendering the preview is expensive: renderMarkdown() replaces the whole
   reading column, rebuilds every heading anchor and the TOC, and re-runs
   highlight.js over each code block. Local typing only pays that every 140ms
   (the liveRender debounce in editor.js), so remote edits must not pay it on
   every frame — at a 60ms batch that is ~16 full repaints a second, which is
   what makes someone else's typing look like flicker.

   The textarea still updates synchronously; only the preview waits. */
const renderSoon = debounce(() => {
  if (!room || app.dataset.mode === "edit") return;
  const text = room.ytext.toString();
  if (text === lastRendered) return;
  lastRendered = text;
  // Swapping innerHTML collapses the column for a frame, so the scroll offset
  // has to be put back or the page jumps under a reader who isn't typing.
  const top = readingScroll.scrollTop;
  renderMarkdown(text);
  readingScroll.scrollTop = top;
}, 140);

export const inRoom = () => !!room;
export const roomLink = () => (room ? `${location.origin}/c/${room.id}#k=${room.keyStr}` : "");

/* ---------------- joining ----------------

   `seed` is set by whoever created the link: their open document becomes the
   room's initial content. A guest passes null and adopts whatever is there. */

export async function enterRoom({ id, keyStr, seed = null }) {
  if (room) leaveRoom();

  const key = await importKeyRW(keyStr);
  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  const ymeta = doc.getMap("meta");

  room = { id, keyStr, key, doc, ytext, ymeta, ws: null, peers: 1, mounted: false, unbind: null };

  /* --- outgoing: every local transaction becomes a sealed frame --- */
  let pending = [];
  let batchT = 0;

  const flush = () => {
    batchT = 0;
    if (!pending.length) return;
    const merged = pending.length === 1 ? pending[0] : Y.mergeUpdates(pending);
    pending = [];
    send(T.UPDATE, merged);
  };

  doc.on("update", (update, origin) => {
    if (origin === REMOTE) return; // came off the wire; don't echo it back
    pending.push(update);
    if (!batchT) batchT = setTimeout(flush, BATCH_MS);
  });

  /* --- the socket --- */
  let chain = Promise.resolve();
  let retry = 500;

  function send(type, bytes) {
    // Sealing is async, so the chain keeps frames in the order they were made.
    chain = chain
      .then(async () => {
        if (room?.ws?.readyState !== WebSocket.OPEN) return;
        const sealed = await sealBytes(key, bytes);
        const frame = new Uint8Array(1 + sealed.length);
        frame[0] = type;
        frame.set(sealed, 1);
        room.ws.send(frame);
      })
      .catch(() => {});
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/room/${id}`);
    ws.binaryType = "arraybuffer";
    room.ws = ws;
    setStatus("connecting");

    ws.onopen = () => {
      retry = 500;
    };

    ws.onmessage = async (e) => {
      if (!room || typeof e.data === "string") return;
      const buf = new Uint8Array(e.data);
      const type = buf[0];
      const body = buf.subarray(1);

      if (type === T.UPDATE) {
        try {
          Y.applyUpdate(doc, await openBytes(key, body), REMOTE);
        } catch {
          // A frame we can't open means a wrong key, which is fatal for the
          // whole room — but one bad frame shouldn't kill a good session.
          setStatus("error");
        }
        return;
      }

      if (type === T.PEERS) {
        room.peers = body[0] || 1;
        setStatus("on");
        return;
      }

      if (type === T.COMPACT) {
        // We hold the key and the merged state, so we can collapse the log.
        send(T.SNAPSHOT, Y.encodeStateAsUpdate(doc));
        return;
      }

      if (type === T.SYNCED) {
        onSynced();
        setStatus("on");
      }
    };

    ws.onclose = () => {
      if (!room || room.ws !== ws) return;
      setStatus("offline");
      retry = Math.min(RETRY_MAX, retry * 2);
      room.retryT = setTimeout(connect, retry);
    };

    ws.onerror = () => ws.close();
  }

  function onSynced() {
    if (!room.mounted) {
      if (seed && ytext.length === 0) {
        // We made this room: publish what's already open.
        doc.transact(() => {
          ytext.insert(0, seed.text);
          ymeta.set("name", seed.name);
        }, LOCAL);
        // The textarea is the binding's baseline, so make certain it matches
        // what we just published before onInput can diff against it.
        editor.value = ytext.toString();
      } else if (!seed) {
        mountGuestDoc(ymeta.get("name") || "Shared document", ytext.toString());
      }
      room.unbind = bindEditor(doc, ytext);
      room.mounted = true;
      app.dataset.collab = "on";
    } else {
      // A reconnect. Push whatever we changed while the socket was down; the
      // CRDT makes the re-send harmless if the server already had it.
      send(T.UPDATE, Y.encodeStateAsUpdate(doc));
    }
  }

  connect();
  return room;
}

export function leaveRoom() {
  if (!room) return;
  clearTimeout(room.retryT);
  room.unbind?.();
  const ws = room.ws;
  room.ws = null; // stops onclose from reconnecting
  try {
    ws?.close();
  } catch {}
  room.doc.destroy();
  room = null;
  lastRendered = null;
  delete app.dataset.collab;
}

/* ---------------- the textarea binding ----------------

   The whole reason this spike is small: a plain <textarea> can drive a CRDT
   without becoming a custom editor. On input we diff old against new by common
   prefix and suffix — which covers typing, backspacing, paste and select-and-
   replace — and turn that into one delete + one insert. Remote edits splice the
   value back in and move the caret by the size of the changes ahead of it. */

function bindEditor(doc, ytext) {
  let applying = false;

  const onInput = () => {
    if (applying) return;
    const cur = ytext.toString();
    const next = editor.value;
    if (cur === next) return;

    let s = 0;
    const max = Math.min(cur.length, next.length);
    while (s < max && cur.charCodeAt(s) === next.charCodeAt(s)) s++;

    let ec = cur.length;
    let en = next.length;
    while (ec > s && en > s && cur.charCodeAt(ec - 1) === next.charCodeAt(en - 1)) {
      ec--;
      en--;
    }

    doc.transact(() => {
      if (ec > s) ytext.delete(s, ec - s);
      if (en > s) ytext.insert(s, next.slice(s, en));
    }, LOCAL);
  };

  const onChange = (ev, tr) => {
    if (tr.origin === LOCAL) return; // our own edit, already in the textarea
    const text = ytext.toString();
    const focused = document.activeElement === editor;
    const a = shiftCaret(ev.delta, editor.selectionStart, text.length);
    const b = shiftCaret(ev.delta, editor.selectionEnd, text.length);
    const top = editor.scrollTop;

    applying = true;
    editor.value = text;
    if (focused) editor.setSelectionRange(a, b);
    editor.scrollTop = top;
    applying = false;

    if (state.current) {
      state.current.content = text;
      state.current.dirty = true;
      updateSub();
    }
    // In edit mode there is no preview on screen to update.
    if (app.dataset.mode !== "edit") renderSoon();
  };

  editor.addEventListener("input", onInput);
  ytext.observe(onChange);

  return () => {
    editor.removeEventListener("input", onInput);
    ytext.unobserve(onChange);
  };
}

// Move a caret offset across a Yjs delta: anything inserted or deleted *before*
// it shifts it, anything after leaves it alone.
function shiftCaret(delta, pos, len) {
  let at = 0;
  let out = pos;
  for (const op of delta) {
    if (op.retain != null) at += op.retain;
    else if (typeof op.insert === "string") {
      if (at < out) out += op.insert.length;
      at += op.insert.length;
    } else if (op.delete != null) {
      if (at < out) out -= Math.min(op.delete, out - at);
    }
  }
  return Math.max(0, Math.min(out, len));
}

/* ---------------- guest arrival ---------------- */

function mountGuestDoc(name, text) {
  const f = {
    name: /\.\w+$/.test(name) ? name : name + ".md",
    path: name,
    content: text,
    handle: null,
    file: null,
    dirty: false,
    draft: true, // no handle on disk — Save offers "Save As"
    fromRoom: true,
  };
  state.files = [f];
  state.current = f;
  app.dataset.hasDoc = "true";
  docName.textContent = name.replace(/\.\w+$/, "");
  editor.value = text;
  renderMarkdown(text);
  lastRendered = text;
  updateSub();
  renderTree();
  setMode("split");
}

/* ---------------- status pill ---------------- */

function setStatus(stateName) {
  const pill = $("#collabPill");
  if (!pill) return;
  pill.dataset.state = stateName;
  const n = room?.peers || 1;
  pill.textContent =
    stateName === "on"
      ? n > 1
        ? `${n} editing`
        : "Live · just you"
      : stateName === "offline"
        ? "Reconnecting…"
        : stateName === "error"
          ? "Sync error"
          : "Connecting…";
}

/* ---------------- what this spike does not do ----------------

   - No cursors or selections for other people. Presence would ride the same
     sealed channel; it's just more protocol.
   - No local-file conflict story. If the room's document is also a file on
     disk behind a File System Access handle, remote edits rewrite the buffer
     under you and Save writes the merged result. That is the genuinely hard
     part and it is deliberately untouched here.
   - No revocation. The room lives until 30 days of silence (worker/room.js).
     Rotating the key means a new link, as with shares.
   - Rooms are not in the vault, so a link you make is not remembered anywhere.
   - `deriveDraftTitle` still renames a guest's draft from its first H1, so
     names can drift from the host's filename. Cosmetic, local-only. */
