/* Markdown → sanitized HTML → reading surface, plus heading anchors and TOC.
   marked, DOMPurify and highlight.js are now bundled dependencies (they used to
   be vendored globals), so they're always present — no window guards needed. */

import { marked } from "marked";
import DOMPurify from "dompurify";
// /lib/common = ~35 common languages, matching the original vendored build
// (~120 KB). The full "highlight.js" entry bundles ~190 languages (~980 KB).
import hljs from "highlight.js/lib/common";

import { $$, reading, tocList } from "./dom.js";
import { slug, copyText } from "./util.js";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md) {
  const raw = marked.parse(md);
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  reading.innerHTML = clean;

  // heading ids + anchors → TOC
  const heads = $$("h1, h2, h3, h4", reading);
  const seen = {};
  const items = [];
  for (const h of heads) {
    let id = slug(h.textContent);
    if (seen[id]) id = `${id}-${++seen[id]}`;
    else seen[id] = 1;
    h.id = id;
    const a = document.createElement("a");
    a.className = "anchor";
    a.href = `#${id}`;
    a.textContent = "¶";
    a.setAttribute("aria-hidden", "true");
    h.appendChild(a);
    items.push({
      id,
      text: h.firstChild?.textContent?.trim() || h.textContent.replace("¶", "").trim(),
      level: +h.tagName[1],
    });
  }
  buildToc(items);

  // syntax highlight + a hover "Copy" button on each block
  for (const block of $$("pre code", reading)) {
    try {
      hljs.highlightElement(block);
    } catch {}
    addCopyButton(block);
  }

  // external links open in new tab
  for (const a of $$('a[href^="http"]', reading)) {
    if (a.host !== location.host) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }
}

// Icons match the toolbar's style (24×24 viewBox, currentColor stroke). Both are
// rendered into the button and stacked; the CSS crossfades between them on
// `.is-copied`, so the copy→check swap animates smoothly.
const COPY_ICON = `<svg class="ic ic-copy" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK_ICON = `<svg class="ic ic-check" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Give a code block a copy button. Clicking copies the raw text; toggling
// `.is-copied` crossfades the icon to a checkmark (the tooltip confirms, or
// reports failure) before resetting.
//
// The button hangs off a wrapper rather than the <pre> itself. The <pre> is the
// `overflow-x: auto` scroll container, and an absolutely positioned child of a
// scroll container is part of its scrollable area — on a code block wide enough
// to scroll, the button slides out of view with the code. The wrapper doesn't
// scroll, so the button stays pinned.
function addCopyButton(block) {
  const pre = block.parentElement;
  if (!pre || pre.parentElement?.classList.contains("code-wrap")) return;
  const wrap = document.createElement("div");
  wrap.className = "code-wrap";
  pre.replaceWith(wrap);
  wrap.appendChild(pre);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.innerHTML = COPY_ICON + CHECK_ICON;
  btn.title = "Copy";
  btn.setAttribute("aria-label", "Copy code to clipboard");
  let resetT;
  btn.addEventListener("click", async () => {
    const ok = await copyText(block.textContent);
    btn.classList.toggle("is-copied", ok);
    btn.title = ok ? "Copied" : "Copy failed";
    clearTimeout(resetT);
    resetT = setTimeout(() => {
      btn.classList.remove("is-copied");
      btn.title = "Copy";
    }, 1500);
  });
  wrap.appendChild(btn);
}

function buildToc(items) {
  tocList.innerHTML = "";
  for (const it of items) {
    const a = document.createElement("a");
    a.href = `#${it.id}`;
    a.textContent = it.text;
    a.className = `lvl-${it.level}`;
    a.dataset.id = it.id;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(it.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    tocList.appendChild(a);
  }
}
