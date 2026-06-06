/* OS file-handler entry. When the installed PWA is launched by the operating
   system to open a markdown file (Windows "Open with", macOS "Open With", the
   Chrome/Edge file association), the File Handling API delivers the chosen files
   here as FileSystemFileHandles. We reuse the same open path as the in-app file
   picker so a launched file behaves identically to one opened from the sidebar. */

import { state } from "./state.js";
import { isMarkdown } from "./dom.js";
import { addFiles } from "./files.js";
import { openDoc } from "./document.js";

export function wireLaunch() {
  if (!("launchQueue" in window) || !("files" in LaunchParams.prototype)) return;

  window.launchQueue.setConsumer(async (params) => {
    if (!params || !params.files || !params.files.length) return;

    const added = [];
    for (const handle of params.files) {
      if (handle.kind !== "file" || !isMarkdown(handle.name)) continue;
      added.push({ name: handle.name, path: handle.name, handle });
    }
    if (!added.length) return;

    addFiles(added, /*replace*/ !state.files.length);
    await openDoc(added[0]);
  });
}
