// Starts the MCP server over stdio or HTTP, and the editor next to it.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Transport } from "@modelcontextprotocol/server";
import { createApp, errorHandler } from "./app.ts";
import { ScratchcadClient } from "./client.ts";
import type { Settings } from "./config.ts";
import { serveEditor } from "./editor.ts";
import { packageRoot } from "./paths.ts";
import { createMcpServer } from "./tools.ts";

export interface Running {
  /** The HTTP server, unless nothing needed one (or its port was taken). */
  http: http.Server | null;
  editorUrl: string | null;
  close: () => Promise<void>;
}

export interface StartOptions {
  /** Makes the transport for stdio mode; main.ts passes the real one. */
  stdioTransport: () => Transport;
  /** Run the editor through Vite, with hot reload. */
  dev?: boolean;
  /** Log lines go to stderr: in stdio mode stdout carries the protocol. */
  log?: (line: string) => void;
}

export function packageVersion(root = packageRoot()): string {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) return "0.0.0";
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
}

/** How the editor's address reads in a browser on this machine. */
export function browserHost(host: string): string {
  return host === "0.0.0.0" || host === "::" || host === "127.0.0.1" ? "localhost" : host;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function start(
  settings: Settings,
  { stdioTransport, dev = false, log = (line) => console.error(line) }: StartOptions,
): Promise<Running> {
  const client = new ScratchcadClient(settings);
  const version = packageVersion();
  let editorUrl: string | null = null;
  const makeServer = () =>
    createMcpServer({ client, outputDir: settings.outputDir, editorUrl, version });

  let server: http.Server | null = null;
  if (settings.transport === "http" || settings.editor) {
    const app = createApp({
      client,
      outputDir: settings.outputDir,
      host: settings.host,
      allowedHosts: settings.allowedHosts,
      mcp: settings.transport === "http" ? makeServer : undefined,
    });
    server = http.createServer(app);
    if (settings.editor) await serveEditor(app, server, { dev });
    app.use(errorHandler);
    try {
      await listen(server, settings.port, settings.host);
    } catch (error) {
      const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!(inUse && settings.transport === "stdio")) throw error;
      // Usually another session's scratchcad-mcp, serving the same editor.
      log(
        `scratchcad-mcp: port ${settings.port} is in use, so this process isn't serving the ` +
          "editor (another scratchcad-mcp probably is)",
      );
      server = null;
    }
    const port = server ? (server.address() as AddressInfo).port : settings.port;
    const base = `http://${browserHost(settings.host)}:${port}`;
    if (settings.editor) {
      editorUrl = `${base}/`;
      log(`scratchcad-mcp: editor at ${editorUrl}`);
    }
    if (server && settings.transport === "http") log(`scratchcad-mcp: MCP at ${base}/mcp`);
  }
  log(`scratchcad-mcp: using scratchcad at ${settings.url}, files in ${settings.outputDir}`);

  let stdio: ReturnType<typeof makeServer> | null = null;
  if (settings.transport === "stdio") {
    stdio = makeServer();
    await stdio.connect(stdioTransport());
  }

  const httpServer = server;
  return {
    http: httpServer,
    editorUrl,
    close: async () => {
      await stdio?.close();
      if (httpServer) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
  };
}
