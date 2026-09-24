# madcad

A lean HTTP service built on [Fidget](https://github.com/mkeeter/fidget)
**v0.5.0** and [axum](https://github.com/tokio-rs/axum). You send it
[Rhai](https://rhai.rs) scripts that describe implicit surfaces, and it can:

- **run and cache scripts**: `POST /v1/scripts`
- **evaluate** the field at points, with gradients or over interval boxes: `POST /v1/eval`
- **rasterize** a 2D slice or a shaded 3D view to PNG: `POST /v1/raster/2d`, `POST /v1/raster/3d`
- **export** a binary STL mesh: `POST /v1/export/stl`

```sh
cargo run --release                       # listens on 0.0.0.0:8080
docker build -t madcad . && docker run -p 8080:8080 -e MADCAD_API_TOKEN=... madcad
```

## Scripts

Scripts use Fidget's Rhai bindings (`x`, `y`, `z`, arithmetic, `min`/`max`,
`sqrt`, `sin`, `remap`, shape constructors such as `sphere(#{ radius: 1.0 })`,
`circle`, `union`, `difference` and so on; see the
[`fidget::rhai` docs](https://docs.rs/fidget/0.5.0/fidget/rhai/index.html)).
A script produces its shape in one of two ways:

- it calls `draw(shape)` exactly once, or
- its last expression is a shape, e.g. `sqrt(x*x + y*y + z*z) - 1`.

Negative values are inside the shape. Compiled scripts are content-addressed:
`script_id` is the SHA-256 of the source. Every endpoint below takes **either**
`"script": "<source>"` **or** `"script_id": "<id>"`. Inline scripts are cached
as well, so sending the same source again skips the Rhai step. The cache is an
in-memory LRU, so a `script_id` can expire. On a `404`, send the script again.

Every compute endpoint also takes `"evaluator": "jit"` (the default; native
code) or `"vm"` (the interpreter).

## API

Errors always have the shape `{"error": {"code": "...", "message": "..."}}`:

| status | code | meaning |
|---|---|---|
| 400 | `bad_request`, `invalid_json` | malformed or contradictory input (unknown fields are rejected) |
| 401 | `unauthorized` | missing or wrong bearer token |
| 404 | `not_found` | unknown route or `script_id` |
| 413 | `payload_too_large` | body over `MADCAD_MAX_BODY_BYTES` |
| 422 | `script_error` | Rhai parse or runtime error (message includes line and column) |
| 422 | `limit_exceeded` | a configured limit was hit (size, operations, nodes, triangles and so on) |
| 422 | `unprocessable` | the shape cannot be evaluated (for example, free variables) |
| 503 | `overloaded` | no job slot became free within the queue timeout (`Retry-After: 1`) |
| 504 | `timeout` | the job ran past `MADCAD_JOB_TIMEOUT_MS` and was cancelled |

Every response carries an `x-request-id` header. If the request sent one, it
is propagated.

### `POST /v1/scripts`

```sh
curl -s localhost:8080/v1/scripts -H 'content-type: application/json' \
  -d '{"script": "draw(sphere(#{ radius: 0.5 }))"}'
```
```json
{"script_id":"3f1c…","nodes":9,"output":[],"compile_ms":0.8}
```
Returns `201` with a `Location` header, or `200` if the script was already
cached. `output` holds anything the script `print`ed. `GET /v1/scripts/{id}`
returns the metadata; `DELETE /v1/scripts/{id}` evicts it.

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
{"script_id":"…","values":[14.0],"gradients":[[2.0,4.0,6.0]],"compute_ms":0.02}
```
The `interval` mode returns `"intervals": [[lower, upper], …]`, which are
conservative bounds of the field over each box. Non-finite results
serialize as `null`.

### `POST /v1/raster/2d` → `image/png`

Renders the `z = 0` slice.

| field | default | |
|---|---|---|
| `width`, `height` | required | pixels, `1..=MADCAD_MAX_IMAGE_SIZE_2D` |
| `mode` | `"mono"` | `mono` (white on black), `sdf` (distance-field colouring), `debug` (interval levels) |
| `center` | `[0, 0]` | model-space point at the image center |
| `half_size` | `1.0` | the view spans `center ± half_size` |

### `POST /v1/raster/3d` → `image/png` (RGBA, transparent background)

| field | default | |
|---|---|---|
| `width`, `height` | required | pixels, `1..=MADCAD_MAX_IMAGE_SIZE_3D` |
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
  -d '{"script_id": "…", "width": 512, "height": 512, "ssao": true,
       "rotation": {"yaw": 30, "pitch": -20}, "perspective": 0.3}'
```

### `POST /v1/export/stl` → `model/stl` (binary)

| field | default | |
|---|---|---|
| `depth` | `6` | octree depth, `1..=MADCAD_MAX_MESH_DEPTH`; resolution is `2^depth` cells per axis |
| `center` | `[0, 0, 0]` | center of the meshed cube |
| `half_size` | `1.0` | the meshed region is `center ± half_size` |

Vertices are in model coordinates. The response includes
`Content-Disposition: attachment` and an `x-triangle-count` header.

PNG and STL responses also carry `x-script-id` and `x-compute-ms`.

### Health

- `GET /healthz`: liveness probe, always `200 ok`.
- `GET /readyz`: readiness probe. Returns `200` with job and cache stats, or `503` once shutdown has begun.

Neither probe requires authentication.

## Production behaviour

- **Sandboxed scripts.** Rhai runs with an operation budget, limits on call depth, expression depth, string, array and map size, and a node cap on the resulting math graph. It has no `import` (no filesystem) and no `eval`, and `print`/`debug` are captured into the response rather than written to stdout.
- **Bounded compute.** At most `MADCAD_MAX_CONCURRENT_JOBS` jobs run at once, on blocking threads with a dedicated Rayon pool for Fidget. Other requests queue for up to `MADCAD_QUEUE_TIMEOUT_MS` and then get a `503`.
- **Real cancellation.** Every job gets a Fidget `CancelToken`. The token trips on timeout **and** when the client disconnects. Fidget's renderers, the mesher and the Rhai sandbox all check it, so abandoned work stops instead of burning CPU. A job keeps its slot until it has actually stopped, so timed-out work never oversubscribes the machine.
- **Bounded inputs and outputs.** Limits cover body size, script size, point count, image dimensions, mesh depth and triangle count. Every float input is checked to be finite.
- **Fault isolation.** A panic in a job or handler becomes a `500` with a generic message, and the details go to the logs.
- **Graceful shutdown.** On `SIGTERM` or `SIGINT`, readiness flips to `503`, queued jobs are rejected, in-flight requests finish, and blocking work gets 5 s to wind down.
- **Observability.** Structured logs (`MADCAD_LOG_FORMAT=json`, filtered with `RUST_LOG`) carry a per-request span with the request ID, and the log level is set by response status.
- **Authentication.** An optional bearer token (`MADCAD_API_TOKEN`, at least 16 chars) is compared in constant time, and the `Authorization` header is redacted from logs.
- The container image is distroless and runs as a non-root user.

Put the service behind a reverse proxy or load balancer for TLS, connection
limits and slow-header protection. It doesn't terminate TLS itself.

## Configuration

Every option is a flag or an environment variable (`madcad --help`):

| env | default | |
|---|---|---|
| `MADCAD_LISTEN` | `0.0.0.0:8080` | bind address |
| `MADCAD_API_TOKEN` | unset | require `Authorization: Bearer <token>` on `/v1/*` |
| `MADCAD_LOG_FORMAT` | `text` | `text` or `json` |
| `MADCAD_RENDER_THREADS` | #CPUs | Rayon threads for Fidget |
| `MADCAD_MAX_CONCURRENT_JOBS` | `4` | parallel jobs |
| `MADCAD_QUEUE_TIMEOUT_MS` | `5000` | max wait for a job slot |
| `MADCAD_JOB_TIMEOUT_MS` | `30000` | per-job budget |
| `MADCAD_MAX_BODY_BYTES` | `4194304` | request body cap |
| `MADCAD_MAX_SCRIPT_BYTES` | `65536` | script size cap |
| `MADCAD_MAX_SCRIPT_OPERATIONS` | `1000000` | Rhai operation budget |
| `MADCAD_MAX_NODES` | `100000` | math-graph node cap |
| `MADCAD_SCRIPT_CACHE_SIZE` | `256` | cached scripts |
| `MADCAD_MAX_EVAL_POINTS` | `100000` | points or boxes per eval |
| `MADCAD_MAX_IMAGE_SIZE_2D` | `4096` | max 2D width and height |
| `MADCAD_MAX_IMAGE_SIZE_3D` | `2048` | max 3D width, height and depth |
| `MADCAD_MAX_MESH_DEPTH` | `8` | max octree depth |
| `MADCAD_MAX_MESH_TRIANGLES` | `4000000` | max triangles per STL |

## Development

```sh
cargo fmt --check && cargo clippy --all-targets && cargo test
```
