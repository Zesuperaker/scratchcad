/// <reference types="vitest/config" />
//
// The editor talks to two backends through this dev server's proxy, so the
// browser only ever sees one origin and never holds the API token:
//
//   /api/scratchcad/*  ->  the scratchcad service (SCRATCHCAD_URL), for
//                          validating and meshing scripts
//   /api/files/*       ->  the MCP server (SCRATCHCAD_MCP_URL), which owns the
//                          output directory of .rhai scripts and .stl meshes
//
// SCRATCHCAD_* variables come from the environment or a .env file here. They
// are not exposed to the browser (only VITE_* variables would be).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "SCRATCHCAD_");
  const token = env.SCRATCHCAD_API_TOKEN;
  const proxy: Record<string, ProxyOptions> = {
    "/api/scratchcad": {
      target: env.SCRATCHCAD_URL ?? "http://127.0.0.1:8080",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/scratchcad/, ""),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
    "/api/files": {
      target: env.SCRATCHCAD_MCP_URL ?? "http://127.0.0.1:8000",
      // Keep the browser's Host (localhost:5173): the MCP server only accepts
      // loopback Host and Origin headers, which is what the browser sends.
      changeOrigin: false,
      rewrite: (path) => path.replace(/^\/api/, ""),
    },
  };
  return {
    plugins: [react(), tailwindcss()],
    // A local tool: three.js and CodeMirror make up most of the one bundle, and
    // splitting it would not make the first load faster over localhost.
    build: { chunkSizeWarningLimit: 1500 },
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 5173, strictPort: true, proxy },
    test: {
      include: ["src/**/*.test.ts"],
      coverage: {
        include: ["src/lib/**", "src/api/**", "src/editor/rhai.ts"],
        exclude: ["**/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  };
});
