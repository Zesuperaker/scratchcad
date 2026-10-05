// End to end: the MCP server against a real scratchcad binary, and the real
// entry point as a process over stdio and HTTP.
//
// The scratchcad tests use the binary at $SCRATCHCAD_BIN when it is set (and
// fail if it is missing). Otherwise they look in ../server/target and are
// skipped when it hasn't been built.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeSend } from "../src/client.ts";
import { connect, tempDir, testSettings, TOOLS } from "./helpers.ts";

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(MCP_DIR, "src", "main.ts");
const TOKEN = "integration-test-token";

// A 20 x 20 x 20 cube with a 5 mm hole through it along z.
const CUBE = `
let block = box(#{ lower: [-10, -10, -10], upper: [10, 10, 10] });
let hole = extrude_z(#{ shape: circle(#{ radius: 2.5 }), lower: -11, upper: 11 });
draw(difference(#{ shape: block, cutout: hole }))
`;

function findScratchcad(): string | null {
  const explicit = process.env.SCRATCHCAD_BIN;
  if (explicit) {
    // An explicit path (as CI sets) must exist: fail rather than silently skip.
    if (!fs.existsSync(explicit)) throw new Error(`SCRATCHCAD_BIN=${explicit} does not exist`);
    return explicit;
  }
  for (const kind of ["release", "debug"]) {
    const candidate = path.join(MCP_DIR, "..", "server", "target", kind, "scratchcad");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url: string, child: ChildProcess, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${what} did not start`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Content = { type: string; text?: string; data?: string };
type Result = { content: Content[]; structuredContent?: Record<string, any>; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as Result;

/** The env a spawned scratchcad-mcp gets: PATH only, so a developer's settings can't leak in. */
const baseEnv = () => ({ PATH: process.env.PATH ?? "", SCRATCHCAD_MCP_EDITOR: "off" });

const binary = findScratchcad();

describe.skipIf(binary === null)("against a real scratchcad", () => {
  let url = "";
  let server: ChildProcess;

  beforeAll(async () => {
    const port = await freePort();
    server = spawn(binary!, [], {
      env: { ...process.env, SCRATCHCAD_LISTEN: `127.0.0.1:${port}`, SCRATCHCAD_API_TOKEN: TOKEN },
      stdio: "ignore",
    });
    url = `http://127.0.0.1:${port}`;
    await waitFor(`${url}/readyz`, server, "scratchcad");
  });

  afterAll(() => {
    server?.kill();
  });

  /** An in-process MCP client using the real client over HTTP. */
  async function realClient(token: string | null = TOKEN) {
    const settings = testSettings({ url, apiToken: token });
    return { client: await connect(settings, nodeSend), out: settings.outputDir };
  }

  it("runs the whole modelling workflow", async () => {
    const { client, out } = await realClient();
    const validated = await call(client, "validate_script", { script: CUBE });
    expect(validated.structuredContent!.nodes).toBeGreaterThan(0);

    // Measure: the hole's center is empty, the walls sit at x = ±10.
    const measured = await call(client, "evaluate", {
      script: CUBE,
      points: [
        [0, 0, 0],
        [5, 0, 0],
        [9.9, 0, 0],
        [10.1, 0, 0],
      ],
    });
    const [hole, solid, insideWall, outsideWall] = measured.structuredContent!.values as number[];
    expect(hole).toBeGreaterThan(0);
    expect(solid).toBeLessThan(0);
    expect(insideWall).toBeLessThan(0);
    expect(outsideWall).toBeGreaterThan(0);

    const interval = await call(client, "evaluate", {
      script: CUBE,
      mode: "interval",
      intervals: [
        [
          [20, 30],
          [20, 30],
          [20, 30],
        ],
      ],
    });
    expect(interval.structuredContent!.intervals[0][0]).toBeGreaterThan(0);

    for (const [tool, extra] of [
      ["render_2d", {}],
      ["render_3d", { ssao: false }],
    ] as const) {
      const result = await call(client, tool, {
        script: CUBE,
        width: 64,
        height: 64,
        half_size: 18,
        ...extra,
      });
      expect(result.content[0]!.type).toBe("image");
      expect(Buffer.from(result.content[0]!.data!, "base64").subarray(0, 8)).toEqual(
        Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
      );
    }

    const exported = await call(client, "export_stl", {
      script: CUBE,
      path: "cube.stl",
      half_size: 12,
      depth: 5,
    });
    const stl = fs.readFileSync(path.join(out, "cube.stl"));
    const triangles = stl.readUInt32LE(80);
    expect(triangles).toBeGreaterThan(0);
    expect(exported.structuredContent).toMatchObject({ triangles, bytes: 84 + 50 * triangles });

    // The saved script, region line included, is still a valid script.
    const saved = await call(client, "save_script", {
      script: CUBE,
      path: "cube.rhai",
      half_size: 12,
    });
    expect(saved.structuredContent!.nodes).toBe(validated.structuredContent!.nodes);
    const read = await call(client, "read_script", { path: "cube.rhai" });
    expect(read.structuredContent!.half_size).toBe(12);
    const again = await call(client, "validate_script", { script: read.structuredContent!.script });
    expect(again.structuredContent!.nodes).toBe(validated.structuredContent!.nodes);
  });

  it("makes script errors readable", async () => {
    const { client } = await realClient();
    const result = await call(client, "validate_script", { script: "let q = 1 +" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^script_error:.*line 1/);
  });

  it("reports limits", async () => {
    const { client } = await realClient();
    const result = await call(client, "render_2d", { script: CUBE, width: 100_000, height: 8 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/limit_exceeded|bad_request/);
  });

  it("explains a wrong token", async () => {
    const { client } = await realClient("not-the-right-token");
    const result = await call(client, "validate_script", { script: CUBE });
    expect(result.content[0]!.text).toMatch(/^unauthorized:.*SCRATCHCAD_API_TOKEN/);
  });

  it("works end to end through the stdio entry point", async () => {
    const out = tempDir();
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN],
        cwd: out,
        env: {
          ...baseEnv(),
          SCRATCHCAD_URL: url,
          SCRATCHCAD_API_TOKEN: TOKEN,
          SCRATCHCAD_MCP_OUTPUT_DIR: out,
        },
        stderr: "ignore",
      }),
    );
    await call(client, "export_stl", {
      script: CUBE,
      path: "out/cube.stl",
      half_size: 12,
      depth: 4,
    });
    await client.close();
    expect(fs.statSync(path.join(out, "out", "cube.stl")).size).toBeGreaterThan(84);
  });
});

describe("the entry point", () => {
  it("speaks MCP over stdio without a scratchcad", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN],
        cwd: tempDir(),
        env: { ...baseEnv(), SCRATCHCAD_URL: "http://127.0.0.1:9" },
        stderr: "ignore",
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    const result = await call(client, "validate_script", { script: CUBE });
    expect(result.content[0]!.text).toContain("could not reach scratchcad");
    await client.close();
  });

  it("serves the editor in stdio mode and exits when stdin closes", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [MAIN], {
      cwd: tempDir(),
      env: { PATH: process.env.PATH ?? "", SCRATCHCAD_MCP_PORT: String(port) },
      stdio: ["pipe", "ignore", "ignore"],
    });
    await waitFor(`http://127.0.0.1:${port}/healthz`, child, "scratchcad-mcp");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin!.end();
    expect(await exited).toBe(0);
  });

  it("exits with a message on bad settings", async () => {
    const child = spawn(process.execPath, [MAIN], {
      env: { ...baseEnv(), SCRATCHCAD_URL: "localhost:8080" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk));
    const code = await new Promise((resolve) => child.once("exit", resolve));
    expect(code).toBe(2);
    expect(stderr).toContain("scratchcad-mcp: SCRATCHCAD_URL must start with http://");
  });

  describe("over HTTP, bound to every interface as in a container", () => {
    let base = "";
    let child: ChildProcess;

    beforeAll(async () => {
      const port = await freePort();
      child = spawn(process.execPath, [MAIN], {
        cwd: tempDir(),
        env: {
          ...baseEnv(),
          SCRATCHCAD_URL: "http://127.0.0.1:9",
          SCRATCHCAD_MCP_TRANSPORT: "http",
          SCRATCHCAD_MCP_HOST: "0.0.0.0",
          SCRATCHCAD_MCP_PORT: String(port),
        },
        stdio: "ignore",
      });
      base = `http://localhost:${port}`;
      await waitFor(`${base}/healthz`, child, "scratchcad-mcp");
    });

    afterAll(() => {
      child?.kill();
    });

    it("serves MCP", async () => {
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
      const result = await call(client, "validate_script", { script: CUBE });
      expect(result.content[0]!.text).toContain("could not reach scratchcad");
      await client.close();
    });

    it("rejects a foreign Host header", async () => {
      const status = (host: string) =>
        new Promise<number>((resolve, reject) => {
          const request = http.request(`${base}/mcp`, {
            method: "POST",
            headers: {
              host,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
          });
          request.on("response", (res) => {
            res.resume();
            resolve(res.statusCode!);
          });
          request.on("error", reject);
          request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
        });
      expect(await status("attacker.example")).toBe(403);
      expect(await status(new URL(base).host)).not.toBe(403);
    });
  });
});
