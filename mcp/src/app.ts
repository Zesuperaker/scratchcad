// The local HTTP app: the editor, its file API and scratchcad proxy, and (in
// HTTP mode) the MCP endpoint, all on one port.
//
//   GET  /                          the editor
//   GET  /api/files                 scripts and meshes in the output directory
//   GET  /api/files/<path>          one file, with its version in x-version
//   PUT  /api/files/<path>          write one, checking x-expected-version
//   POST /api/scratchcad/v1/...     forwarded to scratchcad, token added here
//   GET  /api/editor                the output directory this editor shows
//   POST /mcp                       streamable HTTP MCP (HTTP mode)
//   GET  /healthz                   liveness
//
// Host and Origin headers are checked on every route, so other websites and
// DNS-rebinding tricks can't use the browser to reach any of it.
import fs from "node:fs";
import path from "node:path";
import { createMcpExpressApp, originValidation } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";
import express, { type ErrorRequestHandler, type Express, type Response } from "express";
import { ScratchcadError, type ScratchcadClient } from "./client.ts";
import * as workspace from "./workspace.ts";
import { MESH, SCRIPT, WorkspaceError } from "./workspace.ts";

// Upload limits for the file API.
export const MAX_SCRIPT_BYTES = 1024 * 1024;
export const MAX_MESH_BYTES = 256 * 1024 * 1024;

// The scratchcad endpoints the editor may call through the proxy.
const PROXIED = [
  "/v1/scripts/validate",
  "/v1/eval",
  "/v1/raster/2d",
  "/v1/raster/3d",
  "/v1/export/stl",
];
// Response headers passed back to the editor.
const FORWARDED_HEADERS = [
  "content-type",
  "x-compute-ms",
  "x-triangle-count",
  "x-warning",
  "x-request-id",
];

export interface AppOptions {
  client: ScratchcadClient;
  outputDir: string;
  host: string;
  allowedHosts: string[];
  /** Builds a fresh MCP server per request; omit to serve no /mcp. */
  mcp?: () => McpServer;
  /** Whether the editor is served next to this app (answers /api/editor). */
  editor?: boolean;
}

/** An error in the scratchcad service's format: {"error": {"code", "message"}}. */
function fail(res: Response, status: number, code: string, message: string, extra = {}): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

/** The `*path` wildcard, which Express gives as decoded segments. */
function relativePath(params: Record<string, string | string[]>): string {
  return [params.path].flat().join("/");
}

export function createApp({
  client,
  outputDir,
  host,
  allowedHosts,
  mcp,
  editor = false,
}: AppOptions): Express {
  const app = createMcpExpressApp({ host, allowedHosts, jsonLimit: "8mb" });
  // createMcpExpressApp checks Origin only for loopback binds; check it always.
  app.use(originValidation(allowedHosts));

  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  // --- MCP ------------------------------------------------------------------

  if (mcp) {
    // Stateless: a server and transport per request. The tools keep no state
    // between calls, so sessions would buy nothing.
    app.post("/mcp", async (req, res) => {
      const server = mcp();
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    app.all("/mcp", (_req, res) => {
      res
        .status(405)
        .set("allow", "POST")
        .json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed: this server is stateless" },
          id: null,
        });
    });
  }

  // --- file API -------------------------------------------------------------

  if (editor) {
    // Lets another scratchcad-mcp that finds this port taken check whether
    // this editor shows its files before sending users here.
    app.get("/api/editor", (_req, res) => {
      res.json({ outputDir: workspace.realpath(outputDir) });
    });
  }

  app.get("/api/files", async (_req, res) => {
    res.json(workspace.listFiles(outputDir));
  });

  app.get("/api/files/*path", (req, res) => {
    const relative = relativePath(req.params);
    let target: string;
    try {
      target = workspace.resolve(outputDir, relative, [SCRIPT, MESH]);
    } catch (error) {
      return fail(res, 400, "invalid_path", (error as Error).message);
    }
    if (!workspace.isFile(target)) return fail(res, 404, "not_found", `${relative} does not exist`);
    const mesh = path.extname(target).toLowerCase() === MESH;
    res.set({
      "content-type": mesh ? "model/stl" : "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "x-version": workspace.version(target),
    });
    // The file can vanish or become unreadable after the isFile check; an
    // unhandled stream error would take the whole process down.
    const stream = fs.createReadStream(target);
    stream.on("error", (error) => {
      if (!res.headersSent) fail(res, 404, "not_found", `${relative} could not be read`);
      else res.destroy(error);
    });
    stream.pipe(res);
  });

  app.put(
    "/api/files/*path",
    express.raw({ type: () => true, limit: MAX_MESH_BYTES }),
    (req, res) => {
      const relative = relativePath(req.params);
      let target: string;
      try {
        target = workspace.resolve(outputDir, relative, [SCRIPT, MESH]);
      } catch (error) {
        return fail(res, 400, "invalid_path", (error as WorkspaceError).message);
      }
      if (!Buffer.isBuffer(req.body)) {
        return fail(
          res,
          415,
          "unsupported_media_type",
          "send the file as the raw request body, not JSON",
        );
      }
      const data = req.body;
      const isScript = path.extname(target).toLowerCase() === SCRIPT;
      const limit = isScript ? MAX_SCRIPT_BYTES : MAX_MESH_BYTES;
      if (data.length > limit) {
        return fail(res, 413, "too_large", `${relative} is larger than ${limit} bytes`);
      }
      if (isScript) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          return fail(res, 400, "not_utf8", "scripts must be UTF-8 text");
        }
      }
      const expected = req.get("x-expected-version");
      const current = workspace.isFile(target) ? workspace.version(target) : null;
      if (expected !== undefined && expected !== (current ?? "new")) {
        return fail(
          res,
          409,
          "conflict",
          current ? `${relative} changed since it was read` : `${relative} was deleted`,
          { current },
        );
      }
      workspace.write(target, data);
      res.json(workspace.entry(outputDir, target));
    },
  );

  // --- scratchcad proxy -----------------------------------------------------

  app.post("/api/scratchcad/*path", async (req, res) => {
    const endpoint = `/${relativePath(req.params)}`;
    if (!PROXIED.includes(endpoint)) {
      return fail(res, 404, "not_found", `no scratchcad endpoint ${endpoint}`);
    }
    try {
      const response = await client.forward(endpoint, JSON.stringify(req.body ?? {}));
      res.status(response.status);
      for (const name of FORWARDED_HEADERS) {
        const values = response.headers[name];
        if (values) res.set(name, values.length === 1 ? values[0] : values);
      }
      res.end(response.body);
    } catch (error) {
      // forward() only throws when scratchcad can't be reached in time.
      fail(res, 502, "unreachable", (error as ScratchcadError).message);
    }
  });

  return app;
}

/** Turns body-parser errors (too large, bad JSON) into the API's error format. */
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const { status, type } = error as { status?: number; type?: string };
  if (status === 413) return fail(res, 413, "too_large", "the request body is too large");
  if (status && status < 500)
    return fail(res, status, type ?? "bad_request", String(error.message));
  console.error("scratchcad-mcp: unexpected error serving a request:", error);
  fail(res, 500, "internal", "an internal error occurred");
};
