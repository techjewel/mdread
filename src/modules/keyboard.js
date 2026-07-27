/* Global keyboard shortcuts. Attached to window from main. */

import { app, typePop, searchInput } from "./dom.js";
import { state, prefs, savePrefs } from "./state.js";
import { saveDoc } from "./save.js";
import { openFolder } from "./files.js";
import { setMode, toggleSidebar, toggleFocus, setSidebar, applyPrefs } from "./view.js";
import { openShareDialog } from "./share.js";

export function onKey(e) {
  const meta = e.metaKey || e.ctrlKey;
  const inField = /input|textarea/i.test(e.target.tagName);

  // ⇧⌘S must be tested before ⌘S — both match once the key is lowercased.
  if (meta && e.shiftKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    openShareDialog();
    return;
  }
  if (meta && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveDoc();
    return;
  }
  if (meta && e.key.toLowerCase() === "o") {
    e.preventDefault();
    openFolder();
    return;
  }
  if (meta && e.key.toLowerCase() === "e") {
    e.preventDefault();
    // The mode switcher is hidden while reading a share, so honouring this
    // would strand the reader in an editor with no visible way back.
    if (!state.shared) setMode(app.dataset.mode === "read" ? "split" : "read");
    return;
  }
  if (meta && e.key === "\\") {
    e.preventDefault();
    toggleSidebar();
    return;
  }

  if (e.key === "Escape") {
    if (!typePop.hidden) {
      typePop.hidden = true;
      return;
    }
    if (app.dataset.focus === "on") {
      toggleFocus();
      return;
    }
  }
  if (inField) return;

  if (e.key === "/") {
    e.preventDefault();
    setSidebar(true);
    searchInput.focus();
  } else if (e.key === "t") {
    prefs.toc = !prefs.toc;
    savePrefs();
    applyPrefs();
  } else if (e.key === "f") {
    toggleFocus();
  }
}
