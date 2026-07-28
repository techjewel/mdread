/* The built-in sample document shown from the welcome screen. */

import { state } from "./state.js";
import { app, docName, editor } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { updateSub } from "./document.js";
import { updateCurrentFolder } from "./tree.js";
import { renderVaultBox } from "./vault.js";

export function openSample() {
  const f = { name: "Welcome to mdread.md", path: "Welcome to mdread.md", content: SAMPLE, handle: null, file: null };
  state.current = f;
  app.dataset.hasDoc = "true";
  docName.textContent = "Welcome to mdread";
  updateSub();
  renderMarkdown(SAMPLE);
  editor.value = SAMPLE;
  updateCurrentFolder();
  renderVaultBox(); // this path doesn't go through openDoc()
}

const SAMPLE = `# A quiet reading room

mdread turns any markdown file into something worth lingering over. Drop a single file or an entire folder onto this page — it all stays on your device, and nothing is uploaded unless you choose to share.

> "The reading of all good books is like a conversation with the finest minds of past centuries."
> — René Descartes

## What you can do

- **Read** with typography tuned for long-form text
- **Edit** in place and save straight back to disk
- **Download** any document as a clean \`.md\` file
- Switch between **Day**, **Sepia**, and **Night** to suit the light

This is a *local-first* tool. Open a folder once and mdread remembers it — your library is waiting the next time you visit.

When you do want someone else to read something, **Share** seals it in your browser first and puts the key in the link itself, so the server only ever holds bytes it can't decrypt.

### A few touches for the eyes

Headings use a characterful display serif, while body copy is set in a face designed for reading on screens. The measure is held to a comfortable width, the line height is generous, and footnotes, tables, and code all have a considered home.

| Feature        | Read | Edit | Download |
| -------------- | :--: | :--: | :------: |
| Single file    |  ✓   |  ✓   |    ✓     |
| Whole folder   |  ✓   |  ✓   |    ✓     |
| Works offline  |  ✓   |  ✓   |    ✓     |

### Code feels at home too

\`\`\`js
// syntax highlighting, tuned to the paper
function greet(name) {
  const hour = new Date().getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return \`Good \${part}, \${name}. Happy reading.\`;
}
\`\`\`

### A checklist, because why not

- [x] Drop a file or folder
- [x] Pick a theme that suits the hour
- [ ] Lose an afternoon to a good document

---

Ready? Open a folder from the sidebar, or just drag one anywhere onto this page.
`;
