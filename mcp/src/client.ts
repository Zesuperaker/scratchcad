// A small client for the scratchcad HTTP API, which may be local or remote.
//
// It uses node:http rather than fetch: the service sends one `x-warning`
// header per warning, and fetch joins repeated headers with ", ", which is
// ambiguous when a warning itself contains a comma.
import http from "node:http";
import https from "node:https";
import type { Settings } from "./config.ts";

// Longest excerpt of a non-JSON error body that is passed on to the model.
const MAX_BODY_EXCERPT = 500;

export interface RawResponse {
  status: number;
  statusText: string;
  /** Lower-case names; repeated headers keep every value. */
  headers: Record<string, string[]>;
  body: Buffer;
}

export interface SendOptions {
  headers: Record<string, string>;
  body: string | Buffer;
  timeoutMs: number;
}

export type Send = (url: URL, options: SendOptions) => Promise<RawResponse>;

/** The request took longer than the configured timeout. */
export class TimeoutError extends Error {
  override name = "TimeoutError";
}

/** POSTs with node:http(s). */
export const nodeSend: Send = (url, { headers, body, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
    });
    const timer = setTimeout(
      () => request.destroy(new TimeoutError(`no response within ${timeoutMs} ms`)),
      timeoutMs,
    );
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        clearTimeout(timer);
        // A client response always has a status and every header a value.
        resolve({
          status: response.statusCode!,
          statusText: response.statusMessage!,
          headers: response.headersDistinct as Record<string, string[]>,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.end(body);
  });

/** A request to scratchcad failed. The message is written for the model to read. */
export class ScratchcadError extends Error {
  override name = "ScratchcadError";
  readonly code: string | null;
  readonly status: number | null;

  constructor(message: string, code: string | null = null, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** A PNG or STL response, with the metadata scratchcad sends in headers. */
export interface BinaryResult {
  data: Buffer;
  computeMs: number | null;
  triangles: number | null;
  /**
   * The request worked, but the result may not be what was meant (for
   * example a mesh cut open where the part leaves the meshed region).
   */
  warnings: string[];
}

export type Body = Record<string, unknown>;

export class ScratchcadClient {
  readonly url: string;
  private readonly timeoutS: number;
  private readonly headers: Record<string, string>;
  private readonly send: Send;

  constructor(settings: Pick<Settings, "url" | "apiToken" | "timeoutS">, send: Send = nodeSend) {
    this.url = settings.url;
    this.timeoutS = settings.timeoutS;
    this.send = send;
    this.headers = { "user-agent": "scratchcad-mcp", "content-type": "application/json" };
    if (settings.apiToken) this.headers.authorization = `Bearer ${settings.apiToken}`;
  }

  async validate(body: Body): Promise<Body> {
    return json(await this.post("/v1/scripts/validate", body));
  }

  async eval(body: Body): Promise<Body> {
    return json(await this.post("/v1/eval", body));
  }

  async raster2d(body: Body): Promise<BinaryResult> {
    return binary(await this.post("/v1/raster/2d", body));
  }

  async raster3d(body: Body): Promise<BinaryResult> {
    return binary(await this.post("/v1/raster/3d", body));
  }

  async exportStl(body: Body): Promise<BinaryResult> {
    return binary(await this.post("/v1/export/stl", body));
  }

  /**
   * POSTs a JSON body and returns the response as it came, errors included;
   * the editor's proxy uses this. Throws ScratchcadError only when scratchcad
   * can't be reached or doesn't answer in time.
   */
  async forward(path: string, body: string): Promise<RawResponse> {
    try {
      // Concatenate, so a SCRATCHCAD_URL with a path prefix keeps it.
      return await this.send(new URL(`${this.url}${path}`), {
        headers: this.headers,
        body,
        timeoutMs: this.timeoutS * 1000,
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw new ScratchcadError(
          `scratchcad at ${this.url} did not respond within ${this.timeoutS} s`,
        );
      }
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new ScratchcadError(
        `could not reach scratchcad at ${this.url} (${detail}). Is the server running?`,
      );
    }
  }

  private async post(path: string, body: Body): Promise<RawResponse> {
    const response = await this.forward(path, JSON.stringify(body));
    if (response.status >= 400) throw errorFrom(response);
    return response;
  }
}

function header(response: RawResponse, name: string): string | null {
  return response.headers[name]?.[0] ?? null;
}

function json(response: RawResponse): Body {
  return JSON.parse(response.body.toString("utf8")) as Body;
}

function headerNumber(response: RawResponse, name: string, integer: boolean): number | null {
  const value = header(response, name);
  if (value === null) return null;
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number)) return null;
  if (integer && !Number.isInteger(number)) return null;
  return number;
}

function binary(response: RawResponse): BinaryResult {
  return {
    data: response.body,
    computeMs: headerNumber(response, "x-compute-ms", false),
    triangles: headerNumber(response, "x-triangle-count", true),
    warnings: response.headers["x-warning"] ?? [],
  };
}

export function errorFrom(response: RawResponse): ScratchcadError {
  const { status } = response;
  // Server-side failures hide their details from clients but log them under
  // the request id, so pass it on: it is how the logs are searched.
  const requestId = header(response, "x-request-id");
  const trace =
    status >= 500 && requestId
      ? ` (scratchcad logged the details under request id ${requestId})`
      : "";
  const text = response.body.toString("utf8");
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const error = parsed.error;
    if (error && error.code !== undefined && error.message !== undefined) {
      code = String(error.code);
      message = String(error.message);
    }
  } catch {
    // Not JSON; fall through to the excerpt below.
  }

  if (code === null) {
    const excerpt = text.slice(0, MAX_BODY_EXCERPT).trim() || response.statusText;
    return new ScratchcadError(
      `scratchcad returned HTTP ${status}: ${excerpt}${trace}`,
      null,
      status,
    );
  }

  let hint = "";
  if (code === "unauthorized") {
    hint = " (set SCRATCHCAD_API_TOKEN to the token the scratchcad server was started with)";
  } else if (code === "overloaded") {
    hint = " (the server is busy; retry in a moment)";
  } else if (code === "limit_exceeded") {
    hint = " (reduce the size, resolution or complexity of the request)";
  }
  return new ScratchcadError(`${code}: ${message}${hint}${trace}`, code, status);
}
