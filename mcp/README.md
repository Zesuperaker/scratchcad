# madcad-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants model
parts with the [madcad](../server) service. It is a thin wrapper over the
HTTP API, built with [FastMCP](https://gofastmcp.com) 4.0.8, and it runs over
stdio.

## Tools

| tool | endpoint | what the model uses it for |
|---|---|---|
| `validate_script` | `POST /v1/scripts/validate` | Catch Rhai errors (with line and column) before rendering |
| `render_3d` | `POST /v1/raster/3d` | See the part: returns a shaded PNG as MCP image content |
| `render_2d` | `POST /v1/raster/2d` | See inside the part: the cross-section at z = 0 |
| `evaluate` | `POST /v1/eval` | Measure exactly: field values, gradients or interval bounds |
| `export_stl` | `POST /v1/export/stl` | Write the finished mesh to a `.stl` file |

The server's MCP `instructions` carry a scripting guide: the shape
constructors, how `draw` works, the units, and how to size the view region
so parts aren't clipped. Every parameter is documented in the tool schemas,
and invalid arguments are rejected before any request is sent.

## Setup

Start madcad first (`cd ../server && cargo run --release`), then register
this server with your MCP client.

**Claude Code** (run from the repo root):

```sh
claude mcp add madcad -- uv run --project "$PWD/mcp" madcad-mcp
```

**Claude Desktop** and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "madcad": {
      "command": "uv",
      "args": ["run", "--project", "/absolute/path/to/madcad/mcp", "madcad-mcp"],
      "env": { "MADCAD_MCP_OUTPUT_DIR": "/absolute/path/for/stl/files" }
    }
  }
}
```

## Configuration

| env | default | |
|---|---|---|
| `MADCAD_URL` | `http://127.0.0.1:8080` | where madcad is listening |
| `MADCAD_API_TOKEN` | unset | bearer token, if madcad was started with one |
| `MADCAD_MCP_TIMEOUT_S` | `60` | HTTP timeout per request |
| `MADCAD_MCP_OUTPUT_DIR` | the working directory | where `export_stl` writes files |

`export_stl` only writes `.stl` files inside `MADCAD_MCP_OUTPUT_DIR`. Paths
that leave it (`..`, absolute paths elsewhere, symlinks) are refused, and an
existing file is only replaced when the model passes `overwrite: true`.

## Development

```sh
uv sync
uv run ruff format --check && uv run ruff check && uv run mypy
uv run pytest --cov            # CI requires 100% line and branch coverage
```

The tests cover three layers:
- `test_config.py` and `test_client.py`: settings parsing, and the HTTP client
  against a mock transport, including every error path
- `test_server.py`: each tool through a real in-memory MCP client session,
  covering schemas, request bodies, image content, path safety and error masking
- `test_integration.py`: the MCP server against a real madcad binary, plus
  the `python -m madcad_mcp` process over stdio. It uses `$MADCAD_BIN` or
  `../server/target/{release,debug}/madcad`, and those tests are skipped when
  no binary has been built.
