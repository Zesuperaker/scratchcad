// start(): which servers come up for each transport, and what happens when
// the port is taken.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { packageRoot } from "../src/paths.ts";
import { browserHost, packageVersion, type Running, start } from "../src/server.ts";
import { tempDir, testSettings, TOOLS } from "./helpers.ts";

const running: Running[] = [];
const blockers: http.Server[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
  for (const b of blockers.splice(0)) await new Promise((resolve) => b.close(resolve));
});

async function launch(...args: Parameters<typeof start>) {
  const r = await start(...args);
  running.push(r);
  return r;
}

const unused = () => {
  throw new Error("not in stdio mode");
};

const port = (r: Running) => (r.http!.address() as AddressInfo).port;

/** A port held by something else: by default a server that never answers. */
async function takenPort(handler?: http.RequestListener): Promise<number> {
  const blocker = http.createServer(handler);
  blockers.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  return (blocker.address() as AddressInfo).port;
}

describe("start", () => {
  it("serves MCP over HTTP, with no editor when it is off", async () => {
    const log: string[] = [];
    const r = await launch(testSettings({ transport: "http" }), {
      log: (l) => log.push(l),
      stdioTransport: unused,
    });
    expect(r.editorUrl).toBeNull();
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port(r)}/mcp`)),
    );
    expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
    await client.close();
    expect(log.some((l) => l.includes(`MCP at http://localhost:${port(r)}/mcp`))).toBe(true);
  });

  it("serves the editor next to MCP over HTTP", async () => {
    const log: string[] = [];
    const r = await launch(testSettings({ transport: "http", editor: true }), {
      log: (l) => log.push(l),
      stdioTransport: unused,
    });
    expect(r.editorUrl).toBe(`http://localhost:${port(r)}/`);
    expect(log).toContain(`scratchcad-mcp: editor at ${r.editorUrl}`);
    const page = await fetch(`http://127.0.0.1:${port(r)}/`);
    expect([200, 503]).toContain(page.status); // 503 until `npm run build` has run
  });

  it("speaks MCP over stdio, starting no HTTP server without the editor", async () => {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const log: string[] = [];
    const settings = testSettings({ transport: "stdio" });
    const r = await launch(settings, { log: (l) => log.push(l), stdioTransport: () => serverSide });
    expect(r.http).toBeNull();
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
    expect(log).toEqual([
      `scratchcad-mcp: using scratchcad at ${settings.url}, files in ${settings.outputDir}`,
    ]);
  });

  it("warns when the API token would go out over plain HTTP", async () => {
    const [serverSide] = InMemoryTransport.createLinkedPair();
    const log: string[] = [];
    await launch(testSettings({ url: "http://cad.example.com", apiToken: "s3cret" }), {
      log: (l) => log.push(l),
      stdioTransport: () => serverSide,
    });
    expect(log.some((l) => l.includes("SCRATCHCAD_API_TOKEN is sent unencrypted"))).toBe(true);
  });

  it("serves the editor in stdio mode too, or shares one for the same files", async () => {
    const [serverSide] = InMemoryTransport.createLinkedPair();
    const settings = testSettings({ editor: true });
    const withEditor = await launch(settings, {
      log: () => {},
      stdioTransport: () => serverSide,
    });
    expect(withEditor.http).not.toBeNull();
    expect(withEditor.editorUrl).toBe(`http://localhost:${port(withEditor)}/`);

    const log: string[] = [];
    const [other] = InMemoryTransport.createLinkedPair();
    const r = await launch(
      { ...settings, port: port(withEditor) },
      { log: (l) => log.push(l), stdioTransport: () => other },
    );
    expect(r.http).toBeNull();
    expect(r.editorUrl).toBe(withEditor.editorUrl);
    expect(log[0]).toContain(`port ${port(withEditor)} is in use`);
    expect(log[0]).toContain("for the same output directory");
  });

  it("gives no editor link when the port holder shows other files", async () => {
    const [serverSide] = InMemoryTransport.createLinkedPair();
    const first = await launch(testSettings({ editor: true }), {
      log: () => {},
      stdioTransport: () => serverSide,
    });
    const [other] = InMemoryTransport.createLinkedPair();
    const elsewhere = await launch(testSettings({ editor: true, port: port(first) }), {
      log: () => {},
      stdioTransport: () => other,
    });
    expect(elsewhere.http).toBeNull();
    expect(elsewhere.editorUrl).toBeNull();

    const taken = await takenPort();
    const log: string[] = [];
    const [third] = InMemoryTransport.createLinkedPair();
    const r = await launch(testSettings({ editor: true, port: taken }), {
      log: (l) => log.push(l),
      stdioTransport: () => third,
    });
    expect(r.http).toBeNull();
    expect(r.editorUrl).toBeNull();
    expect(log[0]).toContain("saved scripts get no editor link");

    const unrelated = await takenPort((_req, res) => res.writeHead(404).end());
    const [fourth] = InMemoryTransport.createLinkedPair();
    const s = await launch(testSettings({ editor: true, port: unrelated }), {
      log: () => {},
      stdioTransport: () => fourth,
    });
    expect(s.editorUrl).toBeNull();
  });

  it("fails over HTTP when the port is taken", async () => {
    const taken = await takenPort();
    await expect(
      start(testSettings({ transport: "http", port: taken }), {
        log: () => {},
        stdioTransport: unused,
      }),
    ).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});

describe("helpers", () => {
  it.each([
    ["0.0.0.0", "localhost"],
    ["::", "localhost"],
    ["127.0.0.1", "localhost"],
    ["192.168.1.5", "192.168.1.5"],
    ["::1", "[::1]"],
    ["fe80::1", "[fe80::1]"],
    ["cad.local", "cad.local"],
  ])("browserHost(%s) is %s", (host, expected) => {
    expect(browserHost(host)).toBe(expected);
  });

  it("finds the package root from src/ and from dist/server/", () => {
    expect(packageRoot("/app/src")).toBe("/app");
    expect(packageRoot("/app/dist/server")).toBe("/app");
    expect(packageRoot()).toMatch(/mcp$/);
  });

  it("logs to stderr by default", async () => {
    const lines: unknown[] = [];
    const original = console.error;
    console.error = (line: unknown) => lines.push(line);
    try {
      await launch(testSettings({ transport: "http" }), { stdioTransport: unused });
    } finally {
      console.error = original;
    }
    expect(lines.join("\n")).toContain("MCP at http://localhost:");
  });

  it("reads the package version, or falls back", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageVersion(tempDir())).toBe("0.0.0");
  });
});
