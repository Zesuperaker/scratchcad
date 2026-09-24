# madcad

Script-driven solid modelling over HTTP, plus an MCP server so AI assistants
can use it.

| directory | what it is |
|---|---|
| [`server/`](server) | The madcad HTTP service (Rust, [Fidget](https://github.com/mkeeter/fidget) + axum). Validates, evaluates, renders and meshes [Rhai](https://rhai.rs) scripts that describe implicit surfaces. |
| [`mcp/`](mcp) | An [MCP](https://modelcontextprotocol.io) server (Python, [FastMCP](https://gofastmcp.com)) that exposes the service's five endpoints as tools, so a model can write a script, look at renders, measure the part and export an STL. |

The two are independent: the MCP server talks to the service over HTTP, so it
works with a local `cargo run` or a deployed instance.

## Quick start

```sh
# 1. Run the service
cd server && cargo run --release          # http://localhost:8080

# 2. Register the MCP server with Claude Code (from the repo root)
claude mcp add madcad -- uv run --project "$PWD/mcp" madcad-mcp
```

Then ask for a part, e.g. *"make a 20 mm cube with a 5 mm hole through it and
export it as cube.stl"*. See [`mcp/README.md`](mcp/README.md) for other
clients and configuration.

## Development

Each directory is self-contained, with its own lockfile and checks. CI runs
both (`.github/workflows/ci.yml`); the MCP tests include end-to-end runs
against a freshly built `server` binary.
