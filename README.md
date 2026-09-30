# scratchcad

> [!WARNING]
> scratchcad is under active development. APIs, tools and script syntax may
> change without notice, and things may break between commits.

scratchcad is a rust based solid modelling API, plus an MCP server so AI assistants
can use it.

## Quick start (requires docker)

```sh
docker compose up --build        # or `docker compose watch` to reload on edits
```

Then add the MCP server (`http://localhost:8000/mcp`) to your agent:

```sh
# Claude Code
claude mcp add --transport http scratchcad http://localhost:8000/mcp

# OpenAI Codex CLI
codex mcp add scratchcad --url http://localhost:8000/mcp

# Gemini CLI
gemini mcp add --transport http scratchcad http://localhost:8000/mcp

# VS Code (GitHub Copilot agent mode)
code --add-mcp '{"name":"scratchcad","type":"http","url":"http://localhost:8000/mcp"}'
```

For other clients, point them at `http://localhost:8000/mcp` using the
streamable HTTP transport.

`compose.yaml` runs both dev images:

| service | port | image |
|---|---|---|
| `server` | `127.0.0.1:8080` | [`server/Dockerfile.dev`](server/Dockerfile.dev): `cargo run` with fast incremental rebuilds |
| `mcp` | `127.0.0.1:8000` | [`mcp/Dockerfile.dev`](mcp/Dockerfile.dev): the MCP server over streamable HTTP at `/mcp` |

Exported STL files appear in `./output`. With `docker compose watch`, edits
under `server/src` or `mcp/src` restart the affected container (the Rust
side recompiles in a few seconds), and changes to `Cargo.toml`, `Cargo.lock`,
`pyproject.toml` or `uv.lock` rebuild its image. To require an API token, put
`SCRATCHCAD_API_TOKEN=<16+ characters>` in a `.env` file next to `compose.yaml`.

Run the MCP checks inside its container with
`docker compose run --rm mcp uv run pytest`.

## Architecture 

| directory | what it is |
|---|---|
| [`server/`](server) | The scratchcad HTTP service (Rust 1.98, [Fidget](https://github.com/mkeeter/fidget) + axum). Validates, evaluates, renders and meshes [Rhai](https://rhai.rs) scripts that describe implicit surfaces. |
| [`mcp/`](mcp) | An [MCP](https://modelcontextprotocol.io) server (Python 3.14, [FastMCP](https://gofastmcp.com)) that exposes the service's five endpoints as tools, so a model can write a script, look at renders, measure the part and export an STL. |

The two are independent: the MCP server talks to the service over HTTP, so it
works with a local build, the dev containers, or a deployed instance.

## Development

Each directory is self-contained, with its own lockfile and checks. CI runs
both (`.github/workflows/ci.yml`) and builds the dev images; the MCP tests
include end-to-end runs against a freshly built `server` binary.

Python dependencies in `mcp/pyproject.toml` are pinned to exact versions;
Dependabot proposes updates weekly. After any dependency change, regenerate
[`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt) with
`uv run scripts/third_party_licenses.py` (needs
`cargo install --locked cargo-about --features cli` once).

## License

scratchcad is licensed under the [Apache License 2.0](LICENSE). Its dependencies, are listed
with their licenses in [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).

## Shoutout 

A huge shoutout to Matt Keeter the developer of [Fidget](https://github.com/mkeeter/fidget), scratchcad uses fidget as the core modeling kernal and this project would not be possible without fidget.
