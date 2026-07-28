/* ============================================================
   mdread — local-first markdown reader. Entry point.
   Imports the stylesheet (Vite extracts it), wires the UI, and
   boots the app. All behaviour lives in ./modules/*.
   ============================================================ */

import "./styles/main.scss";

import { $, $$, app, searchInput, recentsToggle, recentsWrap, supportsFSA } from "./modules/dom.js";
import { state, prefs, savePrefs } from "./modules/state.js";
import { debounce } from "./modules/util.js";
import { idbDel } from "./modules/idb.js";

import { newDoc } from "./modules/document.js";
import { openFolder, openFiles, handleDrop, setRoot, wireFallbackInputs } from "./modules/files.js";
import { openSample } from "./modules/sample.js";
import { setSidebar, toggleFocus, setMode, applyPrefs } from "./modules/view.js";
import { closeLibrary, renderTree } from "./modules/tree.js";
import { saveDoc, downloadDoc } from "./modules/save.js";
import { toggleTypePop, hint, wireUi } from "./modules/ui.js";
import { renderRecents, getRecents } from "./modules/recents.js";
import { wireScroll } from "./modules/scroll.js";
import { wireEditor } from "./modules/editor.js";
import { wireShare, bootShare } from "./modules/share.js";
import { wireVault, bootVault } from "./modules/vault.js";
import { onKey } from "./modules/keyboard.js";
import { wireLaunch } from "./modules/launch.js";

function wire() {
  // sources
  $("#newDocBtn").addEventListener("click", () => newDoc());
  $("#openFolderBtn").addEventListener("click", openFolder);
  $("#openFilesBtn").addEventListener("click", openFiles);
  $("#welcomeNew").addEventListener("click", () => newDoc());
  $("#welcomeFolder").addEventListener("click", openFolder);
  $("#welcomeFiles").addEventListener("click", openFiles);
  $("#welcomeSample").addEventListener("click", openSample);

  // sidebar / focus
  $("#collapseBtn").addEventListener("click", () => setSidebar(false));
  $("#expandBtn").addEventListener("click", () => setSidebar(true));
  $("#scrim").addEventListener("click", () => setSidebar(false));
  $("#closeFolderBtn").addEventListener("click", closeLibrary);
  $("#focusBtn").addEventListener("click", toggleFocus);

  // search
  searchInput.addEventListener(
    "input",
    debounce(() => {
      state.filter = searchInput.value.trim();
      renderTree();
    }, 120)
  );

  // mode segmented
  $$(".seg [data-mode-val]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.modeVal)));

  // actions
  $("#saveBtn").addEventListener("click", saveDoc);
  $("#downloadBtn").addEventListener("click", downloadDoc);
  $("#tocBtn").addEventListener("click", () => {
    prefs.toc = !prefs.toc;
    savePrefs();
    applyPrefs();
  });
  $("#typeBtn").addEventListener("click", () => toggleTypePop($("#typeBtn")));

  // theme buttons (both groups)
  $$("[data-theme-val]").forEach((b) =>
    b.addEventListener("click", () => {
      prefs.theme = b.dataset.themeVal;
      savePrefs();
      applyPrefs();
    })
  );
  // font + dropcap + sliders
  $$("[data-font-val]").forEach((b) =>
    b.addEventListener("click", () => {
      prefs.font = b.dataset.fontVal;
      savePrefs();
      applyPrefs();
    })
  );
  $("#sizeRange").addEventListener("input", (e) => {
    prefs.size = +e.target.value;
    savePrefs();
    applyPrefs();
  });
  $("#widthRange").addEventListener("input", (e) => {
    prefs.width = +e.target.value;
    savePrefs();
    applyPrefs();
  });
  $("#dropcapToggle").addEventListener("click", () => {
    prefs.dropcap = !prefs.dropcap;
    savePrefs();
    applyPrefs();
  });

  // recent folders
  recentsToggle.addEventListener("click", () => {
    const open = recentsWrap.classList.toggle("open");
    recentsToggle.setAttribute("aria-expanded", String(open));
  });

  // drag + drop (whole window)
  const dz = $("#dropzone");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (++dragDepth === 1) dz.classList.add("is-active");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dz.classList.remove("is-active");
    }
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dz.classList.remove("is-active");
    await handleDrop(e.dataTransfer);
  });

  // keyboard
  window.addEventListener("keydown", onKey);

  // listeners that used to be attached at module top-level
  wireEditor();
  wireScroll();
  wireUi();
  wireShare();
  wireVault();
  wireFallbackInputs();

  // warn on unsaved
  window.addEventListener("beforeunload", (e) => {
    if (state.files.some((f) => f.dirty)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // add focus-exit hint element
  const fx = document.createElement("div");
  fx.className = "focus-exit";
  fx.textContent = "press f or esc to exit";
  document.body.appendChild(fx);
}

async function init() {
  applyPrefs();
  setSidebar(innerWidth > 820); // start collapsed on phones
  app.dataset.mode = "read";
  wire();

  // A /s/<id> or #d= link opens someone else's document instead of the local
  // library. Decryption happens here, in the browser — see modules/share.js.
  if (await bootShare()) return;

  // Restores the sign-in state if a session cookie survived. Never blocks:
  // sharing and reading work signed out, and the vault stays locked until the
  // master password is entered anyway.
  bootVault().catch(() => {});

  if (!supportsFSA) {
    hint(
      "Your browser can't save to disk directly — files open read-only and edits download. (Chrome/Edge support live editing.)"
    );
  }

  // restore recent folders; auto-open the most recent if still permitted
  try {
    await idbDel("root").catch(() => {}); // drop the deprecated key so a removed folder can't resurrect
    const recents = await getRecents();
    await renderRecents();
    const h = recents[0]?.handle;
    if (h && (await h.queryPermission({ mode: "readwrite" })) === "granted") {
      await setRoot(h);
    }
  } catch {}

  // OS file-handler, wired last on purpose. setRoot() above calls addFiles with
  // replace=true and then opens lastDoc, so a launch consumed any earlier gets
  // wiped from the tree and scrolled past. Claiming the queue after the restore
  // means the launched file appends to the library and wins the final openDoc.
  wireLaunch();

  // The service worker is registered automatically by vite-plugin-pwa (offline shell).
}

document.addEventListener("DOMContentLoaded", init);
