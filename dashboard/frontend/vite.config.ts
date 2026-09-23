import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Embedded into `agave-validator` by `dashboard/build.rs`. Assets go under `assets/`, the prefix
// the server caches, referenced absolutely since unknown paths fall back to index.html.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    // One bundle keeps the embedded asset table small and avoids a waterfall of
    // requests on a validator that may be serving this over a slow link.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    // `npm run dev` against a validator running the dashboard elsewhere.
    proxy: {
      "/websocket": {
        target: "ws://127.0.0.1:10999",
        ws: true,
      },
    },
  },
});
