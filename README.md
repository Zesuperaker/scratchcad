# madcad

Script-driven solid modelling over HTTP, plus an MCP server so AI assistants
can use it.

| directory | what it is |
|---|---|
| [`server/`](server) | The madcad HTTP service (Rust 1.98, [Fidget](https://github.com/mkeeter/fidget) + axum). Validates, evaluates, renders and meshes [Rhai](https://rhai.rs) scripts that describe implicit surfaces. |
| [`mcp/`](mcp) | An [MCP](https://modelcontextprotocol.io) server (Python 3.14, [FastMCP](https://gofastmcp.com)) that exposes the service's five endpoints as tools, so a model can write a script, look at renders, measure the part and export an STL. |

The two are independent: the MCP server talks to the service over HTTP, so it
works with a local build, the dev containers, or a deployed instance.

## Quick start with Docker

```sh
docker compose up --build        # or `docker compose watch` to reload on edits
claude mcp add --transport http madcad http://localhost:8000/mcp
```

`compose.yaml` runs both dev images:

| service | port | image |
|---|---|---|
| `server` | `127.0.0.1:8080` | [`server/Dockerfile.dev`](server/Dockerfile.dev): `cargo run` with fast incremental rebuilds |
| `mcp` | `127.0.0.1:8000` | [`mcp/Dockerfile.dev`](mcp/Dockerfile.dev): the MCP server over streamable HTTP at `/mcp` |

Exported STL files appear in `./output`. With `docker compose watch`, edits
under `server/src` or `mcp/src` restart the affected container (the Rust
side recompiles in a few seconds), and changes to `Cargo.toml`, `Cargo.lock`,
`pyproject.toml` or `uv.lock` rebuild its image. To require an API token, put
`MADCAD_API_TOKEN=<16+ characters>` in a `.env` file next to `compose.yaml`.

Run the MCP checks inside its container with
`docker compose run --rm mcp uv run pytest`.

## Quick start without Docker

```sh
cd server && cargo run --release                                  # http://localhost:8080
claude mcp add madcad -- uv run --project "$PWD/mcp" madcad-mcp   # from the repo root
```

## Then

Ask for a part, e.g. *"make a 20 mm cube with a 5 mm hole through it and
export it as cube.stl"*. See [`mcp/README.md`](mcp/README.md) for other
clients and configuration.

## Development

Each directory is self-contained, with its own lockfile and checks. CI runs
both (`.github/workflows/ci.yml`) and builds the dev images; the MCP tests
include end-to-end runs against a freshly built `server` binary.
