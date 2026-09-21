/* Markdown → sanitized HTML → reading surface, plus heading anchors and TOC.
   marked, DOMPurify and highlight.js are now bundled dependencies (they used to
   be vendored globals), so they're always present — no window guards needed. */

import { marked } from "marked";
import DOMPurify from "dompurify";
// /lib/common = ~35 common languages, matching the original vendored build
// (~120 KB). The full "highlight.js" entry bundles ~190 languages (~980 KB).
import hljs from "highlight.js/lib/common";

import { $$, reading, tocList } from "./dom.js";
import { slug } from "./util.js";

marked.setOptions({ gfm: true, breaks: false });

const toHtml = (md) => DOMPurify.sanitize(marked.parse(md), { ADD_ATTR: ["target"] });

const isHeading = (el) => /^H[1-4]$/.test(el.tagName);
const holdsHeading = (el) => isHeading(el) || !!el.querySelector?.("h1, h2, h3, h4");

// A heading's own text, ignoring the ¶ anchor we append to it.
const headingLabel = (h) =>
  [...h.childNodes]
    .filter((n) => !(n.nodeType === 1 && n.classList?.contains("anchor")))
    .map((n) => n.textContent)
    .join("")
    .trim();

/* Assign heading ids and ¶ anchors across the whole column and return the TOC
   items. Ids have to be derived in document order for the duplicate suffixes to
   be stable, so this always walks every heading — it is cheap, and re-running it
   is what keeps patchMarkdown()'s partial updates consistent with a full render. */
function indexHeadings() {
  const seen = {};
  const items = [];
  for (const h of $$("h1, h2, h3, h4", reading)) {
    const text = headingLabel(h);
    let id = slug(text);
    if (seen[id]) id = `${id}-${++seen[id]}`;
    else seen[id] = 1;
    h.id = id;

    let a = h.querySelector(":scope > a.anchor");
    if (!a) {
      a = document.createElement("a");
      a.className = "anchor";
      a.textContent = "¶";
      a.setAttribute("aria-hidden", "true");
      h.appendChild(a);
    }
    a.href = `#${id}`;

    items.push({ id, text, level: +h.tagName[1] });
  }
  return items;
}

function highlightIn(el) {
  const blocks = el.matches("pre") ? el.querySelectorAll("code") : el.querySelectorAll("pre code");
  for (const block of blocks) {
    try {
      hljs.highlightElement(block);
    } catch {}
  }
}

function linksIn(el) {
  const anchors = el.matches('a[href^="http"]') ? [el] : [...el.querySelectorAll('a[href^="http"]')];
  for (const a of anchors) {
    if (a.host !== location.host) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }
}

/* The pristine, pre-decoration HTML of each top-level block is stashed on the
   node so patchMarkdown() can compare like with like — by the time a block is
   on screen it has picked up a heading id, a ¶ anchor and hljs classes that a
   freshly parsed block does not have. */
function adopt(el) {
  el.__src = el.outerHTML;
}

export function renderMarkdown(md) {
  reading.innerHTML = toHtml(md);
  const kids = [...reading.children];
  for (const el of kids) adopt(el);
  buildToc(indexHeadings());
  for (const el of kids) {
    highlightIn(el);
    linksIn(el);
  }
}

/* Same result as renderMarkdown, written into the live column block by block.
   Only top-level blocks whose HTML actually changed are replaced, so editing one
   paragraph repaints that paragraph instead of tearing down the whole reading
   surface, rebuilding the TOC and re-running highlight.js over every code block.

   That matters most for co-editing: someone else's keystrokes arrive many times
   a second, and a full swap of #reading on each one reads as flicker (and drops
   the scroll offset of a reader who isn't the one typing). */
export function patchMarkdown(md) {
  const next = document.createElement("div");
  next.innerHTML = toHtml(md);

  const oldKids = [...reading.children];
  const newKids = [...next.children];
  const touched = [];
  let headingsChanged = false;

  for (let i = 0; i < Math.max(oldKids.length, newKids.length); i++) {
    const a = oldKids[i];
    const b = newKids[i];

    if (!b) {
      if (holdsHeading(a)) headingsChanged = true;
      a.remove();
      continue;
    }

    if (!a) {
      adopt(b);
      reading.appendChild(b);
      touched.push(b);
      if (holdsHeading(b)) headingsChanged = true;
      continue;
    }

    // Unchanged blocks are never touched, so the browser never repaints them.
    if (a.__src === b.outerHTML) continue;

    if (holdsHeading(a) || holdsHeading(b)) headingsChanged = true;
    adopt(b);
    a.replaceWith(b);
    touched.push(b);
  }

  if (headingsChanged) buildToc(indexHeadings());
  for (const el of touched) {
    highlightIn(el);
    linksIn(el);
  }
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
