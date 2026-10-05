# scratchcad

> [!WARNING]
> scratchcad is under active development. APIs, tools and script syntax may
> change without notice, and things may break between commits.

scratchcad is a rust based solid modelling API, plus a local MCP server and
editor so AI assistants (and you) can use it.

## Quick start (requires docker)

Clone the repo and check out the
[latest release](https://github.com/Zesuperaker/scratchcad/releases/latest).
`main` moves fast and may be broken between releases.

<!-- x-release-please-start-version -->
```sh
git clone --branch v0.2.0 https://github.com/Zesuperaker/scratchcad.git
cd scratchcad
```
<!-- x-release-please-end -->

Then start the server, and the MCP server with the editor:

```sh
docker compose up --build        # or `docker compose watch` to reload on edits
```

Open the editor at <http://localhost:8000>.

The mcp is already configured localy through .mcp.json

For clients that don't support .mcp.json, point them at `http://localhost:8000/mcp` using the
streamable HTTP transport.

## Examples

| prompt (using opus 5.5 medium through cc) | output |
|---|---|
| Create an M10 hex bolt with 26 mm thread length, a course pitch of 1.5 mm and head height 6.4 mm. Also create a matching hex nut with 8.4 mm height. Both of these should be in the same file displayed beside each other. | <img src="docs/images/m10_bolt_and_nut.gif" alt="Rotating M10 hex bolt and matching hex nut" width="320"> |
| Create a 3DBenchy. | <img src="docs/images/benchy.gif" alt="Rotating 3DBenchy tugboat" width="320"> |
|Create a mid-stage compressor blisk with these dimensions: an outer tip diameter of 440 mm, a hub platform diameter of 241.2 mm, and a radial blade span of 99.4 mm across its 29 twisted aerodynamic airfoils. Mechanically, the component is defined by an 80.0 mm shaft interface bore diameter, an axial hub length of 77.5 mm, and an airfoil rim width of 45.0 mm, with rear mounting flange diameters measuring 184 mm at the inner shoulder and 202 mm at the outer rim. Blade count of 29 twisted aerodynamic airfoils. | <img src="docs/images/blisk.gif" alt="Rotating 29-blade compressor blisk" width="320"> |

## Docker info

`compose.yaml` runs two dev images:

| service | port | image |
|---|---|---|
| `server` | `127.0.0.1:8080` | [`server/Dockerfile.dev`](server/Dockerfile.dev): `cargo run` with fast incremental rebuilds |
| `mcp` | `127.0.0.1:8000` | [`mcp/Dockerfile.dev`](mcp/Dockerfile.dev): the MCP server over streamable HTTP at `/mcp`, and the editor at `/` |

Run the MCP server's and editor's checks inside its container with
`docker compose run --rm mcp npm test`.

With `docker compose watch`, edits under `server/src` restart the server (the
Rust side recompiles in a few seconds), edits under `mcp/src` restart the MCP
server, edits under `mcp/web` hot-reload in the browser, and changes to
`Cargo.toml`, `Cargo.lock`, `package.json` or `package-lock.json` rebuild that
image. To require an API token, put
`SCRATCHCAD_API_TOKEN=<16+ characters>` in a `.env` file next to `compose.yaml`.

## Scripts, the editor and STL files

The agent delivers a part as a Rhai script, saved to `./output` with the
`save_script` tool, which also gives the agent a link to it in the editor at
<http://localhost:8000>:

- the part fills most of the window, with sliders for its dimensions beside
  it; moving one re-meshes the part a moment later
- **Files** slides out a list of scripts and exported meshes, and tucks itself
  away once you pick one
- **Script** slides out the Rhai source, for editing by hand, with errors
  marked on their line; you never need it to change the part's dimensions
- **Export STL** meshes the script and writes an `.stl` next to it, at the
  detail chosen under **Region & detail**

The sliders come from the script's top-level `let` lines, which the agent is
told to write with a plain-language label, a unit and a range, for example
`let thread_length = 26.0; // [10, 60] Thread length (mm)`. `save_script` tells
the agent which sliders it made and which are unclear, so it can fix them.

The agent only exports an STL itself when you ask it to. If you edit a script
and then ask the agent for changes, it reads your version first; if it
changes a script while you have unsaved edits, the editor asks which version
to keep.

## Architecture

| directory | what it is | where it runs |
|---|---|---|
| [`server/`](server) | The scratchcad HTTP service (Rust 1.98, [Fidget](https://github.com/mkeeter/fidget) + axum). Validates, evaluates, renders and meshes [Rhai](https://rhai.rs) scripts that describe implicit surfaces. It is stateless and never touches your files. | anywhere: locally in Docker, or on another machine |
| [`mcp/`](mcp) | The MCP server and editor (TypeScript, [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [React](https://react.dev), [Vite](https://vite.dev), [CodeMirror](https://codemirror.net), [three.js](https://threejs.org)). Gives a model tools to write a script, look at renders, measure the part and save it, and gives you an editor with a live 3D preview, parameter sliders and STL export. | always on your machine, next to the files it reads and writes |

The two talk over HTTP: the MCP server reaches scratchcad at `SCRATCHCAD_URL`,
so it works with a local build, the dev container, or a deployed instance
(see [`mcp/README.md`](mcp/README.md) for running it on its own). The editor
only talks to the MCP server, which forwards its requests to scratchcad and
adds the API token, so the token never reaches the browser.

## License

scratchcad is licensed under the [Apache License 2.0](LICENSE). Its dependencies, are listed
with their licenses in [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).

## Shoutout 

A huge shoutout to Matt Keeter the developer of [Fidget](https://github.com/mkeeter/fidget), scratchcad uses fidget as the core implicit kernal and this project would not be possible without fidget.
