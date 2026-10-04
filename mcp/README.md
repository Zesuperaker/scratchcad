# scratchcad-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants model
parts with the [scratchcad](../server) service. It is a thin wrapper over the
HTTP API, built with [FastMCP](https://gofastmcp.com) 4.0.8 on Python 3.14
(and only 3.14, pinned in `pyproject.toml` and `.python-version`). It runs
over stdio by default, or over streamable HTTP in the dev container.

## Tools

| tool | endpoint | what the model uses it for |
|---|---|---|
| `validate_script` | `POST /v1/scripts/validate` | Catch Rhai errors (with line and column) before rendering |
| `render_3d` | `POST /v1/raster/3d` | See the part: returns a shaded PNG as MCP image content |
| `render_2d` | `POST /v1/raster/2d` | See inside the part: the cross-section at z = 0 |
| `evaluate` | `POST /v1/eval` | Measure exactly: field values, gradients or interval bounds |
| `save_script` | `POST /v1/scripts/validate` | Deliver the part: check the script and save it as `.rhai`, recording its region |
| `read_script` | — | Read a saved script back, including the user's edits from the editor |
| `export_stl` | `POST /v1/export/stl` | Write a mesh to a `.stl` file, when the user asks for one |

The server's MCP `instructions` carry a scripting guide: the shape
constructors, how `draw` works, the units, and how to size the view region
so parts aren't clipped. Every parameter is documented in the tool schemas,
and invalid arguments are rejected before any request is sent.

## Setup

The simplest way is the Docker dev stack in the repo root: `docker compose up
--build`, then `claude mcp add --transport http scratchcad http://localhost:8000/mcp`.

To run it directly instead, start scratchcad first (`cd ../server && cargo run
--release`), then register this server with your MCP client.

**Claude Code** (run from the repo root):

```sh
claude mcp add scratchcad -- uv run --project "$PWD/mcp" scratchcad-mcp
```

**Claude Desktop** and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "scratchcad": {
      "command": "uv",
      "args": ["run", "--project", "/absolute/path/to/scratchcad/mcp", "scratchcad-mcp"],
      "env": { "SCRATCHCAD_MCP_OUTPUT_DIR": "/absolute/path/for/stl/files" }
    }
  }
}
```

## Configuration

| env | default | |
|---|---|---|
| `SCRATCHCAD_URL` | `http://127.0.0.1:8080` | where scratchcad is listening |
| `SCRATCHCAD_API_TOKEN` | unset | bearer token, if scratchcad was started with one |
| `SCRATCHCAD_MCP_TIMEOUT_S` | `60` | HTTP timeout per request |
| `SCRATCHCAD_MCP_OUTPUT_DIR` | the working directory | where `save_script` and `export_stl` write files |
| `SCRATCHCAD_MCP_TRANSPORT` | `stdio` | `stdio`, or `http` for streamable HTTP at `/mcp` |
| `SCRATCHCAD_MCP_HOST` | `127.0.0.1` | HTTP bind address |
| `SCRATCHCAD_MCP_PORT` | `8000` | HTTP port |
| `SCRATCHCAD_MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | `Host` headers accepted in HTTP mode |

In HTTP mode, `Host` and `Origin` checking (DNS-rebinding protection) is
always on, including when bound to `0.0.0.0` as in the container. FastMCP
would otherwise switch it off for non-loopback binds. `GET /healthz` returns
`ok` for health checks.

## Scripts and the file API

A saved script's first line records the region to mesh, so the editor (and
anyone else) can mesh it without guessing:

```
// region: center=[0, 0, 0] half_size=30
```

`save_script` writes that line from its `center` and `half_size` arguments,
keeping the script's existing one when they are left out. The guide also asks
the model to put editable dimensions in top-level lines like
`let width = 20.0; // [5, 50] Width (mm)`, which the editor shows as sliders.

In HTTP mode the server serves the output directory to the
[editor](../viewer), with the same path rules as the tools:

| route | |
|---|---|
| `GET /files` | The `.rhai` and `.stl` files, newest first, each with a `version` (hidden directories are skipped) |
| `GET /files/<path>` | One file, with its version in the `x-version` header |
| `PUT /files/<path>` | Write a file atomically. With `x-expected-version: <version>` the write is refused with 409 if the file changed since; with `new`, if it exists. |

Anything that isn't a `.rhai` or `.stl` file inside the output directory,
including symlinks that point out of it, is refused. Errors use the scratchcad
service's format, `{"error": {"code": ..., "message": ...}}`.

## Development

```sh
uv sync                        # uses Python 3.14; uv installs it if needed
uv run ruff format --check && uv run ruff check && uv run mypy
uv run pytest --cov            # CI requires 100% line and branch coverage
```

The same checks run in the dev container: `docker compose run --rm mcp uv run pytest`.

The tests cover three layers:
- `test_config.py` and `test_client.py`: settings parsing, and the HTTP client
  against a mock transport, including every error path
- `test_server.py`: each tool through a real in-memory MCP client session,
  covering schemas, request bodies, image content, path safety and error masking,
  plus the file API
- `test_integration.py`: the MCP server against a real scratchcad binary, plus
  the `python -m scratchcad_mcp` process over stdio and over HTTP (including a
  forged `Host` header being rejected). The scratchcad tests use `$SCRATCHCAD_BIN` or
  `../server/target/{release,debug}/scratchcad`, and are skipped when no binary
  has been built.

Tests ignore any `SCRATCHCAD_*` variables in your environment, so an exported
setting can't change their outcome.
