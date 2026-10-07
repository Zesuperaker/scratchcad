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
// The cleanup when there is no dev server to stop.
const nothing = async () => {};

/**
 * Adds the editor to `app`. Returns a cleanup for the dev server, which also
 * runs when `server` closes: call it when `server` never started listening,
 * since it then never closes either.
 */
export async function serveEditor(
  app: Express,
  server: http.Server,
  { dev = false, build = WEB_BUILD } = {},
): Promise<() => Promise<void>> {
  if (dev) {
    // Vite is a dev dependency: only load it when asked to.
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: path.join(ROOT, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    const close = () => vite.close();
    server.on("close", () => void close());
    app.use(vite.middlewares);
    return close;
  }
  if (fs.existsSync(path.join(build, "index.html"))) {
    app.use(express.static(build, { index: "index.html" }));
    return nothing;
  }
  app.get("/", (_req, res) => {
    res
      .status(503)
      .type("text/plain")
      .send(
        "The editor isn't built yet: run `npm run build` in mcp/, or start it with `npm run dev`.",
      );
  });
  return nothing;
}
