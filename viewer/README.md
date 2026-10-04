# scratchcad editor

A browser editor for the Rhai scripts the scratchcad agent saves. It previews
the part as you type, turns the script's parameters into sliders, and exports
STL files. Built with TypeScript, [React](https://react.dev),
[Vite](https://vite.dev), [Tailwind](https://tailwindcss.com),
[CodeMirror](https://codemirror.net) and [three.js](https://threejs.org).

## Running it

With the Docker dev stack in the repo root, `docker compose up --build` starts
the editor at <http://localhost:5173> next to the scratchcad service and the
MCP server.

To run it directly, start those two first (see the [root README](../README.md)),
then:

```sh
npm ci
npm run dev                      # http://localhost:5173
```

## How it fits together

The editor has no backend of its own. The Vite dev server proxies two paths,
so the browser only talks to one origin:

| path                | goes to                                                                | for                                                                           |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/api/scratchcad/*` | the scratchcad service                                                 | validating and meshing scripts                                                |
| `/api/files/*`      | the MCP server's [file API](../mcp/README.md#scripts-and-the-file-api) | listing, reading and writing `.rhai` and `.stl` files in the output directory |

| env                    | default                 |                                                                            |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `SCRATCHCAD_URL`       | `http://127.0.0.1:8080` | the scratchcad service                                                     |
| `SCRATCHCAD_MCP_URL`   | `http://127.0.0.1:8000` | the MCP server, running over HTTP                                          |
| `SCRATCHCAD_API_TOKEN` | unset                   | added to scratchcad requests by the proxy, so it never reaches the browser |

These can also go in a `.env` file in this directory.

## Script conventions

The editor reads two conventions from a script, both written by the MCP
server's `save_script` tool and its guide:

```rhai
// region: center=[0, 0, 0] half_size=20
let width = 30.0; // [10, 36] Width (mm)
let holes = 4; // [1, 12] Number of holes
```

- **The region line** (the first line) is the cube that is meshed. The
  **Region & export** tab edits it, and can grow it or fit it to the mesh.
- **Parameters** are top-level `let` lines that assign a number, with an
  optional `[min, max]` range and label. They become sliders; moving one
  rewrites only the number, keeping integers as integers and floats as floats.

## Editing alongside the agent

Saving sends the version of the file the editor last loaded. If the agent
changed the file in the meantime, the save is refused and the editor asks
which version to keep. When the agent changes a file you haven't edited, the
editor just reloads it.

## Development

```sh
npm run format:check && npm run lint && npm run typecheck
npm run coverage                 # CI requires 100% coverage of src/lib, src/api and the Rhai tokenizer
npm run build
```

The same checks run in the dev container: `docker compose run --rm viewer npm test`.

| directory         |                                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| `src/lib/`        | Pure logic: the region line, parameters, error positions, the new-script template |
| `src/api/`        | Clients for the scratchcad service and the file API                               |
| `src/editor/`     | CodeMirror setup and the Rhai language (highlighting and completions)             |
| `src/viewport/`   | The three.js view and view cube                                                   |
| `src/components/` | The panels: files, parameters, region and export, output                          |
