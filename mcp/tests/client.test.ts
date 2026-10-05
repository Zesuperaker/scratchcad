import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { nodeSend, ScratchcadClient, ScratchcadError, TimeoutError } from "../src/client.ts";
import { FakeScratchcad, PNG, response, scratchcadError } from "./helpers.ts";

const settings = { url: "http://scratchcad.test", apiToken: null, timeoutS: 60 };

function api(fake: FakeScratchcad, overrides = {}) {
  return new ScratchcadClient({ ...settings, ...overrides }, fake.send);
}

async function failure(promise: Promise<unknown>): Promise<ScratchcadError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ScratchcadError);
  return error as ScratchcadError;
}

describe("ScratchcadClient", () => {
  it("posts JSON to the configured server", async () => {
    const fake = new FakeScratchcad();
    expect(await api(fake).validate({ script: "x" })).toEqual({
      nodes: 9,
      output: ["hi"],
      compile_ms: 0.8,
    });
    expect(fake.last.url.href).toBe("http://scratchcad.test/v1/scripts/validate");
    expect(fake.last.options.headers).toEqual({
      "user-agent": "scratchcad-mcp",
      "content-type": "application/json",
    });
    expect(fake.last.options.timeoutMs).toBe(60_000);
    expect(fake.last.body).toEqual({ script: "x" });
  });

  it("keeps a path prefix in the server URL", async () => {
    const fake = new FakeScratchcad();
    await api(fake, { url: "https://cad.example.com/scratchcad" }).forward(
      "/v1/scripts/validate",
      "{}",
    );
    expect(fake.last.url.href).toBe("https://cad.example.com/scratchcad/v1/scripts/validate");
  });

  it("sends the bearer token when configured", async () => {
    const fake = new FakeScratchcad();
    await api(fake, { apiToken: "s3cret" }).validate({ script: "x" });
    expect(fake.last.options.headers.authorization).toBe("Bearer s3cret");
  });

  it("hits each endpoint's route", async () => {
    const fake = new FakeScratchcad();
    const client = api(fake);
    expect((await client.eval({ script: "x" })).values).toEqual([-1]);
    await client.raster2d({ script: "x" });
    await client.raster3d({ script: "x" });
    await client.exportStl({ script: "x" });
    expect(fake.requests.map((r) => r.url.pathname)).toEqual([
      "/v1/eval",
      "/v1/raster/2d",
      "/v1/raster/3d",
      "/v1/export/stl",
    ]);
  });

  it("reads binary metadata from headers", async () => {
    const client = api(new FakeScratchcad());
    expect(await client.raster3d({ script: "x" })).toEqual({
      data: PNG,
      computeMs: 12.5,
      triangles: null,
      warnings: [],
    });
    expect(await client.exportStl({ script: "x" })).toMatchObject({
      computeMs: 40.25,
      triangles: 1234,
    });
  });

  it("keeps every warning header whole", async () => {
    const fake = new FakeScratchcad();
    fake.handler = () =>
      response(200, "stl", {
        "x-warning": ["the shape reaches the boundary on its -x, +x side(s)", "second"],
      });
    expect((await api(fake).exportStl({ script: "x" })).warnings).toEqual([
      "the shape reaches the boundary on its -x, +x side(s)",
      "second",
    ]);
  });

  it("ignores missing or garbled numeric headers", async () => {
    const fake = new FakeScratchcad();
    fake.handler = () =>
      response(200, "stl", { "x-compute-ms": "fast", "x-triangle-count": "1.5" });
    expect(await api(fake).exportStl({ script: "x" })).toMatchObject({
      computeMs: null,
      triangles: null,
    });
    fake.handler = () => response(200, "stl", { "x-compute-ms": " ", "x-triangle-count": "7" });
    expect(await api(fake).exportStl({ script: "x" })).toMatchObject({
      computeMs: null,
      triangles: 7,
    });
  });

  it.each([
    [422, "script_error", null],
    [400, "bad_request", null],
    [401, "unauthorized", "set SCRATCHCAD_API_TOKEN"],
    [503, "overloaded", "retry in a moment"],
    [422, "limit_exceeded", "reduce the size"],
    [504, "timeout", null],
    [500, "internal", null],
    [422, "empty_mesh", null],
  ])("keeps the code and message of a %d %s", async (status, code, hint) => {
    const fake = new FakeScratchcad();
    fake.handler = scratchcadError(status, code, "details (line 3, position 7)");
    const error = await failure(api(fake).validate({ script: "x" }));
    const prefix = `${code}: details (line 3, position 7)`;
    expect(error.message.startsWith(prefix)).toBe(true);
    expect([error.code, error.status]).toEqual([code, status]);
    if (hint === null) expect(error.message.slice(prefix.length)).not.toContain("(");
    else expect(error.message).toContain(hint);
  });

  it.each([
    [response(502, "<html>Bad Gateway</html>"), "HTTP 502: <html>Bad Gateway</html>"],
    [response(500, { message: "no error key" }), 'HTTP 500: {"message"'],
    [response(500, { error: "flat string" }), "HTTP 500: "],
    [response(503, "", {}, "Service Unavailable"), "HTTP 503: Service Unavailable"],
  ])("reports status and body for other errors (%#)", async (reply, expected) => {
    const fake = new FakeScratchcad();
    fake.handler = () => reply;
    const error = await failure(api(fake).eval({ script: "x" }));
    expect(error.message.startsWith(`scratchcad returned ${expected}`)).toBe(true);
    expect([error.code, error.status]).toEqual([null, reply.status]);
  });

  it.each([
    response(
      500,
      { error: { code: "internal", message: "internal error" } },
      { "x-request-id": "abc-123" },
    ),
    response(502, "Bad Gateway", { "x-request-id": "abc-123" }),
  ])("names the request id of server failures (%#)", async (reply) => {
    const fake = new FakeScratchcad();
    fake.handler = () => reply;
    const error = await failure(api(fake).eval({ script: "x" }));
    expect(error.message.endsWith("logged the details under request id abc-123)")).toBe(true);
  });

  it("doesn't mention the request id for client errors", async () => {
    const fake = new FakeScratchcad();
    fake.handler = () =>
      response(422, { error: { code: "script_error", message: "oops" } }, { "x-request-id": "a" });
    expect((await failure(api(fake).eval({ script: "x" }))).message).toBe("script_error: oops");
  });

  it("truncates long error bodies", async () => {
    const fake = new FakeScratchcad();
    fake.handler = () => response(500, "x".repeat(5000));
    expect((await failure(api(fake).eval({ script: "x" }))).message.length).toBeLessThan(600);
  });

  it("names the URL when scratchcad can't be reached", async () => {
    const client = new ScratchcadClient(settings, async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const error = await failure(client.validate({ script: "x" }));
    expect(error.message).toMatch(
      /could not reach scratchcad at http:\/\/scratchcad\.test .*running/,
    );
    const odd = new ScratchcadClient(settings, () => Promise.reject("weird"));
    expect((await failure(odd.validate({ script: "x" }))).message).toContain("(weird)");
  });

  it("reports the time budget on timeout", async () => {
    const client = new ScratchcadClient({ ...settings, timeoutS: 7 }, async () => {
      throw new TimeoutError("slow");
    });
    expect((await failure(client.raster3d({ script: "x" }))).message).toContain(
      "did not respond within 7 s",
    );
  });

  it("forwards raw responses, errors included", async () => {
    const fake = new FakeScratchcad();
    fake.handler = scratchcadError(422, "script_error", "nope");
    const raw = await api(fake).forward("/v1/eval", '{"script":"x"}');
    expect(raw.status).toBe(422);
    expect(fake.last.options.body).toBe('{"script":"x"}');
  });
});

describe("nodeSend", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function serve(handler: http.RequestListener): Promise<URL> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/eval`);
  }

  it("posts the body and keeps repeated headers apart", async () => {
    let received = "";
    const url = await serve((req, res) => {
      req.on("data", (chunk: Buffer) => (received += chunk));
      req.on("end", () => {
        res.setHeader("x-warning", ["a, b", "c"]);
        res.writeHead(201, "Made");
        res.end("done");
      });
    });
    const reply = await nodeSend(url, {
      headers: { "x-test": "1" },
      body: "hello",
      timeoutMs: 5000,
    });
    expect(received).toBe("hello");
    expect(reply.status).toBe(201);
    expect(reply.statusText).toBe("Made");
    expect(reply.headers["x-warning"]).toEqual(["a, b", "c"]);
    expect(reply.body.toString()).toBe("done");
  });

  it("times out", async () => {
    const url = await serve(() => {
      /* never answer */
    });
    await expect(nodeSend(url, { headers: {}, body: "", timeoutMs: 50 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("fails when nothing listens, or TLS is spoken to plain HTTP", async () => {
    const url = await serve((_req, res) => res.end());
    await expect(
      nodeSend(new URL("http://127.0.0.1:1/"), { headers: {}, body: "", timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    url.protocol = "https:";
    await expect(nodeSend(url, { headers: {}, body: "", timeoutMs: 5000 })).rejects.toThrow();
  });
});
