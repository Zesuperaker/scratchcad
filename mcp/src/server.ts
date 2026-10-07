// Starts the MCP server over stdio or HTTP, and the editor next to it.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Transport } from "@modelcontextprotocol/server";
import { createApp, errorHandler } from "./app.ts";
import { ScratchcadClient } from "./client.ts";
import { sendsTokenInCleartext, type Settings } from "./config.ts";
import { serveEditor } from "./editor.ts";
import { packageRoot } from "./paths.ts";
import { createMcpServer } from "./tools.ts";
import { realpath } from "./workspace.ts";

// How long to wait for whoever holds the port to say what it serves.
const PROBE_TIMEOUT_MS = 1000;

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

/** How the editor's host reads in a URL in a browser on this machine. */
export function browserHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "127.0.0.1") return "localhost";
  // An IPv6 literal needs brackets to be told apart from the port.
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Whether the editor at `base` is another scratchcad-mcp showing the files in
 * `outputDir`. Anything else (another project's editor, an unrelated service,
 * no answer) gets no link: it would open the wrong files.
 */
async function servesSameEditor(base: string, outputDir: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/editor`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { outputDir?: unknown };
    return body.outputDir === realpath(outputDir);
  } catch {
    return false;
  }
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
  let closeEditor: (() => Promise<void>) | null = null;
  if (settings.transport === "http" || settings.editor) {
    const app = createApp({
      client,
      outputDir: settings.outputDir,
      host: settings.host,
      allowedHosts: settings.allowedHosts,
      mcp: settings.transport === "http" ? makeServer : undefined,
      editor: settings.editor,
    });
    server = http.createServer(app);
    if (settings.editor) closeEditor = await serveEditor(app, server, { dev });
    app.use(errorHandler);
    let shared = false;
    try {
      await listen(server, settings.port, settings.host);
    } catch (error) {
      // A server that never listened never closes, so stop Vite here.
      await closeEditor?.();
      const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!(inUse && settings.transport === "stdio")) throw error;
      server = null;
      // Usually another session's scratchcad-mcp. Its editor only works for
      // this session if it shows the same output directory.
      const base = `http://${browserHost(settings.host)}:${settings.port}`;
      shared = settings.editor && (await servesSameEditor(base, settings.outputDir));
      log(
        `scratchcad-mcp: port ${settings.port} is in use, so this process isn't serving the ` +
          (shared
            ? "editor (another scratchcad-mcp is, for the same output directory)"
            : "editor, and whatever holds the port doesn't serve these files: saved scripts " +
              "get no editor link"),
      );
    }
    const port = server ? (server.address() as AddressInfo).port : settings.port;
    const base = `http://${browserHost(settings.host)}:${port}`;
    if (settings.editor && (server || shared)) {
      editorUrl = `${base}/`;
      log(`scratchcad-mcp: editor at ${editorUrl}`);
    }
    if (server && settings.transport === "http") log(`scratchcad-mcp: MCP at ${base}/mcp`);
  }
  log(`scratchcad-mcp: using scratchcad at ${settings.url}, files in ${settings.outputDir}`);
  if (sendsTokenInCleartext(settings)) {
    log(
      "scratchcad-mcp: warning: SCRATCHCAD_API_TOKEN is sent unencrypted to " +
        `${new URL(settings.url).host}; use an https:// SCRATCHCAD_URL unless that network ` +
        "is private (like a Docker network)",
    );
  }

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
        // First, or its HMR WebSockets (which closeAllConnections leaves
        // alone) keep httpServer.close() waiting forever.
        await closeEditor?.();
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
  };
}
