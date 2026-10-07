// Shared test doubles: a fake scratchcad behind the client's `send` hook,
// settings pointing at a temporary output directory, and an MCP client
// connected in memory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach } from "vitest";
import { type RawResponse, ScratchcadClient, type Send, type SendOptions } from "../src/client.ts";
import type { Settings } from "../src/config.ts";
import { createMcpServer } from "../src/tools.ts";

// Smallest valid PNG header; the tools pass image bytes through untouched.
export const PNG = Buffer.from("\x89PNG\r\n\x1a\nfake", "latin1");
export const SCRIPT = "draw(sphere(#{ radius: 0.5 }))";
export const TOOLS = [
  "validate_script",
  "evaluate",
  "render_2d",
  "render_3d",
  "export_stl",
  "save_script",
  "read_script",
];

export interface Recorded {
  url: URL;
  options: SendOptions;
  body: Record<string, unknown>;
}

export function response(
  status: number,
  body: string | Buffer | object = "",
  headers: Record<string, string | string[]> = {},
  statusText = "",
): RawResponse {
  const isJson = typeof body === "object" && !Buffer.isBuffer(body);
  return {
    status,
    statusText,
    headers: Object.fromEntries(
      Object.entries({ ...(isJson ? { "content-type": "application/json" } : {}), ...headers }).map(
        ([name, value]) => [name, Array.isArray(value) ? value : [value]],
      ),
    ),
    body: Buffer.isBuffer(body) ? body : Buffer.from(isJson ? JSON.stringify(body) : body),
  };
}

export function scratchcadError(status: number, code: string, message: string) {
  return () => response(status, { error: { code, message } });
}

/** A plausible success response for each scratchcad endpoint. */
export function defaultResponse(url: URL): RawResponse {
  switch (url.pathname) {
    case "/v1/scripts/validate":
      return response(200, { nodes: 9, output: ["hi"], compile_ms: 0.8 });
    case "/v1/eval":
      return response(200, { values: [-1], compute_ms: 0.02 });
    case "/v1/raster/2d":
    case "/v1/raster/3d":
      return response(200, PNG, { "content-type": "image/png", "x-compute-ms": "12.5" });
    case "/v1/export/stl":
      return response(200, Buffer.from("solid-bytes"), {
        "content-type": "model/stl",
        "x-compute-ms": "40.25",
        "x-triangle-count": "1234",
      });
    default:
      return response(404, { error: { code: "not_found", message: `no route ${url.pathname}` } });
  }
}

/** Stands in for the scratchcad HTTP API and records every request it gets. */
export class FakeScratchcad {
  requests: Recorded[] = [];
  handler: ((url: URL, options: SendOptions) => RawResponse | Promise<RawResponse>) | null = null;

  readonly send: Send = async (url, options) => {
    this.requests.push({ url, options, body: JSON.parse(String(options.body)) });
    return this.handler ? this.handler(url, options) : defaultResponse(url);
  };

  get last(): Recorded {
    return this.requests.at(-1)!;
  }
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory, removed after the test. Resolved, as on macOS /tmp is a symlink. */
export function tempDir(prefix = "scratchcad-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporary.push(dir);
  return dir;
}

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    url: "http://scratchcad.test",
    apiToken: null,
    timeoutS: 60,
    outputDir: tempDir(),
    transport: "stdio",
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["localhost", "127.0.0.1"],
    editor: false,
    ...overrides,
  };
}

/** An MCP client talking to a fresh server in memory. */
export async function connect(
  settings: Settings,
  scratchcad: FakeScratchcad | Send,
  editorUrl: string | null = null,
): Promise<Client> {
  const send = typeof scratchcad === "function" ? scratchcad : scratchcad.send;
  const server = createMcpServer({
    client: new ScratchcadClient(settings, send),
    outputDir: settings.outputDir,
    editorUrl,
    version: "0.0.0-test",
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

/** Writes a file and sets its modification time (seconds). */
export function writeFile(file: string, data: string | Buffer, mtime: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.utimesSync(file, mtime, mtime);
}
