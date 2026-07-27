# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first Markdown reader/editor. **No framework, no tests.** It's a Vite + SCSS app
of plain ES modules; files are read in the browser and nothing is uploaded unless the
user explicitly shares. `vite build` bundles `src/` + `public/` into `dist/`, and `dist/`
is what Cloudflare serves.

There is now **one small backend** under `worker/`, running only for `/api/*`. It is
deliberately *blind* in two places, and both are load-bearing:

- **Shares** — the browser seals a bundle with AES-GCM and the key travels in the URL
  fragment, which is never transmitted. Do not "improve" this by moving encryption
  server-side or by putting the key in a query string or path segment.
- **Vault** (synced share links *and* documents the user explicitly saved) — encrypted
  with a key stretched from the user's master password via PBKDF2, client-side. The
  server stores `SHA-256(email)` and blobs. Do not add a password-reset flow: there is
  nothing to reset, and adding one would mean holding the key.

Reading and editing local files still never touch the network — the vault is opt-in per
document, via **Add to vault** in the topbar. That button lives with the document it acts
on, not in the sidebar; the sidebar panel previews the five most recent and hands off to
`#vaultDlg` (the full, searchable vault) via "Show all".

**Vault storage is split deliberately.** The *index* (`vault:<acct>`) holds share links
plus a document listing (id, name, path, size, updatedAt). Each document *body* is its
own key (`vaultdoc:<acct>:<id>`), so saving one document doesn't rewrite the whole blob
and the index stays cheap to fetch on unlock. Bodies are never cached in plaintext
locally — only the index is, so the sidebar can render before anything is decrypted.

> Naming: the product/UI is "mdread" (and `wrangler.jsonc`/`package.json` `name`), but the
> directory, code comments, IndexedDB database, and `localStorage` keys all use **`markread`**.
> Both refer to the same thing — don't "fix" one to match the other.

## Commands

```bash
npm install
npm run dev       # Vite dev server, hot reload → http://localhost:5173  (no Worker: /api/* is absent, sharing disabled)
npm run dev:worker# vite build && wrangler dev → http://localhost:8787   (the real thing, KV simulated locally)
npm run build     # bundle + compile SCSS → ./dist
npm run preview   # serve ./dist as deployed → http://localhost:4173     (also no Worker)
npm run deploy        # vite build → wrangler deploy (Cloudflare Workers Assets)
npm run deploy:pages  # vite build → wrangler pages deploy dist  (static only — no share API)
```

No lint and no test runner. To verify a change: `npm run build` (Rolldown errors on any
unresolved import, so a green build means the module graph is sound), then `npm run preview`
and check it in Chrome/Edge — live "save to disk" needs the File System Access API, served
over `localhost` or HTTPS. **Anything touching sharing must be checked under
`npm run dev:worker`**, not `dev`/`preview`, because those don't run the Worker.

Note when testing under `wrangler dev`: the PWA service worker serves the *previous*
bundle on the first reload after a rebuild, so a code change often needs two reloads
before it's live. A stale error message is usually this, not a real bug.

## Architecture

`index.html` (repo root) is the Vite entry; it loads `src/main.js` as a module.
`src/main.js` imports the stylesheet, wires the DOM, and boots on `DOMContentLoaded`.
All behaviour lives in `src/modules/*.js` — plain ES modules, one concern each:

- `dom.js` — `$`/`$$`, cached element refs, shared constants (`MD_RE`, `supportsFSA`)
- `state.js` — the mutable `state` object, persisted `prefs`, reading `positions`
- `idb.js` — IndexedDB key/value store · `util.js` — pure helpers
- `markdown.js` — render pipeline · `files.js` / `tree.js` / `document.js` — sources, file tree, open/new doc
- `editor.js` / `save.js` — editing + saving · `view.js` / `scroll.js` / `ui.js` — modes, prefs, progress, toasts
- `crypto.js` — AES-GCM, gzip, and PBKDF2 primitives, pure bytes-in/bytes-out
- `share.js` — bundle format, the share dialog, and `bootShare()` (the shared-link viewer)
- `vault.js` — sign-in, master-password unlock, share-list sync, and vault documents
  (`data-vault` panes in the account dialog, `data-state` on the sidebar vault panel)
- `recents.js`, `sample.js`, `keyboard.js`

The modules form import **cycles** (e.g. `tree` ↔ `document`, `files` ↔ `recents`). This is
fine: imported bindings are only *called* at runtime, never used during module evaluation, so
ES module live bindings resolve them. Listeners that used to run at script load are now wrapped
in `wire*()` functions (`wireEditor`, `wireScroll`, `wireUi`, `wireFallbackInputs`) and called
from `main.js`'s `wire()`.

**State-driven UI is the central pattern.** JS never toggles classes for layout; it sets `data-*`
attributes and the SCSS reacts. UI state lives in attributes on `<html>` and `#app`: `data-theme`,
`data-dropcap`, `data-mode` (read/split/edit), `data-sidebar`, `data-focus`, `data-has-doc`,
`data-toc`, `data-shared` (`loading`/`on`/`error`). `applyPrefs()` in `view.js` is the single
place preferences flow into DOM attributes/CSS custom properties.

**Sharing** adds a second boot path. `init()` in `main.js` calls `bootShare()` *first*; if it
returns true the app mounted someone else's document and the local-library restore is skipped
entirely. Two link shapes, both parsed in `share.js`: `/s/<id>#k=<key>` (ciphertext in KV) and
`#d=<payload>` (self-contained — the whole encrypted doc lives in the fragment, nothing is
uploaded). `/s/<id>` resolves to the app shell via `not_found_handling: "single-page-application"`.

**File access cascades through three tiers** by browser capability — see `handleDrop()` in
`files.js`: (1) File System Access API handles (read+write, Chrome/Edge), (2) `webkitGetAsEntry`
directory walk (read-only), (3) plain `File` objects. `supportsFSA` gates pickers vs. the hidden
`<input>` fallbacks. The **file model** is `state.files[]`, each `{ name, path, handle?, file?,
content?, dirty?, draft? }`; `handle` (writable) vs. `file` (read-only) vs. neither (`draft`)
drives what `saveDoc()` does — it cascades write-through-handle → `showSaveFilePicker` → download.

**Rendering pipeline** (`markdown.js`): `marked.parse` → `DOMPurify.sanitize` → inject into
`#reading` → assign heading IDs + `¶` anchors → `buildToc` (scroll-spy via `scroll.js`) →
highlight code → rewrite external links to `target="_blank"`.

**Persistence**: IndexedDB (`markread` db, `kv` store) holds folder `handle`s — `recents`,
`lastDoc`. `localStorage` holds `markread:prefs`, `markread:pos` (per-path scroll ratio),
`markread:shares` (links you've created, *including their keys*, so they can be re-copied and
revoked), `markread:shares:removed` (revocation tombstones, so a sync can't resurrect a deleted
share), `markread:vault:email` (to prefill the unlock form), and `markread:vault:docs` +
`markread:vault:docs:removed` (the document *index* only — never document bodies). None of this
leaves the device except as ciphertext in the vault.

**The derived vault key** lives in a module-level variable in `vault.js` and, unless the user
unticks "Stay unlocked on this device", is also kept in IndexedDB under `vaultKey`. That is
only acceptable because `deriveVaultKey` creates it **non-extractable** — structured clone
keeps it usable while `exportKey` throws `InvalidAccessError`, so neither we nor injected
script can read the bytes. **Never make that key extractable**, and never persist the master
password itself. `lockVault()` and `signOut()` both `idbDel` it, as does boot when no session
survives.

⚠️ Inactive `.vault__pane` elements stay in the DOM (display:none), so `setPane()` **disables
their inputs**. Without that, hidden password fields make password managers attach their
inline menu and then disable themselves page-wide when the field vanishes — Bitwarden shows
"This page is interfering…". Keep any new credential field inside a pane.

⚠️ `openSample()` in `sample.js` sets `state.current` directly instead of going through
`openDoc()`, so anything that must react to "the current document changed" needs calling from
both. `renderVaultBox()` is wired into `openDoc`, `newDoc`, and `openSample` for this reason.

### Styles (SCSS)

`src/styles/main.scss` `@use`s the partials in cascade order (`_tokens`, `_base`, `_sidebar`,
`_column`, `_reading`, `_toc`, `_welcome`, `_components`, `_share`, `_responsive`). Order
matters — later partials win the cascade. `_share.scss` holds the dialog, the shared-document
banner, and the `[data-shared]` rules that hide save/mode/library controls when you're reading
someone else's document.

⚠️ The theme/typography **tokens in `_tokens.scss` are CSS custom properties on purpose**
(`--reading-scale`, `--measure`, `--body`, the per-theme color vars): JS reads and writes them at
runtime. Keep them as custom properties — do not convert to Sass variables. `_vars.scss` holds
only build-time Sass values (breakpoints) that compile away. (The main-column partial is
`_column.scss`, not `_main.scss`, because `@use "main"` would collide with the `main.scss` entry.)

## Build specifics

- **Markdown libs are bundled, not vendored.** `marked`, `dompurify`, `highlight.js` are npm
  dependencies imported in `markdown.js` and put in a `vendor` chunk (`vite.config.js`
  `manualChunks`, which must be a function — Vite 8 uses Rolldown). Still self-hosted = zero
  external runtime requests. **`highlight.js` is imported as `highlight.js/lib/common`** (~35
  languages, ~120 KB); the full entry pulls ~190 languages (~980 KB) — don't switch to it.
- **Service worker is generated by `vite-plugin-pwa`** (Workbox `generateSW`), so it precaches
  the hashed build assets automatically — there is no hand-maintained file list to bump anymore.
  Change caching in the `VitePWA({...})` block. `manifest: false` keeps the hand-written
  `public/manifest.webmanifest`. SW is disabled in `vite dev`.
- `public/` is copied verbatim to `dist/` root (icons, manifest, og-image). `wrangler.jsonc`
  serves `./dist` with `not_found_handling: "single-page-application"`. `wrangler.jsonc` does **not**
  hardcode an account — it comes from `wrangler login` or `CLOUDFLARE_ACCOUNT_ID` (set it for
  non-interactive/CI). It uses **wrangler environments**: the base config deploys to `*.workers.dev`
  (`npm run deploy`, the fork-friendly default), and `env.production` carries the `mdread.app`
  custom-domain route (`npm run deploy:prod` → `wrangler deploy --env production`). Bindings,
  `assets` and `routes` are all non-inherited keys, so they are **repeated inside
  `env.production`** — change one, change both. Forking requires changing `name`,
  `env.production.routes`, and the KV namespace ids.
- **Two KV namespaces**: `SHARES` (ciphertext, TTL'd) and `VAULT` (accounts, sessions, and
  vault blobs, no TTL). Create each with and without `--preview`; the ids in `wrangler.jsonc`
  are placeholders. Without them the matching routes answer `501` and the reader half still
  works perfectly. Sign-in mail goes through [ToSend](https://tosend.com/docs/api/send-email/)
  and needs the `TOSEND_API_KEY` / `MAIL_FROM` secrets; unset, magic
  links go to the Worker log. **Never return a magic link in a response** — that would be an
  authentication bypass, which is why `email.js` only ever logs it.
- `assets.run_worker_first: ["/api/*"]` keeps every non-API request on the pure-static path, so
  the reader never pays for the Worker. `compatibility_date` must not exceed what the installed
  wrangler's runtime supports (4.95.0 caps at `2026-06-02`) or `wrangler dev` refuses to boot.
