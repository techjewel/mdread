# Security Policy

mdread is a client-side, local-first app: there are no accounts, and reading and
editing never send anything anywhere. That removes most of the usual attack surface,
but a few areas still matter — chiefly **rendering untrusted Markdown safely** and,
since sharing exists, **keeping the share API blind**.

## How sharing is meant to work

When you share, the document is sealed in your browser with AES-GCM-256 and the key
is placed in the URL **fragment**, which browsers never transmit. The Worker
(`worker/index.js`) stores the ciphertext under a random id and can't decrypt it.
Anything that breaks that property is a vulnerability — see "In scope" below.

The link is the capability: anyone holding it can read the document. That's by
design, not a bug.

## How accounts are meant to work

Signing in is optional. It restores your **list of share links** and any documents
you explicitly saved to the **vault**; nothing is uploaded unless you ask for it.
Two credentials with two separate jobs:

- **Email magic link** proves which account you are. The server stores
  `SHA-256(email)` and never persists the address itself.
- **Master password** encrypts the link list. It is stretched with PBKDF2-SHA256
  (600,000 iterations) in the browser and is never transmitted in any form —
  not hashed, not derived, not at all.

So authentication decides *which ciphertext you are handed*; it never grants the
ability to read it. A forgotten master password is unrecoverable by design, and
there is deliberately no reset flow — adding one would require holding the key.

## Supported versions

The latest release on `main` (and the deployed [mdread.app](https://mdread.app))
is the only supported version. Fixes land there.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything exploitable.

- Preferred: open a [GitHub security advisory](https://github.com/techjewel/mdread/security/advisories/new).
- Or email **cep.jewel@gmail.com** with steps to reproduce.

Please include what you did, what happened, and the browser/OS. We'll acknowledge
within a few days and keep you posted on the fix.

## In scope

- **XSS / HTML injection** through rendered Markdown. All Markdown is parsed with
  `marked` and sanitized with `DOMPurify` before it touches the DOM
  (`src/modules/markdown.js`); a bypass of that sanitization is the highest-value
  report.
- Anything that causes data to leave the device (an unexpected network request),
  which would break the local-first/privacy guarantee.
- Service worker / cache-poisoning issues that could serve tampered assets.
- **Any path by which a share key reaches the server** — a key in a request line,
  a `Referer` header, a log, or KV metadata. The fragment must stay a fragment.
- Weaknesses in the share crypto itself (`src/modules/crypto.js`): nonce reuse,
  a predictable key or id, or ciphertext that can be read or forged without the key.
- Reading or deleting someone else's share without its link or delete token.
- **Any path by which a master password or derived vault key reaches the server.**
- Reading or writing another account's vault **or vault documents**, session fixation
  or forgery, a magic link that can be replayed or guessed, or a magic link appearing
  in any HTTP response body rather than only in email.
- Vault document bodies being readable without the master password, or a document body
  being cached in plaintext on the device.
- Account enumeration — `/api/auth/request` must answer identically whether or not
  an address has an account.

## Reporting abusive shared content

Share links are end-to-end encrypted, so **we cannot see, scan, or moderate what
people store** — that's the design, and it's also the limitation. If a link is being
used to host phishing or other abuse, send the full URL to **cep.jewel@gmail.com**
and the share will be deleted by id. Please don't open a public issue containing a
live link.

## Out of scope

- Attacks requiring a malicious browser extension or a compromised local machine.
- The contents of a Markdown file the user themselves opened (it's their own data,
  shown only to them).
- Reading a shared document when you legitimately have the link — the link *is* the
  password, and that is the intended behaviour.
- Reports against the bundled libraries that aren't reproducible in mdread —
  please report those upstream.
