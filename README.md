# mdread

**A quiet reading room for your markdown.** Drop a file or a whole folder, read it
beautifully, edit it in place, and download it — all in the browser. Local-first:
your files never leave your device unless you choose to share, and share links are
end-to-end encrypted so the server can't read them either. Deploys to Cloudflare in
one command.

🔗 **Live: [mdread.app](https://mdread.app)** · MIT licensed · no accounts · no tracking

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/techjewel/mdread)

![mdread](public/og-image.png)

## What it does

- 📂 **Open a folder or files** — via the native file picker, or just **drag & drop**
  anything onto the page (a single `.md`, a stack of files, or an entire folder tree).
- 📖 **Read** — typography tuned for hours of long-form reading, using your OS's
  native reading serif (New York on Apple, Georgia elsewhere — no web fonts to
  download): comfortable measure and leading, oldstyle figures, a table of contents
  with scroll-spy, and a reading-progress bar.
- ✍️ **Edit** — Read / Split / Edit views. On Chrome & Edge, **Save writes straight
  back to the original file on disk** (File System Access API). Elsewhere it downloads.
- ⬇️ **Download** any document as a clean `.md`.
- 🔐 **Share** a file or a whole folder with a link. The document is encrypted in your
  browser (AES-GCM) and the key travels in the URL *fragment*, which browsers never
  send — so the server stores ciphertext it cannot read. Links expire, and you can
  revoke them. Small documents can use a **self-contained link** that uploads nothing
  at all: the whole encrypted document rides inside the URL.
- 🗄️ **Vault** — keep encrypted copies of documents in the cloud and open them from any
  device. Each document is sealed in your browser with a key derived from your **master
  password**, so the server stores bytes it cannot read. **Add to vault** sits in the
  toolbar beside the document; the sidebar previews your most recent, and **Show all**
  opens the full, searchable vault.
- 🔑 **Optional sign-in** for the vault, and to keep your share links when you clear your
  browser. Sign-in is a magic link — no password to manage — while the master password is
  the encryption key and never reaches the server. mdread stores `SHA-256(your email)` and
  blobs it can't read. **Everything except the vault works signed out.**
- 🎨 **Day / Sepia / Night** themes, adjustable text size, line width, typeface, and
  an optional drop cap.
- 🔌 **Offline** — installable PWA; the app shell is cached, so it works with no network.
- 🧠 **Remembers** your last folder, your last document, your reading position, and your
  preferences across visits.

Everything runs client-side with three small markdown libraries
([marked](https://marked.js.org), [DOMPurify](https://github.com/cure53/DOMPurify),
[highlight.js](https://highlightjs.org)) bundled and self-hosted, and **system fonts
only** — no third-party requests at runtime, ever. The only network call the app
ever makes is to its own origin, and only when you create or open a share link.

## Develop locally

```bash
npm install
npm run dev          # Vite dev server with hot reload → http://localhost:5173
```

Edit anything under `src/` and the page reloads. To check a production build the
way it's actually deployed:

```bash
npm run build        # bundles + compiles SCSS into ./dist
npm run preview      # serves ./dist → http://localhost:4173
```

The Vite dev server doesn't run the Worker, so `/api/*` isn't there and sharing is
unavailable under `npm run dev`. To exercise the share flow locally, run the real
thing (KV is simulated on disk, no Cloudflare account needed):

```bash
npm run dev:worker   # vite build && wrangler dev → http://localhost:8787
```

> **Note on editing:** live "save to disk" needs the File System Access API
> (Chrome/Edge, and over `http://localhost` or HTTPS). In other browsers files open
> read-only and edits download as new files. Reading works everywhere.

## Deploy to Cloudflare

### One-click (no CLI)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/techjewel/mdread)

Cloudflare clones this repo into your own GitHub, runs `npm run build`, and deploys
to a free `*.workers.dev` URL on your account. Every push to your copy then
auto-builds and deploys via Workers Builds. (The `mdread.app` custom domain lives in
the `production` environment, which the button doesn't use — you get your own URL.)

### From the CLI

Both paths below build first, then publish `./dist`.

#### Workers (recommended, uses `wrangler.jsonc`)

```bash
npm install
npx wrangler login   # or set CLOUDFLARE_ACCOUNT_ID for non-interactive / CI deploys
npm run deploy       # → a free *.workers.dev URL (what a fork gets out of the box)
npm run deploy:prod  # → your custom domain (uses the `production` env in wrangler.jsonc)
```

**Sharing and sign-in each need a KV namespace** on your own account:

```bash
npx wrangler kv namespace create SHARES          # share ciphertext
npx wrangler kv namespace create SHARES --preview
npx wrangler kv namespace create VAULT           # accounts + synced share list
npx wrangler kv namespace create VAULT --preview
```

Paste the returned ids into `kv_namespaces` in `wrangler.jsonc` (and the non-preview ones
into `env.production.kv_namespaces`). They're separate namespaces because shares expire
and vaults don't, and so you can run one feature without the other.

**Sign-in emails go through [ToSend](https://tosend.com/docs/api/send-email/).** Set these
as secrets:

```bash
npx wrangler secret put TOSEND_API_KEY     # from tosend.com
npx wrangler secret put MAIL_FROM          # e.g. "mdread <login@mdread.app>"
```

The sending domain has to be verified with ToSend first, or the API answers `422`.
`MAIL_FROM` accepts either `Name <addr@example.com>` or a bare address.

Without these, magic links are written to the Worker log instead of sent — which is
exactly how local development works. **They are never returned in an HTTP response**,
because a dev convenience that leaked into production would be a total authentication
bypass. Swapping providers means editing one file, `worker/email.js`.

Everything above is optional. Skip it all and the app still deploys and reads files
perfectly: the relevant API answers `501`, and the reader half needs no setup at all.

`wrangler.jsonc` doesn't hardcode an account or domain: the account comes from
`wrangler login` (or `CLOUDFLARE_ACCOUNT_ID`). The base config publishes to
`*.workers.dev`; the `env.production` block carries the custom domain, so
`deploy:prod` is the one that goes live on a real domain. To use your own domain,
change `name` and the `pattern` under `env.production.routes`.

#### Cloudflare Pages

```bash
npm run build
npx wrangler pages deploy dist --project-name markread
# or: npm run deploy:pages
```

…or in the Cloudflare dashboard: **Pages → Create → Connect/Direct upload**. Build
command `npm run build`, output directory `dist`.

> Pages deploys the static reader only — it doesn't pick up `worker/index.js`, so
> `/api/*` won't exist and stored share links won't work. Self-contained links still
> do, since they never touch a server. Use the Workers path above for full sharing.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `⌘/Ctrl + O` | Open folder |
| `⌘/Ctrl + S` | Save (to disk, or download) |
| `⇧ + ⌘/Ctrl + S` | Share (end-to-end encrypted link) |
| `⌘/Ctrl + E` | Toggle edit |
| `⌘/Ctrl + \` | Toggle sidebar |
| `t` | Toggle table of contents |
| `f` | Focus mode |
| `/` | Search files |
| `Esc` | Exit focus / close popover |

## Project layout

```
index.html            app shell (Vite entry)
src/
  main.js             entry: imports styles, wires the UI, boots the app
  modules/            one concern per file — files, tree, document, editor,
                      save, markdown, recents, scroll, view, ui, keyboard, …
    crypto.js         AES-GCM, gzip, and PBKDF2 primitives (pure, no app state)
    share.js          bundle format, share dialog, and the shared-link viewer
    vault.js          sign-in, master-password unlock, and share-list sync
  styles/             SCSS partials assembled by main.scss (themes, typography, layout)
public/               static assets copied verbatim: icons, manifest, og-image
worker/
  index.js            router — everything non-/api/* goes straight to assets
  shares.js           share ciphertext, with TTL and a delete token
  auth.js             magic links and sessions; stores SHA-256(email), never the address
  vault.js            one opaque blob per account
  email.js            mail adapter — ToSend, or the log in development
  lib.js              shared helpers (ids, hashing, bounded reads, cookies)
vite.config.js        build + PWA service-worker config
wrangler.jsonc        Cloudflare Workers config (serves ./dist, runs the API)
```

No framework — plain ES modules and SCSS. The service worker is generated by
`vite-plugin-pwa`. See [`CLAUDE.md`](CLAUDE.md) for an architecture tour and
[`CONTRIBUTING.md`](CONTRIBUTING.md) to get started.

## Privacy

There are no accounts, no analytics, and **no third-party requests at runtime** — not
even web fonts (the app uses your operating system's native fonts). Files are read in
your browser; the only persistence is local (IndexedDB stores folder handles so they
can be reopened; `localStorage` stores preferences, reading positions, and the links
you've created).

**Reading and editing never touch the network.** The one exception is sharing, and it
is designed so that opting in doesn't cost you the guarantee:

- The document is sealed in your browser with **AES-GCM-256** before anything is sent.
- The key travels in the URL **fragment** (`…#k=…`). Browsers do not transmit fragments,
  so the key never reaches the server — not in a request, not in a log, not in KV.
- The server stores an opaque blob under a random id. We cannot decrypt it, and neither
  could anyone who obtained the whole KV namespace without also having the links.
- Links **expire** (7 / 30 / 365 days) and can be **revoked** from the share dialog.
- A **self-contained link** skips the server entirely — the encrypted document lives in
  the URL itself, so nothing is uploaded at all.

The trade-off worth knowing: **the link _is_ the password.** Anyone who has it can read
the document, so treat it accordingly — and because the key never leaves your side, a
lost link cannot be recovered by us. Being unable to help is the point.

### Accounts and the vault

Signing in is optional. It exists so your **share links** and any documents you explicitly
put in the **vault** survive a cleared browser or follow you to another device. Nothing is
uploaded unless you press **+**; opening and editing local files never touches the network.

Two credentials, two jobs, deliberately separated:

| | Purpose | Does the server see it? |
| --- | --- | --- |
| Email magic link | Proves which account you are | Only `SHA-256(email)` is stored |
| Master password | Encrypts the link list | **Never.** Not hashed, not sent, not at all |

The master password is stretched with PBKDF2-SHA256 (600,000 iterations) in your browser,
using your email as the salt. **The password itself is never stored anywhere, in any form.**

By default the derived key is kept in IndexedDB so a reload doesn't ask again ("Stay
unlocked on this device"; untick it and the key lives only for that tab's lifetime). This
is safe in a way that stashing a password in `localStorage` would not be: the key is
created **non-extractable**, so it can be used for encrypt/decrypt but `exportKey` refuses
to return its bytes — to mdread, and to anything injected into the page. The honest
residual risk, which the checkbox states: anyone who can use that browser profile can open
the vault. **Lock now** and **Sign out** both erase the stored key.

**A forgotten master password cannot be reset.** Not by you, not by us — the server has
no copy of it and no copy of the key. That's the direct consequence of the server being
unable to read your vault, and mdread says so before you set one. Write it down.

Storage layout: the vault **index** (share links, plus document names and sizes) is one
encrypted blob; each document **body** is its own encrypted blob, so saving one document
doesn't rewrite the rest. Bodies are fetched and decrypted on open and are never cached
in plaintext on the device. Limits are 1 MB per document and 200 documents.

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[`Code of Conduct`](CODE_OF_CONDUCT.md). The app is plain ES modules in `src/modules/`
and SCSS in `src/styles/`, so it's quick to find your way around.

## License

[MIT](LICENSE) © techjewel
