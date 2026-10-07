import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, sendsTokenInCleartext, settingsFromEnv } from "../src/config.ts";

describe("settingsFromEnv", () => {
  it("has defaults", () => {
    expect(settingsFromEnv({})).toEqual({
      url: "http://127.0.0.1:8080",
      apiToken: null,
      timeoutS: 60,
      outputDir: path.resolve("."),
      transport: "stdio",
      host: "127.0.0.1",
      port: 8000,
      allowedHosts: ["localhost", "127.0.0.1"],
      editor: true,
    });
  });

  it("reads every variable", () => {
    expect(
      settingsFromEnv({
        SCRATCHCAD_URL: "https://cad.example.com/api/",
        SCRATCHCAD_API_TOKEN: " s3cret ",
        SCRATCHCAD_MCP_TIMEOUT_S: "12.5",
        SCRATCHCAD_MCP_OUTPUT_DIR: "/tmp/parts",
        SCRATCHCAD_MCP_TRANSPORT: "http",
        SCRATCHCAD_MCP_HOST: "0.0.0.0",
        SCRATCHCAD_MCP_PORT: "9001",
        SCRATCHCAD_MCP_ALLOWED_HOSTS: "localhost, mcp.internal ,",
        SCRATCHCAD_MCP_EDITOR: "off",
      }),
    ).toEqual({
      url: "https://cad.example.com/api",
      apiToken: "s3cret",
      timeoutS: 12.5,
      outputDir: "/tmp/parts",
      transport: "http",
      host: "0.0.0.0",
      port: 9001,
      allowedHosts: ["localhost", "mcp.internal"],
      editor: false,
    });
  });

  it("falls back to defaults for blank values", () => {
    const blank = Object.fromEntries(
      ["URL", "API_TOKEN", "MCP_TIMEOUT_S", "MCP_TRANSPORT", "MCP_PORT", "MCP_EDITOR"].map((n) => [
        `SCRATCHCAD_${n}`,
        "  ",
      ]),
    );
    expect(settingsFromEnv(blank)).toEqual(settingsFromEnv({}));
  });

  it("expands ~ in the output directory", () => {
    expect(settingsFromEnv({ SCRATCHCAD_MCP_OUTPUT_DIR: "~/parts" }).outputDir).toBe(
      path.join(os.homedir(), "parts"),
    );
  });

  it("reads the process environment by default", () => {
    process.env.SCRATCHCAD_URL = "http://10.0.0.5:8080";
    try {
      expect(settingsFromEnv().url).toBe("http://10.0.0.5:8080");
    } finally {
      delete process.env.SCRATCHCAD_URL;
    }
  });

  it.each([
    ["SCRATCHCAD_URL", "localhost:8080", "must start with http:// or https://"],
    ["SCRATCHCAD_URL", "ftp://host", "must start with http:// or https://"],
    ["SCRATCHCAD_MCP_TIMEOUT_S", "soon", "must be a number"],
    ["SCRATCHCAD_MCP_TIMEOUT_S", "0", "must be positive"],
    ["SCRATCHCAD_MCP_TIMEOUT_S", "-3", "must be positive"],
    ["SCRATCHCAD_MCP_TIMEOUT_S", "Infinity", "must be positive"],
    ["SCRATCHCAD_MCP_TRANSPORT", "sse", "must be stdio or http"],
    ["SCRATCHCAD_MCP_TRANSPORT", "HTTP", "must be stdio or http"],
    ["SCRATCHCAD_MCP_PORT", "http", "must be an integer"],
    ["SCRATCHCAD_MCP_PORT", "80.5", "must be an integer"],
    ["SCRATCHCAD_MCP_PORT", "0", "between 1 and 65535"],
    ["SCRATCHCAD_MCP_PORT", "65536", "between 1 and 65535"],
    ["SCRATCHCAD_MCP_ALLOWED_HOSTS", " , ", "at least one host"],
    ["SCRATCHCAD_MCP_EDITOR", "yes", "must be on or off"],
  ])("rejects %s=%s", (name, value, reason) => {
    expect(() => settingsFromEnv({ [name]: value })).toThrow(ConfigError);
    expect(() => settingsFromEnv({ [name]: value })).toThrow(reason);
  });
});

describe("sendsTokenInCleartext", () => {
  it.each([
    ["http://cad.example.com", "s3cret", true],
    ["http://server:8080", "s3cret", true],
    ["http://10.0.0.5:8080", "s3cret", true],
    ["https://cad.example.com", "s3cret", false],
    ["http://localhost:8080", "s3cret", false],
    ["http://127.0.0.1:8080", "s3cret", false],
    ["http://[::1]:8080", "s3cret", false],
    ["http://cad.example.com", null, false],
  ])("%s with token %s is %s", (url, apiToken, expected) => {
    expect(sendsTokenInCleartext({ url, apiToken })).toBe(expected);
  });
});
