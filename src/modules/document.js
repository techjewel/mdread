/* Opening a document, the topbar subtitle (word count / status), and creating
   blank drafts whose title tracks the first H1 as you type. */

import { state, positions } from "./state.js";
import { app, docName, docSub, editor, readingScroll, MD_RE } from "./dom.js";
import { ensureMd } from "./util.js";
import { idbSet } from "./idb.js";
import { renderMarkdown } from "./markdown.js";
import { renderTree, refreshTreeState, updateCurrentFolder } from "./tree.js";
import { savePos, updateProgress } from "./scroll.js";
import { setMode } from "./view.js";
import { toast } from "./ui.js";
import { renderVaultBox } from "./vault.js";

export async function openDoc(file) {
  if (!file) return;
  // persist current scroll position before leaving
  if (state.current) savePos(state.current);

  if (file.content == null) {
    try {
      if (file.handle) file.content = await (await file.handle.getFile()).text();
      else if (file.file) file.content = await file.file.text();
      else file.content = "";
    } catch (e) {
      toast("Could not read file");
      return;
    }
  }

  state.current = file;
  app.dataset.hasDoc = "true";
  idbSet("lastDoc", file.path).catch(() => {});

  docName.textContent = file.name.replace(MD_RE, "");
  updateSub();
  renderMarkdown(file.content);
  editor.value = file.content;
  refreshTreeState();
  updateCurrentFolder();
  renderVaultBox(); // the "+" reflects whether *this* document is stored

  // restore reading position
  requestAnimationFrame(() => {
    const ratio = positions[file.path] || 0;
    readingScroll.scrollTop = ratio * (readingScroll.scrollHeight - readingScroll.clientHeight);
    updateProgress();
  });
}

export function updateSub() {
  const f = state.current;
  if (!f) return;
  const words = (f.content.match(/\S+/g) || []).length;
  const mins = Math.max(1, Math.round(words / 220));
  const status = f.handle ? "" : f.draft ? " · draft" : " · read-only";
  const dir = f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") + "  ·  " : "";
  docSub.textContent = `${dir}${words.toLocaleString()} words · ${mins} min${status}${f.dirty ? " · unsaved" : ""}`;
}

function uniqueDraftPath() {
  let n = 1,
    p;
  do {
    p = n === 1 ? "Untitled.md" : `Untitled ${n}.md`;
    n++;
  } while (state.files.some((f) => f.path === p));
  return p;
}

// Start a blank document (or one pre-filled with pasted text) in edit mode.
export function newDoc(content = "") {
  if (state.current) savePos(state.current);
  const f = { name: "Untitled.md", path: uniqueDraftPath(), content, handle: null, file: null, dirty: false, draft: true };
  state.files.push(f);
  renderTree();
  state.current = f;
  app.dataset.hasDoc = "true";
  docName.textContent = "Untitled";
  editor.value = content;
  renderMarkdown(content);
  updateSub();
  refreshTreeState();
  renderVaultBox();
  setMode("split");
  editor.focus();
  editor.setSelectionRange(content.length, content.length);
}

// Derive a draft's name/title from its first H1 as you type.
export function deriveDraftTitle(f) {
  if (!f.draft) return;
  const m = editor.value.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  const title = (m && m[1].trim()) || "Untitled";
  const name = ensureMd(title);
  if (f.name !== name) {
    f.name = name;
    docName.textContent = title;
    renderTree();
    refreshTreeState();
  }
}
