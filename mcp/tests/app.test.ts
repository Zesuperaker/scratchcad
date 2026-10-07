// The local HTTP app: file API, scratchcad proxy, /mcp, header guards and
// the editor, over real HTTP on an ephemeral port.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as appModule from "../src/app.ts";
import { createApp, errorHandler } from "../src/app.ts";
import { ScratchcadClient } from "../src/client.ts";
import { serveEditor } from "../src/editor.ts";
import { createMcpServer } from "../src/tools.ts";
import { FakeScratchcad, response, SCRIPT, TOOLS, tempDir, writeFile } from "./helpers.ts";

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

interface Served {
  base: string;
  out: string;
  fake: FakeScratchcad;
  server: http.Server;
}

async function serve(
  options: {
    mcp?: boolean;
    host?: string;
    allowedHosts?: string[];
    editor?: (app: express.Express, server: http.Server) => Promise<void>;
  } = {},
): Promise<Served> {
  const fake = new FakeScratchcad();
  const out = tempDir();
  const client = new ScratchcadClient(
    { url: "http://scratchcad.test", apiToken: null, timeoutS: 60 },
    fake.send,
  );
  const app = createApp({
    client,
    outputDir: out,
    host: options.host ?? "127.0.0.1",
    allowedHosts: options.allowedHosts ?? ["localhost", "127.0.0.1"],
    mcp: options.mcp
      ? () => createMcpServer({ client, outputDir: out, editorUrl: null, version: "0" })
      : undefined,
  });
  const server = http.createServer(app);
  servers.push(server);
  if (options.editor) await options.editor(app, server);
  app.use(errorHandler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, out, fake, server };
}

/** A request with full control over headers (fetch won't let tests set Host). */
function raw(
  base: string,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body?: string | Buffer,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(target, base), { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      // "close" also covers responses cut off mid-way.
      res.on("close", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          text,
          json: () => JSON.parse(text),
        });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("file API", () => {
  it("lists scripts and meshes newest first", async () => {
    const { base, out } = await serve();
    writeFile(path.join(out, "old.stl"), "a", 1000);
    writeFile(path.join(out, "parts/new.rhai"), "bbb", 3000);
    writeFile(path.join(out, "notes.txt"), "x", 4000);
    const files = (await raw(base, "GET", "/api/files")).json();
    expect(files.map((f: { path: string; kind: string }) => [f.path, f.kind])).toEqual([
      ["parts/new.rhai", "script"],
      ["old.stl", "mesh"],
    ]);
    expect(files.every((f: { version: string }) => f.version)).toBe(true);
  });

  it("serves scripts as text and meshes as STL, with their version", async () => {
    const { base, out } = await serve();
    writeFile(path.join(out, "parts/my bolt.stl"), "solid-bytes", 1000);
    writeFile(path.join(out, "bolt.rhai"), SCRIPT, 1000);
    const mesh = await raw(base, "GET", "/api/files/parts/my%20bolt.stl");
    expect([
      mesh.status,
      mesh.text,
      mesh.headers["content-type"],
      mesh.headers["cache-control"],
    ]).toEqual([200, "solid-bytes", "model/stl", "no-cache"]);
    const script = await raw(base, "GET", "/api/files/bolt.rhai");
    expect(script.text).toBe(SCRIPT);
    expect(script.headers["content-type"]).toBe("text/plain; charset=utf-8");
    const listed = (await raw(base, "GET", "/api/files")).json();
    expect(script.headers["x-version"]).toBe(
      listed.find((f: { kind: string }) => f.kind === "script").version,
    );
  });

  it("answers, or cuts the response off, when a file can't be read", async () => {
    const { base, out } = await serve();
    writeFile(path.join(out, "a.stl"), "solid", 1000);
    const failing = (chunks: string[]) =>
      new Readable({
        read() {
          const chunk = chunks.shift();
          if (chunk !== undefined) this.push(chunk);
          // Fail later, so what was pushed reaches the client first.
          else
            setTimeout(() => this.destroy(Object.assign(new Error("gone"), { code: "EIO" })), 20);
        },
      });
    const open = vi.spyOn(fs, "createReadStream");

    open.mockReturnValueOnce(failing([]) as fs.ReadStream);
    const before = await raw(base, "GET", "/api/files/a.stl");
    expect(before.status).toBe(404);
    expect(before.json().error).toEqual({ code: "not_found", message: "a.stl could not be read" });

    open.mockReturnValueOnce(failing(["sol"]) as fs.ReadStream);
    const during = await raw(base, "GET", "/api/files/a.stl");
    expect([during.status, during.text]).toEqual([200, "sol"]);
  });

  it.each([
    ["missing.stl", 404, "not_found"],
    ["notes.txt", 400, "invalid_path"],
    ["folder.stl", 400, "invalid_path"],
    ["..%2Fescape.stl", 400, "invalid_path"],
    ["%2Fetc%2Fpasswd", 400, "invalid_path"],
  ])("refuses to serve %s", async (target, status, code) => {
    const { base, out } = await serve();
    writeFile(path.join(out, "notes.txt"), "text", 1000);
    writeFile(path.join(out, "..", "escape.stl"), "outside", 1000);
    fs.mkdirSync(path.join(out, "folder.stl"));
    const reply = await raw(base, "GET", `/api/files/${target}`);
    expect(reply.status).toBe(status);
    expect(reply.json().error.code).toBe(code);
  });

  it("creates and replaces files", async () => {
    const { base, out } = await serve();
    const created = await raw(
      base,
      "PUT",
      "/api/files/new/part.rhai",
      { "content-type": "text/plain" },
      SCRIPT,
    );
    expect(created.status).toBe(200);
    expect(created.json()).toMatchObject({
      path: "new/part.rhai",
      kind: "script",
      bytes: SCRIPT.length,
    });
    expect(fs.readFileSync(path.join(out, "new/part.rhai"), "utf8")).toBe(SCRIPT);
    const mesh = await raw(base, "PUT", "/api/files/part.stl", {}, Buffer.from("solid"));
    expect(mesh.json().kind).toBe("mesh");
    expect(fs.readdirSync(out).sort()).toEqual(["new", "part.stl"]);
  });

  it("checks the expected version", async () => {
    const { base, out } = await serve();
    const first = (await raw(base, "PUT", "/api/files/a.rhai", {}, "one")).json();
    fs.utimesSync(path.join(out, "a.rhai"), 1000, 1000);
    const stale = await raw(
      base,
      "PUT",
      "/api/files/a.rhai",
      { "x-expected-version": first.version },
      "two",
    );
    expect(stale.status).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: "conflict",
      message: "a.rhai changed since it was read",
    });
    const current = stale.json().error.current;
    expect(fs.readFileSync(path.join(out, "a.rhai"), "utf8")).toBe("one");

    expect(
      (await raw(base, "PUT", "/api/files/a.rhai", { "x-expected-version": current }, "two"))
        .status,
    ).toBe(200);
    expect(
      (await raw(base, "PUT", "/api/files/a.rhai", { "x-expected-version": "new" }, "3")).status,
    ).toBe(409);
    const deleted = await raw(
      base,
      "PUT",
      "/api/files/gone.rhai",
      { "x-expected-version": current },
      "x",
    );
    expect(deleted.status).toBe(409);
    expect(deleted.json().error).toMatchObject({ message: "gone.rhai was deleted", current: null });
    expect(
      (await raw(base, "PUT", "/api/files/gone.rhai", { "x-expected-version": "new" }, "x")).status,
    ).toBe(200);
  });

  it("rejects bad uploads", async () => {
    const { base, out } = await serve();
    expect((await raw(base, "PUT", "/api/files/..%2Fx.rhai", {}, "x")).status).toBe(400);
    expect((await raw(base, "PUT", "/api/files/x.txt", {}, "x")).json().error.code).toBe(
      "invalid_path",
    );
    expect(
      (await raw(base, "PUT", "/api/files/x.rhai", {}, Buffer.from([0xff]))).json().error.code,
    ).toBe("not_utf8");
    const asJson = await raw(
      base,
      "PUT",
      "/api/files/x.rhai",
      { "content-type": "application/json" },
      "{}",
    );
    expect([asJson.status, asJson.json().error.code]).toEqual([415, "unsupported_media_type"]);
    const big = Buffer.alloc(appModule.MAX_SCRIPT_BYTES + 1, 0x61);
    const tooBig = await raw(base, "PUT", "/api/files/x.rhai", {}, big);
    expect([tooBig.status, tooBig.json().error.code]).toEqual([413, "too_large"]);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});

describe("scratchcad proxy", () => {
  it("forwards to scratchcad and passes back the result and its headers", async () => {
    const { base, fake } = await serve();
    fake.handler = () =>
      response(200, Buffer.from("solid"), {
        "content-type": "model/stl",
        "x-triangle-count": "12",
        "x-warning": ["a, b", "c"],
        "x-secret": "not forwarded",
      });
    const reply = await raw(
      base,
      "POST",
      "/api/scratchcad/v1/export/stl",
      { "content-type": "application/json" },
      JSON.stringify({ script: SCRIPT, depth: 5 }),
    );
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("solid");
    expect(reply.headers["x-triangle-count"]).toBe("12");
    expect(reply.headers["x-warning"]).toBe("a, b, c"); // node joins repeats when reading
    expect(reply.headers["x-secret"]).toBeUndefined();
    expect(fake.last.url.pathname).toBe("/v1/export/stl");
    expect(fake.last.body).toEqual({ script: SCRIPT, depth: 5 });
  });

  it("passes scratchcad's errors through", async () => {
    const { base, fake } = await serve();
    fake.handler = () => response(422, { error: { code: "script_error", message: "bad" } });
    const reply = await raw(base, "POST", "/api/scratchcad/v1/scripts/validate", {}, "");
    expect(reply.status).toBe(422);
    expect(reply.json().error.code).toBe("script_error");
    expect(fake.last.body).toEqual({});
  });

  it("only forwards the API's endpoints", async () => {
    const { base, fake } = await serve();
    const reply = await raw(base, "POST", "/api/scratchcad/admin/shutdown", {}, "");
    expect([reply.status, reply.json().error.code]).toEqual([404, "not_found"]);
    expect(fake.requests).toEqual([]);
  });

  it("answers 502 when scratchcad is unreachable", async () => {
    const { base, fake } = await serve();
    fake.handler = () => {
      throw new Error("connect ECONNREFUSED");
    };
    const reply = await raw(base, "POST", "/api/scratchcad/v1/eval", {}, "");
    expect(reply.status).toBe(502);
    expect(reply.json().error).toMatchObject({ code: "unreachable" });
    expect(reply.json().error.message).toContain("could not reach scratchcad");
  });

  it("rejects oversized and malformed JSON in the API's error format", async () => {
    const { base } = await serve();
    const bad = await raw(
      base,
      "POST",
      "/api/scratchcad/v1/eval",
      { "content-type": "application/json" },
      "{",
    );
    expect(bad.status).toBe(400);
    expect(bad.json().error.code).toBe("entity.parse.failed");
    const huge = JSON.stringify({ script: "x".repeat(9 * 1024 * 1024) });
    const big = await raw(
      base,
      "POST",
      "/api/scratchcad/v1/eval",
      { "content-type": "application/json" },
      huge,
    );
    expect([big.status, big.json().error.code]).toEqual([413, "too_large"]);
  });
});

describe("MCP over HTTP", () => {
  it("serves the tools statelessly at /mcp", async () => {
    const { base } = await serve({ mcp: true });
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base)));
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
      await client.close();
    }
  });

  it("only takes POST at /mcp", async () => {
    const { base } = await serve({ mcp: true });
    const reply = await raw(base, "GET", "/mcp", { accept: "text/event-stream" });
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("POST");
  });

  it("serves no /mcp when there is no MCP server", async () => {
    const { base } = await serve();
    expect(
      (await raw(base, "POST", "/mcp", { "content-type": "application/json" }, "{}")).status,
    ).toBe(404);
  });
});

describe("header guards", () => {
  it.each([
    ["localhost:8000", undefined, 200],
    ["127.0.0.1", "http://localhost:5173", 200],
    ["evil.example", undefined, 403],
    ["localhost:8000", "https://evil.example", 403],
  ])("Host %s, Origin %s -> %d", async (host, origin, status) => {
    const { base } = await serve();
    const headers: Record<string, string> = { host };
    if (origin) headers.origin = origin;
    expect((await raw(base, "GET", "/api/files", headers)).status).toBe(status);
  });

  it("checks both when bound to every interface, as in a container", async () => {
    const { base } = await serve({ host: "0.0.0.0", allowedHosts: ["localhost", "mcp"] });
    expect((await raw(base, "GET", "/healthz", { host: "mcp:8000" })).text).toBe("ok");
    expect((await raw(base, "GET", "/healthz", { host: "evil.example" })).status).toBe(403);
    expect(
      (await raw(base, "GET", "/healthz", { host: "localhost", origin: "http://evil.example" }))
        .status,
    ).toBe(403);
  });
});

describe("editor", () => {
  it("serves the built editor", async () => {
    const build = tempDir();
    fs.writeFileSync(path.join(build, "index.html"), "<p>editor</p>");
    const { base } = await serve({ editor: (app, server) => serveEditor(app, server, { build }) });
    expect((await raw(base, "GET", "/")).text).toBe("<p>editor</p>");
    expect((await raw(base, "GET", "/healthz")).text).toBe("ok");
  });

  it("explains how to build a missing editor", async () => {
    const { base } = await serve({
      editor: (app, server) => serveEditor(app, server, { build: tempDir() }),
    });
    const reply = await raw(base, "GET", "/");
    expect(reply.status).toBe(503);
    expect(reply.text).toContain("npm run build");
  });

  it("runs Vite in dev mode", async () => {
    const { base } = await serve({
      editor: (app, server) => serveEditor(app, server, { dev: true }),
    });
    const page = await raw(base, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("/@vite/client");
    expect((await raw(base, "GET", "/api/files")).status).toBe(200);
  });
});

describe("errorHandler", () => {
  it("reports unexpected errors as 500, and leaves started responses alone", async () => {
    const app = express();
    app.get("/boom", () => {
      throw new Error("secret");
    });
    app.get("/missing", (_req, _res, next) => {
      next(Object.assign(new Error("nothing here"), { status: 404 }));
    });
    app.get("/late", (_req, res, next) => {
      res.write("partial");
      next(new Error("after headers"));
    });
    app.use(errorHandler);
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const original = console.error;
    console.error = () => {};
    try {
      const boom = await raw(base, "GET", "/boom");
      expect([boom.status, boom.json().error.code]).toEqual([500, "internal"]);
      expect(boom.text).not.toContain("secret");
      const missing = await raw(base, "GET", "/missing");
      expect([missing.status, missing.json().error]).toEqual([
        404,
        { code: "bad_request", message: "nothing here" },
      ]);
      const late = await raw(base, "GET", "/late");
      expect([late.status, late.text]).toEqual([200, "partial"]);
    } finally {
      console.error = original;
    }
  });
});
