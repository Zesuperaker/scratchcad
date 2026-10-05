// Builds the editor (web/) into dist/web, which the MCP server serves. In
// development the server runs Vite as middleware instead (`npm run dev`), so
// the editor and its API share one port either way.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    // A local tool: three.js and CodeMirror make up most of the one bundle,
    // and splitting it would not make the first load faster over localhost.
    chunkSizeWarningLimit: 1500,
  },
});
