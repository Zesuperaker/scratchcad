// Settings for the MCP server and editor, read from environment variables.
import os from "node:os";
import path from "node:path";

export const DEFAULT_URL = "http://127.0.0.1:8080";
// The scratchcad defaults allow a job to queue for 5 s and then run for 30 s,
// so the HTTP timeout needs some headroom on top of that.
export const DEFAULT_TIMEOUT_S = 60;
export const DEFAULT_PORT = 8000;
// Host (and Origin) names accepted over HTTP. An allowlist keeps DNS-rebinding
// protection on even when bound to 0.0.0.0 inside a container.
export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1"];

export type Transport = "stdio" | "http";

export interface Settings {
  /** The scratchcad service, which may run anywhere. */
  url: string;
  apiToken: string | null;
  timeoutS: number;
  /** Where scripts and meshes are read and written; always local. */
  outputDir: string;
  /** How MCP clients connect: stdio, or streamable HTTP at /mcp. */
  transport: Transport;
  host: string;
  port: number;
  allowedHosts: string[];
  /** Serve the editor (in stdio mode too, on host:port). */
  editor: boolean;
}

/** An environment variable has an invalid value. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const get = (name: string) => (env[name] ?? "").trim();

  const url = get("SCRATCHCAD_URL") || DEFAULT_URL;
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError(`SCRATCHCAD_URL must start with http:// or https://, got '${url}'`);
  }

  const rawTimeout = get("SCRATCHCAD_MCP_TIMEOUT_S");
  let timeoutS = DEFAULT_TIMEOUT_S;
  if (rawTimeout) {
    timeoutS = Number(rawTimeout);
    if (Number.isNaN(timeoutS)) {
      throw new ConfigError(`SCRATCHCAD_MCP_TIMEOUT_S must be a number, got '${rawTimeout}'`);
    }
    if (!(timeoutS > 0) || !Number.isFinite(timeoutS)) {
      throw new ConfigError(`SCRATCHCAD_MCP_TIMEOUT_S must be positive, got '${rawTimeout}'`);
    }
  }

  const transport = get("SCRATCHCAD_MCP_TRANSPORT") || "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new ConfigError(`SCRATCHCAD_MCP_TRANSPORT must be stdio or http, got '${transport}'`);
  }

  const rawPort = get("SCRATCHCAD_MCP_PORT");
  let port = DEFAULT_PORT;
  if (rawPort) {
    if (!/^\d+$/.test(rawPort)) {
      throw new ConfigError(`SCRATCHCAD_MCP_PORT must be an integer, got '${rawPort}'`);
    }
    port = Number(rawPort);
    if (port < 1 || port > 65535) {
      throw new ConfigError(`SCRATCHCAD_MCP_PORT must be between 1 and 65535, got ${port}`);
    }
  }

  const rawHosts = get("SCRATCHCAD_MCP_ALLOWED_HOSTS");
  let allowedHosts = DEFAULT_ALLOWED_HOSTS;
  if (rawHosts) {
    allowedHosts = rawHosts
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (allowedHosts.length === 0) {
      throw new ConfigError("SCRATCHCAD_MCP_ALLOWED_HOSTS must list at least one host");
    }
  }

  const editor = get("SCRATCHCAD_MCP_EDITOR") || "on";
  if (editor !== "on" && editor !== "off") {
    throw new ConfigError(`SCRATCHCAD_MCP_EDITOR must be on or off, got '${editor}'`);
  }

  const outputDir = get("SCRATCHCAD_MCP_OUTPUT_DIR") || ".";
  return {
    url: url.replace(/\/+$/, ""),
    apiToken: get("SCRATCHCAD_API_TOKEN") || null,
    timeoutS,
    outputDir: path.resolve(outputDir.replace(/^~(?=$|\/)/, os.homedir())),
    transport,
    host: get("SCRATCHCAD_MCP_HOST") || "127.0.0.1",
    port,
    allowedHosts,
    editor: editor === "on",
  };
}
