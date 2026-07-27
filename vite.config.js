import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// mdread builds to ./dist, which is what Cloudflare serves (see wrangler.jsonc).
// The vendored libraries are now real dependencies (marked, dompurify, highlight.js)
// bundled into a single `vendor` chunk, so the app still makes zero external
// requests at runtime — they're just self-hosted from our own origin.
export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Keep the three markdown libraries in their own long-lived `vendor`
        // chunk so app-code edits don't bust their cache. (Rolldown wants a
        // function here, not the classic object form.)
        manualChunks(id) {
          if (/node_modules\/(marked|dompurify|highlight\.js)\//.test(id)) return "vendor";
        },
      },
    },
  },
  plugins: [
    VitePWA({
      // auto-update the cached app shell on the next visit after a deploy
      registerType: "autoUpdate",
      injectRegister: "auto",
      // keep the hand-written public/manifest.webmanifest instead of generating one
      manifest: false,
      includeAssets: ["icons/icon.svg", "manifest.webmanifest", "og-image.png"],
      workbox: {
        // precache the hashed build output (Workbox fills in the real filenames)
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        // /s/<id> share links must resolve to the app shell offline too, but the
        // share API is never a navigation and must never be served from cache.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
      // no service worker in `vite dev` — it only gets in the way locally
      devOptions: { enabled: false },
    }),
  ],
});
