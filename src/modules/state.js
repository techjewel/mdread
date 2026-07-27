/* Shared, mutable app state plus persisted preferences and reading positions. */

import { readJSON, debounce } from "./util.js";

export const state = {
  files: [], // { name, path, handle?, file?, content?, dirty?, draft?, fromShare? }
  current: null,
  rootHandle: null,
  rootName: "",
  filter: "",
  shared: false, // booted from a share link — read-only, no local library
};

/* ---------------- Preferences ---------------- */
const PREFS_KEY = "markread:prefs";
export const prefs = Object.assign(
  {
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day",
    font: "sans",
    size: 92, // smallest by default
    width: 72, // widest by default
    dropcap: false,
    toc: false,
  },
  readJSON(PREFS_KEY)
);

export function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/* ---------------- Reading positions ---------------- */
const POS_KEY = "markread:pos";
export const positions = readJSON(POS_KEY);
export const savePositions = debounce(() => localStorage.setItem(POS_KEY, JSON.stringify(positions)), 400);
