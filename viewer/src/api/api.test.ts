import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { fileUrl, listFiles, readMesh, readScript, writeFile } from "./files";
import { mesh, validate } from "./scratchcad";

function stubFetch(response: Response) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scratchcad", () => {
  it("validates", async () => {
    const fetch = stubFetch(json({ nodes: 9, output: ["hi"], compile_ms: 0.5 }));
    await expect(validate("draw(x);")).resolves.toEqual({
      nodes: 9,
      output: ["hi"],
      compileMs: 0.5,
    });
    expect(fetch).toHaveBeenCalledWith("/api/scratchcad/v1/scripts/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "draw(x);" }),
      signal: undefined,
    });
  });

  it("meshes, reading metadata from headers", async () => {
    const fetch = stubFetch(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "x-triangle-count": "12",
          "x-compute-ms": "4.5",
          "x-warning": "the shape reaches the boundary on its -x, +x side(s)",
        },
      }),
    );
    const signal = new AbortController().signal;
    const result = await mesh({ script: "s", center: [1, 2, 3], halfSize: 4, depth: 6 }, signal);
    expect(new Uint8Array(result.stl)).toEqual(new Uint8Array([1, 2, 3]));
    expect(result).toMatchObject({
      triangles: 12,
      computeMs: 4.5,
      warnings: ["the shape reaches the boundary on its -x, +x side(s)"],
    });
    expect(fetch.mock.calls[0]).toEqual([
      "/api/scratchcad/v1/export/stl",
      expect.objectContaining({
        body: JSON.stringify({ script: "s", center: [1, 2, 3], half_size: 4, depth: 6 }),
        signal,
      }),
    ]);
  });

  it("meshes without optional headers", async () => {
    stubFetch(new Response(new Uint8Array()));
    const result = await mesh({ script: "s", center: [0, 0, 0], halfSize: 1, depth: 4 });
    expect(result).toMatchObject({ triangles: null, computeMs: null, warnings: [] });
  });

  it("throws the service's error", async () => {
    stubFetch(json({ error: { code: "script_error", message: "bad (line 1, position 2)" } }, 422));
    const error = await validate("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: "script_error",
      message: "bad (line 1, position 2)",
    });
  });

  it("falls back to the status when the body is not an error", async () => {
    stubFetch(new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    await expect(validate("x")).rejects.toMatchObject({
      code: "http_error",
      message: "502 Bad Gateway",
    });
  });
});

describe("files", () => {
  const entry = { path: "a b/c.rhai", kind: "script", bytes: 3, modified: 1, version: "v1" };

  it("encodes each path segment", () => {
    expect(fileUrl("a b/c#.rhai")).toBe("/api/files/a%20b/c%23.rhai");
  });

  it("lists", async () => {
    const fetch = stubFetch(json([entry]));
    await expect(listFiles()).resolves.toEqual([entry]);
    expect(fetch).toHaveBeenCalledWith("/api/files", { cache: "no-store", signal: undefined });
  });

  it("reads scripts with their version, and meshes", async () => {
    stubFetch(new Response("draw(x);", { headers: { "x-version": "v2" } }));
    await expect(readScript("a.rhai")).resolves.toEqual({ text: "draw(x);", version: "v2" });
    stubFetch(new Response("no version"));
    await expect(readScript("a.rhai")).resolves.toEqual({ text: "no version", version: "" });
    stubFetch(new Response(new Uint8Array([7])));
    expect(new Uint8Array(await readMesh("a.stl"))).toEqual(new Uint8Array([7]));
  });

  it("writes with the expected version", async () => {
    const fetch = stubFetch(json(entry));
    await expect(writeFile("a b/c.rhai", "text", "v1")).resolves.toEqual(entry);
    expect(fetch).toHaveBeenCalledWith("/api/files/a%20b/c.rhai", {
      method: "PUT",
      headers: { "x-expected-version": "v1" },
      body: "text",
    });
    stubFetch(json(entry));
    await writeFile("c.rhai", "text", null);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  it("reports conflicts with the current version", async () => {
    stubFetch(json({ error: { code: "conflict", message: "changed", current: "v9" } }, 409));
    await expect(writeFile("c.rhai", "text", "v1")).rejects.toMatchObject({
      status: 409,
      current: "v9",
    });
  });

  it("throws on failed reads and lists", async () => {
    stubFetch(json({ error: { code: "not_found", message: "gone" } }, 404));
    await expect(readScript("x.rhai")).rejects.toMatchObject({ code: "not_found" });
    stubFetch(json({ error: { code: "invalid_path", message: "no" } }, 400));
    await expect(listFiles()).rejects.toMatchObject({ code: "invalid_path" });
  });
});
