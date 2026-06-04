/* Small helpers shared across modules. Mostly pure (no DOM, no state); the one
   exception is copyText, which touches the clipboard / a throwaway DOM node. */

import { MD_RE } from "./dom.js";

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function slug(s) {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[¶]/g, "")
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

export function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 604800) return Math.floor(s / 86400) + "d";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const ensureMd = (name) => (MD_RE.test(name) ? name : name.replace(/[\/\\:]/g, "-").trim() + ".md");

export function byPath(a, b) {
  return a.path.localeCompare(b.path, undefined, { numeric: true });
}

export function readJSON(k) {
  try {
    return JSON.parse(localStorage.getItem(k)) || {};
  } catch {
    return {};
  }
}

// Copy text to the clipboard. The async Clipboard API only exists in a secure
// context (HTTPS, localhost/loopback) — on a plain-HTTP origin like a self-hosted
// LAN IP, navigator.clipboard is undefined. So feature-detect, then fall back to
// a temporary <textarea> + execCommand("copy"), which works over plain HTTP too.
// Resolves true on success, false otherwise.
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}


