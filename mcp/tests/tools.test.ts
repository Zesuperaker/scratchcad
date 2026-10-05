// The MCP tools, exercised through a real MCP client session in memory.
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { GUIDE } from "../src/guide.ts";
import {
  connect,
  FakeScratchcad,
  PNG,
  response,
  SCRIPT,
  scratchcadError,
  TOOLS,
  testSettings,
} from "./helpers.ts";

type Content = { type: string; text?: string; data?: string; mimeType?: string };

async function setup(editorUrl: string | null = null) {
  const fake = new FakeScratchcad();
  const settings = testSettings();
  const client = await connect(settings, fake, editorUrl);
  return { fake, settings, out: settings.outputDir, client };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return result as {
    content: Content[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

/** Calls a tool that is expected to fail and returns the error text the model sees. */
async function callError(client: Client, name: string, args: Record<string, unknown>) {
  const result = await call(client, name, args);
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  return result.content[0]!.text!;
}

describe("discovery", () => {
  it("lists exactly the tools", async () => {
    const { client } = await setup();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  });

  it("carries the scripting guide as instructions", async () => {
    const { client } = await setup();
    expect(client.getInstructions()).toBe(GUIDE);
    for (const needle of [
      "draw(shape)",
      "difference(",
      "degrees",
      "half_size",
      "negative",
      "finite",
      "save_script",
      "read_script",
      "editor_url",
      "call export_stl when the user asks",
      "// [10, 60]",
    ]) {
      expect(GUIDE).toContain(needle);
    }
  });

  it("documents every parameter", async () => {
    const { client } = await setup();
    for (const tool of (await client.listTools()).tools) {
      expect(tool.description, tool.name).toBeTruthy();
      const required = tool.name === "read_script" ? "path" : "script";
      expect(tool.inputSchema.required).toContain(required);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(
          (schema as { description?: string }).description,
          `${tool.name}.${name}`,
        ).toBeTruthy();
      }
    }
  });

  it("marks only export and save as writing", async () => {
    const { client } = await setup();
    const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
    for (const name of TOOLS) {
      const annotations = tools[name]!.annotations!;
      if (name === "export_stl" || name === "save_script") {
        expect(annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      } else {
        expect(annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
      }
    }
  });

  it("carries the input constraints", async () => {
    const { client } = await setup();
    const props = Object.fromEntries(
      (await client.listTools()).tools.map((t) => [
        t.name,
        t.inputSchema.properties as Record<string, Record<string, unknown>>,
      ]),
    );
    expect(props.render_3d!.perspective!.maximum).toBe(1);
    expect(props.render_3d!.width!.minimum).toBe(1);
    expect(props.render_3d!.mode!.enum).toEqual(["shaded", "normals", "heightmap"]);
    expect(props.render_2d!.mode!.enum).toEqual(["mono", "sdf", "debug"]);
    expect(props.evaluate!.mode!.enum).toEqual(["value", "gradient", "interval"]);
    expect(props.export_stl!.half_size!.exclusiveMinimum).toBe(0);
    expect(Object.keys(props.export_stl!)).toEqual(
      expect.arrayContaining(["path", "overwrite", "depth"]),
    );
  });
});

describe("validate_script", () => {
  it("validates", async () => {
    const { client, fake } = await setup();
    const result = await call(client, "validate_script", { script: SCRIPT });
    expect(result.structuredContent).toEqual({ nodes: 9, output: ["hi"], compile_ms: 0.8 });
    expect(JSON.parse(result.content[0]!.text!)).toEqual(result.structuredContent);
    expect(fake.last.url.pathname).toBe("/v1/scripts/validate");
    expect(fake.last.body).toEqual({ script: SCRIPT });
  });

  it("passes script errors to the model verbatim", async () => {
    const { client, fake } = await setup();
    fake.handler = scratchcadError(
      422,
      "script_error",
      "script error: Script is incomplete (line 1, position 12)",
    );
    expect(await callError(client, "validate_script", { script: "let q = 1 +" })).toBe(
      "script_error: script error: Script is incomplete (line 1, position 12)",
    );
  });

  it("rejects a missing script before sending anything", async () => {
    const { client, fake } = await setup();
    expect(await callError(client, "validate_script", {})).toContain("script");
    expect(fake.requests).toEqual([]);
  });
});

describe("evaluate", () => {
  it("defaults to value mode", async () => {
    const { client, fake } = await setup();
    const result = await call(client, "evaluate", { script: SCRIPT, points: [[0, 0, 0]] });
    expect(result.structuredContent).toEqual({ values: [-1], compute_ms: 0.02 });
    expect(fake.last.url.pathname).toBe("/v1/eval");
    expect(fake.last.body).toEqual({ script: SCRIPT, mode: "value", points: [[0, 0, 0]] });
  });

  it("passes gradient mode and the evaluator", async () => {
    const { client, fake } = await setup();
    await call(client, "evaluate", {
      script: SCRIPT,
      mode: "gradient",
      points: [[1, 2, 3]],
      evaluator: "vm",
    });
    expect(fake.last.body).toEqual({
      script: SCRIPT,
      mode: "gradient",
      points: [[1, 2, 3]],
      evaluator: "vm",
    });
  });

  it("passes interval mode", async () => {
    const { client, fake } = await setup();
    const box = [
      [-1, 1],
      [-1, 1],
      [-1, 1],
    ];
    await call(client, "evaluate", { script: SCRIPT, mode: "interval", intervals: [box] });
    expect(fake.last.body).toEqual({ script: SCRIPT, mode: "interval", intervals: [box] });
  });

  it("rejects malformed points locally", async () => {
    const { client, fake } = await setup();
    expect(await callError(client, "evaluate", { script: SCRIPT, points: [[1, 2]] })).toContain(
      "points",
    );
    expect(fake.requests).toEqual([]);
  });
});

describe("render_2d and render_3d", () => {
  it("render_2d returns the PNG", async () => {
    const { client, fake } = await setup();
    const result = await call(client, "render_2d", { script: SCRIPT });
    expect(result.content).toEqual([
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
    ]);
    expect(fake.last.url.pathname).toBe("/v1/raster/2d");
    expect(fake.last.body).toEqual({
      script: SCRIPT,
      width: 512,
      height: 512,
      mode: "mono",
      center: [0, 0],
      half_size: 1,
    });
  });

  it("render_2d passes every option", async () => {
    const { client, fake } = await setup();
    const args = {
      width: 64,
      height: 32,
      mode: "sdf",
      center: [1, -1],
      half_size: 3,
      evaluator: "jit",
    };
    await call(client, "render_2d", { script: SCRIPT, ...args });
    expect(fake.last.body).toEqual({ script: SCRIPT, ...args });
  });

  it.each(["render_2d", "render_3d"])("%s puts warnings after the image", async (tool) => {
    const { client, fake } = await setup();
    fake.handler = () =>
      response(200, PNG, { "x-warning": ["the field is NaN at (0, 0, 0)", "second"] });
    const result = await call(client, tool, { script: SCRIPT });
    expect(result.content.map((c) => c.type)).toEqual(["image", "text", "text"]);
    expect(result.content[1]!.text).toBe("Warning: the field is NaN at (0, 0, 0)");
  });

  it("render_3d defaults to a three-quarter view", async () => {
    const { client, fake } = await setup();
    const result = await call(client, "render_3d", { script: SCRIPT });
    expect(result.content).toHaveLength(1);
    expect(fake.last.url.pathname).toBe("/v1/raster/3d");
    expect(fake.last.body).toEqual({
      script: SCRIPT,
      width: 512,
      height: 512,
      mode: "shaded",
      ssao: true,
      center: [0, 0, 0],
      half_size: 1,
      rotation: { yaw: 30, pitch: -20, roll: 0 },
      perspective: 0,
    });
  });

  it("render_3d passes every option", async () => {
    const { client, fake } = await setup();
    await call(client, "render_3d", {
      script: SCRIPT,
      width: 256,
      height: 128,
      depth: 64,
      yaw: 90,
      pitch: 45,
      roll: 10,
      center: [1, 2, 3],
      half_size: 20,
      ssao: false,
      perspective: 0.5,
      evaluator: "vm",
    });
    expect(fake.last.body).toEqual({
      script: SCRIPT,
      width: 256,
      height: 128,
      depth: 64,
      mode: "shaded",
      ssao: false,
      center: [1, 2, 3],
      half_size: 20,
      rotation: { yaw: 90, pitch: 45, roll: 10 },
      perspective: 0.5,
      evaluator: "vm",
    });
  });

  it.each(["normals", "heightmap"])("render_3d leaves out ssao in %s mode", async (mode) => {
    const { client, fake } = await setup();
    await call(client, "render_3d", { script: SCRIPT, mode, ssao: true });
    expect(fake.last.body.mode).toBe(mode);
    expect(fake.last.body).not.toHaveProperty("ssao");
  });

  it.each([
    { width: 0 },
    { height: -5 },
    { width: 1.5 },
    { perspective: 1.5 },
    { perspective: -0.1 },
    { half_size: 0 },
    { depth: 0 },
    { mode: "wireframe" },
    { evaluator: "gpu" },
    { center: [1, 2] },
    { unknown: 1 },
  ])("render_3d rejects %o locally", async (args) => {
    const { client, fake } = await setup();
    await callError(client, "render_3d", { script: SCRIPT, ...args });
    expect(fake.requests).toEqual([]);
  });
});

describe("export_stl", () => {
  it("writes the file", async () => {
    const { client, fake, out } = await setup();
    const result = await call(client, "export_stl", { script: SCRIPT, path: "part.stl" });
    const target = path.join(out, "part.stl");
    expect(result.structuredContent).toEqual({
      path: target,
      bytes: 11,
      triangles: 1234,
      compute_ms: 40.25,
      warnings: [],
    });
    expect(fs.readFileSync(target, "utf8")).toBe("solid-bytes");
    expect(fake.last.url.pathname).toBe("/v1/export/stl");
    expect(fake.last.body).toEqual({ script: SCRIPT, center: [0, 0, 0], half_size: 1, depth: 6 });
  });

  it("reports warnings", async () => {
    const { client, fake, out } = await setup();
    fake.handler = () =>
      response(200, Buffer.from("solid-bytes"), {
        "x-triangle-count": "8",
        "x-warning": "the shape reaches the boundary on its -x, +x side(s)",
      });
    const result = await call(client, "export_stl", { script: SCRIPT, path: "part.stl" });
    expect(result.structuredContent!.warnings).toEqual([
      "the shape reaches the boundary on its -x, +x side(s)",
    ]);
    expect(fs.existsSync(path.join(out, "part.stl"))).toBe(true);
  });

  it("passes every option", async () => {
    const { client, fake } = await setup();
    await call(client, "export_stl", {
      script: SCRIPT,
      path: "p.stl",
      center: [1, 1, 1],
      half_size: 15,
      depth: 8,
      evaluator: "vm",
    });
    expect(fake.last.body).toEqual({
      script: SCRIPT,
      center: [1, 1, 1],
      half_size: 15,
      depth: 8,
      evaluator: "vm",
    });
  });

  it("creates subdirectories and accepts absolute paths inside the output directory", async () => {
    const { client, out } = await setup();
    await call(client, "export_stl", { script: SCRIPT, path: "parts/v2/bracket.STL" });
    expect(fs.readFileSync(path.join(out, "parts/v2/bracket.STL"), "utf8")).toBe("solid-bytes");
    await call(client, "export_stl", { script: SCRIPT, path: path.join(out, "abs.stl") });
    expect(fs.existsSync(path.join(out, "abs.stl"))).toBe(true);
  });

  it("refuses to overwrite by default", async () => {
    const { client, fake, out } = await setup();
    const target = path.join(out, "part.stl");
    fs.writeFileSync(target, "original");
    const text = await callError(client, "export_stl", { script: SCRIPT, path: "part.stl" });
    expect(text).toContain("already exists");
    expect(text).toContain("overwrite");
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(fake.requests).toEqual([]);
    await call(client, "export_stl", { script: SCRIPT, path: "part.stl", overwrite: true });
    expect(fs.readFileSync(target, "utf8")).toBe("solid-bytes");
  });

  it.each([
    ["../escape.stl", "inside the output directory"],
    ["/etc/evil.stl", "inside the output directory"],
    ["sub/../../escape.stl", "inside the output directory"],
    ["part.obj", "end in .stl"],
    ["part", "end in .stl"],
    ["   ", "must not be empty"],
  ])("rejects the path %s", async (target, message) => {
    const { client, fake } = await setup();
    expect(await callError(client, "export_stl", { script: SCRIPT, path: target })).toContain(
      message,
    );
    expect(fake.requests).toEqual([]);
  });

  it("rejects escaping through a symlinked directory", async () => {
    const { client, out } = await setup();
    const outside = testSettings().outputDir;
    fs.symlinkSync(outside, path.join(out, "link"));
    expect(await callError(client, "export_stl", { script: SCRIPT, path: "link/x.stl" })).toContain(
      "inside the output directory",
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("works with a symlinked output directory", async () => {
    const real = testSettings().outputDir;
    const alias = path.join(testSettings().outputDir, "alias");
    fs.symlinkSync(real, alias);
    const fake = new FakeScratchcad();
    const client = await connect(testSettings({ outputDir: alias }), fake);
    await call(client, "export_stl", { script: SCRIPT, path: "part.stl" });
    expect(fs.readFileSync(path.join(real, "part.stl"), "utf8")).toBe("solid-bytes");
  });

  it("rejects a directory target", async () => {
    const { client, fake, out } = await setup();
    fs.mkdirSync(path.join(out, "folder.stl"));
    const text = await callError(client, "export_stl", {
      script: SCRIPT,
      path: "folder.stl",
      overwrite: true,
    });
    expect(text).toContain("is a directory");
    expect(fake.requests).toEqual([]);
  });

  it("writes nothing when scratchcad fails", async () => {
    const { client, fake, out } = await setup();
    fake.handler = scratchcadError(422, "limit_exceeded", "mesh has too many triangles");
    const text = await callError(client, "export_stl", { script: SCRIPT, path: "big.stl" });
    expect(text.startsWith("limit_exceeded: mesh has too many triangles")).toBe(true);
    expect(fs.existsSync(path.join(out, "big.stl"))).toBe(false);
  });
});

describe("save_script and read_script", () => {
  it("validates and writes the script with a region line", async () => {
    const { client, fake, out } = await setup("http://localhost:8000/");
    const result = await call(client, "save_script", {
      script: SCRIPT,
      path: "parts/my ball.rhai",
      center: [1, 2, 3],
      half_size: 2.5,
    });
    const text = `// region: center=[1, 2, 3] half_size=2.5\n${SCRIPT}\n`;
    expect(fs.readFileSync(path.join(out, "parts/my ball.rhai"), "utf8")).toBe(text);
    expect(result.structuredContent).toEqual({
      path: path.join(out, "parts/my ball.rhai"),
      bytes: text.length,
      nodes: 9,
      center: [1, 2, 3],
      half_size: 2.5,
      editor_url: "http://localhost:8000/?open=parts%2Fmy%20ball.rhai",
    });
    expect(fake.last.url.pathname).toBe("/v1/scripts/validate");
    expect(fake.last.body).toEqual({ script: SCRIPT });
  });

  it("has no editor link when the editor is off", async () => {
    const { client } = await setup(null);
    const result = await call(client, "save_script", { script: SCRIPT, path: "a.rhai" });
    expect(result.structuredContent!.editor_url).toBeNull();
  });

  it("keeps or replaces an existing region line", async () => {
    const { client, out } = await setup();
    const script = `// region: center=[0, 0, 5] half_size=12\n${SCRIPT}`;
    await call(client, "save_script", { script, path: "a.rhai" });
    expect(fs.readFileSync(path.join(out, "a.rhai"), "utf8")).toBe(`${script}\n`);
    await call(client, "save_script", { script, path: "b.rhai", half_size: 20 });
    expect(fs.readFileSync(path.join(out, "b.rhai"), "utf8")).toMatch(
      /^\/\/ region: center=\[0, 0, 5\] half_size=20\n/,
    );
  });

  it("defaults to the unit region", async () => {
    const { client, out } = await setup();
    await call(client, "save_script", { script: SCRIPT, path: "a.rhai" });
    expect(fs.readFileSync(path.join(out, "a.rhai"), "utf8")).toBe(
      `// region: center=[0, 0, 0] half_size=1\n${SCRIPT}\n`,
    );
  });

  it("writes nothing for an invalid script", async () => {
    const { client, fake, out } = await setup();
    fake.handler = scratchcadError(422, "script_error", "script error: oops (line 1, position 2)");
    expect(await callError(client, "save_script", { script: "let", path: "bad.rhai" })).toBe(
      "script_error: script error: oops (line 1, position 2)",
    );
    expect(fs.existsSync(path.join(out, "bad.rhai"))).toBe(false);
  });

  it("refuses to overwrite by default", async () => {
    const { client, fake, out } = await setup();
    const target = path.join(out, "a.rhai");
    fs.writeFileSync(target, "// mine\n");
    expect(await callError(client, "save_script", { script: SCRIPT, path: "a.rhai" })).toContain(
      "already exists",
    );
    expect(fake.requests).toEqual([]);
    await call(client, "save_script", { script: SCRIPT, path: "a.rhai", overwrite: true });
    expect(fs.readFileSync(target, "utf8")).toContain(SCRIPT);
  });

  it.each([
    ["../a.rhai", "inside the output directory"],
    ["a.stl", "end in .rhai"],
    ["", "empty"],
  ])("rejects the path '%s'", async (target, message) => {
    const { client, fake } = await setup();
    expect(await callError(client, "save_script", { script: SCRIPT, path: target })).toContain(
      message,
    );
    expect(fake.requests).toEqual([]);
  });

  it("reads a script and its region", async () => {
    const { client, fake, out } = await setup();
    const text = `// region: center=[0, -1, 0] half_size=4\n${SCRIPT}\n`;
    fs.writeFileSync(path.join(out, "a.rhai"), text);
    const result = await call(client, "read_script", { path: "a.rhai" });
    expect(result.structuredContent).toEqual({
      path: path.join(out, "a.rhai"),
      script: text,
      center: [0, -1, 0],
      half_size: 4,
    });
    expect(fake.requests).toEqual([]);
  });

  it("reads a script without a region line", async () => {
    const { client, out } = await setup();
    fs.writeFileSync(path.join(out, "a.rhai"), SCRIPT);
    const result = await call(client, "read_script", { path: "a.rhai" });
    expect(result.structuredContent).toMatchObject({ center: null, half_size: null });
  });

  it("explains read errors", async () => {
    const { client, out } = await setup();
    fs.writeFileSync(path.join(out, "binary.rhai"), Buffer.from([0xff, 0xfe]));
    expect(await callError(client, "read_script", { path: "binary.rhai" })).toContain("not UTF-8");
    expect(await callError(client, "read_script", { path: "nope.rhai" })).toContain(
      "does not exist",
    );
    expect(await callError(client, "read_script", { path: "a.stl" })).toContain("end in .rhai");
  });
});

describe("errors shared by every tool", () => {
  it.each([
    ["validate_script", {}],
    ["evaluate", { points: [[0, 0, 0]] }],
    ["render_2d", {}],
    ["render_3d", {}],
    ["export_stl", { path: "x.stl" }],
    ["save_script", { path: "x.rhai" }],
  ])("%s reports an unreachable server", async (tool, args) => {
    const settings = testSettings();
    const fake = new FakeScratchcad();
    fake.handler = () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    };
    const client = await connect(settings, fake);
    const text = await callError(client, tool, { script: SCRIPT, ...args });
    expect(text).toMatch(/could not reach scratchcad at http:\/\/scratchcad\.test .*running/);
  });

  it("masks unexpected errors", async () => {
    const { client, fake } = await setup();
    fake.handler = () => response(200, "not json");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const text = await callError(client, "validate_script", { script: SCRIPT });
      expect(text).toBe("Error calling tool: an internal error occurred");
      expect(text).not.toContain("JSON");
      expect(errors).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});
