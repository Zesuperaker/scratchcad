# scratchcad-mcp

The local half of scratchcad: an [MCP](https://modelcontextprotocol.io) server
that lets AI assistants model parts with the [scratchcad service](../server),
and a browser editor for the scripts it writes. Both run in one Node process
on your machine, because they share your output directory; the scratchcad
service they call can run anywhere.

```
your machine                                anywhere: local Docker, another box, the cloud
┌───────────────────────────────────┐       ┌──────────────────────────────┐
│ scratchcad-mcp  (this package)    │ HTTP  │ scratchcad service (server/) │
│  /mcp      tools for the agent    │──────▶│  validates, evaluates,       │
│  /         the editor             │       │  renders and meshes scripts  │
│  /api/...  files + proxy          │       │  stateless, no file access   │
└───────────────────────────────────┘       └──────────────────────────────┘
        │ reads and writes
        ▼
   SCRATCHCAD_MCP_OUTPUT_DIR  (.rhai scripts, .stl meshes)
```

It is TypeScript on Node 22.18+ (24 recommended), built with the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
v2, Express, and for the editor React, Vite, Tailwind, CodeMirror and three.js.

## Tools

| tool              | endpoint                    | what the model uses it for                                                                                    |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `validate_script` | `POST /v1/scripts/validate` | Catch Rhai errors (with line and column) before rendering                                                     |
| `render_3d`       | `POST /v1/raster/3d`        | See the part: returns a shaded PNG as MCP image content                                                       |
| `render_2d`       | `POST /v1/raster/2d`        | See inside the part: the cross-section at z = 0                                                               |
| `evaluate`        | `POST /v1/eval`             | Measure exactly: field values, gradients or interval bounds                                                   |
| `save_script`     | `POST /v1/scripts/validate` | Deliver the part: check the script, save it as `.rhai` with its region, and return a link to it in the editor |
| `read_script`     | —                           | Read a saved script back, including the user's edits from the editor                                          |
| `export_stl`      | `POST /v1/export/stl`       | Write a mesh to a `.stl` file, when the user asks for one                                                     |

The server's MCP `instructions` carry a scripting guide: the shape
constructors, how `draw` works, the units, how to size the view region so parts
aren't clipped, and the conventions below. Every parameter is documented in the
tool schemas, and invalid or unknown arguments are rejected before any request
is sent.

## Setup

The Docker dev stack in the repo root runs it next to a local scratchcad:
`docker compose up --build`, then the editor is at <http://localhost:8000> and
MCP at `http://localhost:8000/mcp` (the repo's `.mcp.json` points Claude Code
there).

To run it directly (for example against a scratchcad running elsewhere):

```sh
cd mcp
npm ci && npm run build
SCRATCHCAD_URL=https://scratchcad.example.com \
SCRATCHCAD_MCP_TRANSPORT=http SCRATCHCAD_MCP_OUTPUT_DIR=~/parts npm start
```

Or let the MCP client start it over stdio. It then also serves the editor on
`SCRATCHCAD_MCP_PORT`; if another scratchcad-mcp already has that port (another
session, say), it leaves the editor to that one.

**Claude Code** (from the repo root, after `npm run build` in `mcp/`):

```sh
claude mcp add scratchcad -e SCRATCHCAD_MCP_OUTPUT_DIR="$PWD/output" -- node "$PWD/mcp/dist/server/main.js"
```

**Claude Desktop** and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "scratchcad": {
      "command": "node",
      "args": ["/absolute/path/to/scratchcad/mcp/dist/server/main.js"],
      "env": {
        "SCRATCHCAD_URL": "http://127.0.0.1:8080",
        "SCRATCHCAD_MCP_OUTPUT_DIR": "/absolute/path/for/parts"
      }
    }
  }
}
```

## Configuration

| env                            | default                 |                                                                                                                               |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SCRATCHCAD_URL`               | `http://127.0.0.1:8080` | where the scratchcad service is listening; may include a path prefix                                                          |
| `SCRATCHCAD_API_TOKEN`         | unset                   | bearer token, if scratchcad was started with one. Only this process sends it; the editor's requests get it added by the proxy |
| `SCRATCHCAD_MCP_TIMEOUT_S`     | `60`                    | HTTP timeout per request to scratchcad                                                                                        |
| `SCRATCHCAD_MCP_OUTPUT_DIR`    | the working directory   | where scripts and meshes are read and written                                                                                 |
| `SCRATCHCAD_MCP_TRANSPORT`     | `stdio`                 | `stdio`, or `http` for streamable HTTP at `/mcp`                                                                              |
| `SCRATCHCAD_MCP_HOST`          | `127.0.0.1`             | HTTP bind address (editor, and `/mcp` in HTTP mode)                                                                           |
| `SCRATCHCAD_MCP_PORT`          | `8000`                  | HTTP port                                                                                                                     |
| `SCRATCHCAD_MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1`   | `Host` and `Origin` hostnames accepted over HTTP                                                                              |
| `SCRATCHCAD_MCP_EDITOR`        | `on`                    | `off` to serve no editor (and, over stdio, no HTTP at all)                                                                    |

Every HTTP route checks the `Host` and `Origin` headers against the allowed
hosts, including when bound to `0.0.0.0` as in the container, so other websites
(and DNS rebinding) can't reach the tools, the files or the proxy through your
browser. `GET /healthz` returns `ok` for health checks. `/mcp` is stateless: each
request gets a fresh server, as the tools keep no state between calls.

## Scripts, the editor and the file API

A saved script's first line records the region to mesh, so the editor (and
anyone else) can mesh it without guessing:

```rhai
// region: center=[0, 0, 0] half_size=30
let width = 20.0; // [5, 50] Width (mm)
```

`save_script` writes that line from its `center` and `half_size` arguments,
keeping the script's existing one when they are left out. The guide asks the
model to put editable dimensions in top-level `let` lines with an optional
`[min, max]` range and label; the editor shows them as sliders and rewrites only
the number, keeping integers as integers.

The editor ([`web/`](web)) edits scripts with live preview and error markers,
exports STL files, and opens `?open=<path>` links. It talks only to this
process:

| route                         |                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/files`              | The `.rhai` and `.stl` files, newest first, each with a `version` (hidden directories are skipped)                                              |
| `GET /api/files/<path>`       | One file, with its version in the `x-version` header                                                                                            |
| `PUT /api/files/<path>`       | Write a file atomically. With `x-expected-version: <version>` the write is refused with 409 if the file changed since; with `new`, if it exists |
| `POST /api/scratchcad/v1/...` | Forwarded to scratchcad's validate, eval, raster and export endpoints, with the token added                                                     |

The file routes and the tools share one set of path rules: only `.rhai` and
`.stl` files inside the output directory; paths that leave it (`..`, absolute
paths elsewhere, symlinks) are refused, and tools only replace an existing file
when the model passes `overwrite: true`. Errors use the scratchcad service's
format, `{"error": {"code": ..., "message": ...}}`. When the agent rewrites a
script the user hasn't edited, the editor reloads it; if both changed it, the
editor asks which version to keep.

## Development

```sh
npm ci
npm run dev                      # server with --watch, editor through Vite with hot reload
npm run format:check && npm run lint && npm run typecheck
npm run coverage                 # CI requires 100% coverage
npm run build                    # dist/server (compiled server) and dist/web (editor)
```

In development Node runs the TypeScript in `src/` directly (type stripping), and
Vite runs as middleware inside the server, so the editor and its API share one
port as in production. The same checks run in the dev container:
`docker compose run --rm mcp npm test`.

| directory     |                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `src/`        | The server: config, scratchcad client, tools, workspace (path rules), HTTP app, start-up            |
| `src/shared/` | Code the server and editor share (the region line)                                                  |
| `web/`        | The editor                                                                                          |
| `tests/`      | Server tests: unit tests with a fake scratchcad, the HTTP app over real HTTP, and integration tests |

The integration tests run against a real scratchcad binary, from
`$SCRATCHCAD_BIN` or `../server/target/{release,debug}/scratchcad`, and are
skipped when none has been built (CI builds one). They also run the entry point
as a process over stdio and over HTTP, including a forged `Host` header being
rejected.
