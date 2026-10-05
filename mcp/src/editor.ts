// Serves the editor: the built files from dist/web, or (with --dev) Vite's
// dev server as middleware, with hot reload, on the same port as everything
// else.
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import express, { type Express } from "express";
import { packageRoot } from "./paths.ts";

const ROOT = packageRoot();
export const WEB_BUILD = path.join(ROOT, "dist", "web");

export async function serveEditor(
  app: Express,
  server: http.Server,
  { dev = false, build = WEB_BUILD } = {},
): Promise<void> {
  if (dev) {
    // Vite is a dev dependency: only load it when asked to.
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: path.join(ROOT, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    server.on("close", () => void vite.close());
    app.use(vite.middlewares);
    return;
  }
  if (fs.existsSync(path.join(build, "index.html"))) {
    app.use(express.static(build, { index: "index.html" }));
    return;
  }
  app.get("/", (_req, res) => {
    res
      .status(503)
      .type("text/plain")
      .send(
        "The editor isn't built yet: run `npm run build` in mcp/, or start it with `npm run dev`.",
      );
  });
}
