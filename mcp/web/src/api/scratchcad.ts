// The scratchcad service, reached through the dev server's /api/scratchcad
// proxy (which adds the API token, if there is one).
import type { Vec3 } from "../../../src/shared/region.ts";
import { errorFrom } from "./errors";

const BASE = "/api/scratchcad/v1";

export interface Validated {
  nodes: number;
  output: string[];
  compileMs: number;
}

export interface Mesh {
  stl: ArrayBuffer;
  triangles: number | null;
  computeMs: number | null;
  warnings: string[];
}

export interface MeshRequest {
  script: string;
  center: Vec3;
  halfSize: number;
  depth: number;
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await errorFrom(response);
  return response;
}

export async function validate(script: string, signal?: AbortSignal): Promise<Validated> {
  const response = await post("/scripts/validate", { script }, signal);
  const body = (await response.json()) as { nodes: number; output: string[]; compile_ms: number };
  return { nodes: body.nodes, output: body.output, compileMs: body.compile_ms };
}

export async function mesh(request: MeshRequest, signal?: AbortSignal): Promise<Mesh> {
  const response = await post(
    "/export/stl",
    {
      script: request.script,
      center: request.center,
      half_size: request.halfSize,
      depth: request.depth,
    },
    signal,
  );
  const number = (name: string) => {
    const value = response.headers.get(name);
    return value === null ? null : Number(value);
  };
  // The service sends one x-warning header per warning; fetch joins repeats
  // with ", ". Meshing reports at most one warning, so this is exact.
  const warning = response.headers.get("x-warning");
  return {
    stl: await response.arrayBuffer(),
    triangles: number("x-triangle-count"),
    computeMs: number("x-compute-ms"),
    warnings: warning ? [warning] : [],
  };
}
