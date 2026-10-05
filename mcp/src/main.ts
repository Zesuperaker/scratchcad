#!/usr/bin/env node
// Entry point: `scratchcad-mcp [--dev]`. Settings come from the environment;
// see README.md.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ConfigError, settingsFromEnv } from "./config.ts";
import { start } from "./server.ts";

let settings;
try {
  settings = settingsFromEnv();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`scratchcad-mcp: ${error.message}`);
  process.exit(2);
}

const running = await start(settings, {
  stdioTransport: () => new StdioServerTransport(),
  dev: process.argv.includes("--dev"),
});
const stop = () => void running.close().then(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
// Over stdio the client owns the process: when it closes stdin, stop, even
// though the editor's HTTP server would otherwise keep running.
if (settings.transport === "stdio") process.stdin.once("close", stop);
