# scratchcad

A lean HTTP service built on [Fidget](https://github.com/mkeeter/fidget)
**v0.5.1** and [axum](https://github.com/tokio-rs/axum). You send it
[Rhai](https://rhai.rs) scripts that describe implicit surfaces, and it can:

- **validate scripts**: `POST /v1/scripts/validate`
- **evaluate** the field at points, with gradients or over interval boxes: `POST /v1/eval`
- **rasterize** a 2D slice or a shaded 3D view to PNG: `POST /v1/raster/2d`, `POST /v1/raster/3d`
- **export** a binary STL mesh: `POST /v1/export/stl`

To drive it from an AI assistant, see the MCP server in [`../mcp`](../mcp).
Run the commands below from this `server/` directory. For a containerised
dev setup with live reload, use `docker compose watch` from the repo root
(see [`Dockerfile.dev`](Dockerfile.dev)).

```sh
cargo run --release                       # listens on 0.0.0.0:8080
docker build -t scratchcad . && docker run -p 8080:8080 -e SCRATCHCAD_API_TOKEN=... scratchcad
```

## Scripts

Scripts use Fidget's Rhai bindings (`x`, `y`, `z`, arithmetic, `min`/`max`,
`sqrt`, `sin`, `remap`, shape constructors such as `sphere(#{ radius: 1.0 })`,
`circle`, `union`, `difference` and so on; see the
[`fidget::rhai` docs](https://docs.rs/fidget/0.5.1/fidget/rhai/index.html)).
A script produces its shape in one of two ways:

- it calls `draw(shape)` exactly once, or
- its last expression is a shape, e.g. `sqrt(x*x + y*y + z*z) - 1`.

Negative values are inside the shape.

The API is **stateless**. Every request carries its script in a `"script"`
field, and nothing is stored between requests. Any instance can serve any
request, so replicas behind a load balancer need no coordination. Running a
script takes about a millisecond, which is small next to rendering or meshing.

Every compute endpoint also takes `"evaluator": "jit"` (the default; native
code) or `"vm"` (the interpreter).

## API

Errors always have the shape `{"error": {"code": "...", "message": "..."}}`:

| status | code | meaning |
|---|---|---|
| 400 | `bad_request`, `invalid_json` | malformed or contradictory input (unknown fields are rejected) |
| 401 | `unauthorized` | missing or wrong bearer token |
| 404 | `not_found` | unknown route |
| 413 | `payload_too_large` | body over `SCRATCHCAD_MAX_BODY_BYTES` |
| 422 | `script_error` | Rhai parse or runtime error (message includes line and column) |
| 422 | `limit_exceeded` | a configured limit was hit (size, operations, nodes, triangles and so on) |
| 422 | `unprocessable` | the shape cannot be evaluated (for example, free variables) |
| 503 | `overloaded` | no job slot became free within the queue timeout (`Retry-After: 1`) |
| 504 | `timeout` | the job ran past `SCRATCHCAD_JOB_TIMEOUT_MS` and was cancelled |

Every response carries an `x-request-id` header. If the request sent one, it
is propagated.

### `POST /v1/scripts/validate`

Runs a script in the sandbox and reports on the shape it produces, without
evaluating or rendering it. Use it to check a script and see its `print`
output.

```sh
curl -s localhost:8080/v1/scripts/validate -H 'content-type: application/json' \
  -d '{"script": "print(\"hi\"); draw(sphere(#{ radius: 0.5 }))"}'
```
```json
{"nodes":9,"output":["hi"],"compile_ms":0.8}
```
An invalid script returns the same `422` error that the compute endpoints
would return.

### `POST /v1/eval`

| field | default | |
|---|---|---|
| `mode` | `"value"` | `value`, `gradient` or `interval` |
| `points` | | `[[x, y, z], …]` for `value` and `gradient` |
| `intervals` | | `[[[xmin, xmax], [ymin, ymax], [zmin, zmax]], …]` for `interval` |

```sh
curl -s localhost:8080/v1/eval -H 'content-type: application/json' \
  -d '{"script": "x*x + y*y + z*z", "mode": "gradient", "points": [[1,2,3]]}'
```
```json
{"values":[14.0],"gradients":[[2.0,4.0,6.0]],"compute_ms":0.02}
```
The `interval` mode returns `"intervals": [[lower, upper], …]`, which are
conservative bounds of the field over each box. Non-finite results
serialize as `null`.

### `POST /v1/raster/2d` → `image/png`

Renders the `z = 0` slice.

| field | default | |
|---|---|---|
| `width`, `height` | required | pixels, `1..=SCRATCHCAD_MAX_IMAGE_SIZE_2D` |
| `mode` | `"mono"` | `mono` (white on black), `sdf` (distance-field colouring), `debug` (interval levels) |
| `center` | `[0, 0]` | model-space point at the image center |
| `half_size` | `1.0` | the view spans `center ± half_size` |

### `POST /v1/raster/3d` → `image/png` (RGBA, transparent background)

| field | default | |
|---|---|---|
| `width`, `height` | required | pixels, `1..=SCRATCHCAD_MAX_IMAGE_SIZE_3D` |
| `depth` | `max(width, height)` | voxels along the view axis |
| `mode` | `"shaded"` | `shaded`, `normals` or `heightmap` |
| `ssao` | `false` | ambient occlusion (only with `shaded`) |
| `denoise` | `true` | normal denoising (ignored for `heightmap`) |
| `center` | `[0, 0, 0]` | model-space point at the view center |
| `half_size` | `1.0` | the view spans `center ± half_size` |
| `rotation` | `{}` | `{"yaw": deg, "pitch": deg, "roll": deg}` (yaw about Y, pitch about X, roll about Z) |
| `perspective` | `0` | `0` is orthographic, up to `1` |

```sh
curl -s localhost:8080/v1/raster/3d -H 'content-type: application/json' -o shape.png \
  -d '{"script": "draw(sphere(#{ radius: 0.8 }))", "width": 512, "height": 512, "ssao": true,
       "rotation": {"yaw": 30, "pitch": -20}, "perspective": 0.3}'
```

### `POST /v1/export/stl` → `model/stl` (binary)

| field | default | |
|---|---|---|
| `depth` | `6` | octree depth, `1..=SCRATCHCAD_MAX_MESH_DEPTH`; resolution is `2^depth` cells per axis |
| `center` | `[0, 0, 0]` | center of the meshed cube |
| `half_size` | `1.0` | the meshed region is `center ± half_size` |

Vertices are in model coordinates. The response includes
`Content-Disposition: attachment` and an `x-triangle-count` header.

Error responses report what the server observed and leave the remedy to the
client:

| code | status | message contents |
|---|---|---|
| `non_finite_field` | `422` | a point on the octree grid where the field is NaN or infinite, and the mesher's panic message |
| `empty_mesh` | `422` | the region, the depth, and how many samples on the region's boundary are inside the shape |
| `mesh_failed` | `500` | the mesher's panic message, when the field is finite at every grid corner |

PNG and STL responses also carry an `x-compute-ms` header, and one `x-warning`
header per observation that didn't stop the request: for a render, a point in
the view where the field is NaN or infinite (renders skip such samples); for an
STL, the sides of the region the shape reaches and how many boundary samples
are inside it.

### Health

- `GET /healthz`: liveness probe, always `200 ok`.
- `GET /readyz`: readiness probe. Returns `200` with job stats, or `503` once shutdown has begun.

Neither probe requires authentication.

## Production behaviour

- **Sandboxed scripts.** Rhai runs with an operation budget, limits on call depth, expression depth, string, array and map size, and a node cap on the resulting math graph. It has no `import` (no filesystem) and no `eval`, and `print`/`debug` are captured into the response rather than written to stdout.
- **Bounded compute.** At most `SCRATCHCAD_MAX_CONCURRENT_JOBS` jobs run at once, on blocking threads with a dedicated Rayon pool for Fidget. Other requests queue for up to `SCRATCHCAD_QUEUE_TIMEOUT_MS` and then get a `503`.
- **Real cancellation.** Every job gets a Fidget `CancelToken`. The token trips on timeout **and** when the client disconnects. Fidget's renderers, the mesher and the Rhai sandbox all check it, so abandoned work stops instead of burning CPU. A job keeps its slot until it has actually stopped, so timed-out work never oversubscribes the machine.
- **Bounded inputs and outputs.** Limits cover body size, script size, point count, image dimensions, mesh depth and triangle count. Every float input is checked to be finite.
- **Fault isolation.** A panic in a job or handler becomes a `500` with a generic message, and the details go to the logs under the request ID (the `x-request-id` response header).
- **Timeouts say what ran out.** A `504` names the stage that was running (the script, evaluation, rendering or meshing) and the budget it exceeded.
- **Graceful shutdown.** On `SIGTERM` or `SIGINT`, readiness flips to `503`, queued jobs are rejected, in-flight requests finish, and blocking work gets 5 s to wind down.
- **Observability.** Structured logs (`SCRATCHCAD_LOG_FORMAT=json`, filtered with `RUST_LOG`) carry a per-request span with the request ID, and the log level is set by response status.
- **Authentication.** An optional bearer token (`SCRATCHCAD_API_TOKEN`, at least 16 chars) is compared in constant time, and the `Authorization` header is redacted from logs.
- The container image is distroless and runs as a non-root user.

Put the service behind a reverse proxy or load balancer for TLS, connection
limits and slow-header protection. It doesn't terminate TLS itself.

## Configuration

Every option is a flag or an environment variable (`scratchcad --help`):

| env | default | |
|---|---|---|
| `SCRATCHCAD_LISTEN` | `0.0.0.0:8080` | bind address |
| `SCRATCHCAD_API_TOKEN` | unset | require `Authorization: Bearer <token>` on `/v1/*` |
| `SCRATCHCAD_LOG_FORMAT` | `text` | `text` or `json` |
| `SCRATCHCAD_RENDER_THREADS` | #CPUs | Rayon threads for Fidget |
| `SCRATCHCAD_MAX_CONCURRENT_JOBS` | `4` | parallel jobs |
| `SCRATCHCAD_QUEUE_TIMEOUT_MS` | `5000` | max wait for a job slot |
| `SCRATCHCAD_JOB_TIMEOUT_MS` | `30000` | per-job budget |
| `SCRATCHCAD_MAX_BODY_BYTES` | `4194304` | request body cap |
| `SCRATCHCAD_MAX_SCRIPT_BYTES` | `65536` | script size cap |
| `SCRATCHCAD_MAX_SCRIPT_OPERATIONS` | `1000000` | Rhai operation budget |
| `SCRATCHCAD_MAX_NODES` | `100000` | math-graph node cap |
| `SCRATCHCAD_MAX_EVAL_POINTS` | `100000` | points or boxes per eval |
| `SCRATCHCAD_MAX_IMAGE_SIZE_2D` | `4096` | max 2D width and height |
| `SCRATCHCAD_MAX_IMAGE_SIZE_3D` | `2048` | max 3D width, height and depth |
| `SCRATCHCAD_MAX_MESH_DEPTH` | `10` | max octree depth |
| `SCRATCHCAD_MAX_MESH_TRIANGLES` | `4000000` | max triangles per STL |

## Development

```sh
cargo fmt --check && cargo clippy --all-targets && cargo test
cargo llvm-cov --summary-only        # coverage (CI requires >= 90% of lines)
```

The tests cover three layers:
- unit tests next to the code (sandbox, job runner, ops, errors, transforms)
- HTTP tests through the full router (`tests/api.rs`)
- end-to-end tests of the real binary, covering startup, TCP serving and
  SIGTERM/SIGINT shutdown (`tests/binary.rs`)
