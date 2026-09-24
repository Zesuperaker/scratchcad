//! HTTP handlers and request / response types for `/v1`

use std::{sync::Arc, time::Instant};

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use fidget::render::{ImageSize, VoxelSize};
use nalgebra::{Matrix4, Rotation3, Scale2, Scale3, Translation2, Translation3, Vector3};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    error::{ApiError, ApiJson},
    jobs::JobCtx,
    ops::{self, Evaluator, Mode2d, Mode3d},
    script::{self, Compiled},
};

const X_SCRIPT_ID: HeaderName = HeaderName::from_static("x-script-id");
const X_COMPUTE_MS: HeaderName = HeaderName::from_static("x-compute-ms");
const X_TRIANGLES: HeaderName = HeaderName::from_static("x-triangle-count");

////////////////////////////////////////////////////////////////////////////////
// Script resolution

/// Where a request's shape comes from; exactly one field must be set
enum Source {
    Inline(String),
    Cached(Arc<Compiled>),
}

fn source(
    state: &AppState,
    script: Option<String>,
    script_id: Option<String>,
) -> Result<Source, ApiError> {
    match (script, script_id) {
        (Some(s), None) => {
            check_script_len(state, &s)?;
            Ok(Source::Inline(s))
        }
        (None, Some(id)) => {
            if !script::is_valid_id(&id) {
                return Err(ApiError::BadRequest(
                    "`script_id` must be 64 lowercase hex characters".into(),
                ));
            }
            state
                .scripts
                .get(&id)
                .map(Source::Cached)
                .ok_or(ApiError::NotFound)
        }
        _ => Err(ApiError::BadRequest(
            "exactly one of `script` or `script_id` is required".into(),
        )),
    }
}

fn check_script_len(state: &AppState, s: &str) -> Result<(), ApiError> {
    if s.len() > state.config.max_script_bytes {
        return Err(ApiError::LimitExceeded(format!(
            "script is {} bytes; the limit is {}",
            s.len(),
            state.config.max_script_bytes
        )));
    }
    Ok(())
}

/// Resolves a source to a compiled script; runs inside a job
fn resolve(state: &AppState, src: Source, ctx: &JobCtx) -> Result<(Arc<Compiled>, bool), ApiError> {
    match src {
        Source::Cached(c) => Ok((c, true)),
        Source::Inline(s) => {
            if let Some(c) = state.scripts.get(&script::script_id(&s)) {
                return Ok((c, true));
            }
            let c = Arc::new(script::compile(&s, &state.limits, &ctx.cancel)?);
            state.scripts.insert(c.clone());
            Ok((c, false))
        }
    }
}

////////////////////////////////////////////////////////////////////////////////
// Validation helpers

fn finite<const N: usize>(name: &str, v: &[f32; N]) -> Result<(), ApiError> {
    if v.iter().all(|x| x.is_finite()) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!("`{name}` must be finite")))
    }
}

fn positive(name: &str, v: f32) -> Result<(), ApiError> {
    if v.is_finite() && v > 0.0 {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "`{name}` must be a positive number"
        )))
    }
}

fn dim(name: &str, v: u32, max: u32) -> Result<u32, ApiError> {
    if (1..=max).contains(&v) {
        Ok(v)
    } else {
        Err(ApiError::LimitExceeded(format!(
            "`{name}` must be in 1..={max}"
        )))
    }
}

fn ms(start: Instant) -> HeaderValue {
    HeaderValue::from_str(&format!("{:.3}", start.elapsed().as_secs_f64() * 1e3))
        .expect("number is a valid header")
}

fn id_header(c: &Compiled) -> HeaderValue {
    HeaderValue::from_str(&c.id).expect("hex is a valid header")
}

////////////////////////////////////////////////////////////////////////////////
// Scripts

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateScript {
    script: String,
}

#[derive(Serialize)]
pub struct ScriptInfo {
    script_id: String,
    /// Unique nodes in the compiled math graph
    nodes: usize,
    /// `print` / `debug` output from the script (only on creation)
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compile_ms: Option<f64>,
}

/// `POST /v1/scripts` — run a script, cache the resulting shape
pub async fn create_script(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<CreateScript>,
) -> Result<Response, ApiError> {
    check_script_len(&state, &req.script)?;
    let st = state.clone();
    let (c, cached) = state
        .jobs
        .run(move |ctx| resolve(&st, Source::Inline(req.script), ctx))
        .await?;
    let status = if cached {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    let body = ScriptInfo {
        script_id: c.id.clone(),
        nodes: c.nodes,
        output: Some(c.output.clone()),
        compile_ms: Some(c.compile_ms),
    };
    let location =
        HeaderValue::from_str(&format!("/v1/scripts/{}", c.id)).expect("hex is a valid header");
    Ok((status, [(header::LOCATION, location)], Json(body)).into_response())
}

/// `GET /v1/scripts/{id}`
pub async fn get_script(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ScriptInfo>, ApiError> {
    let c = state.scripts.get(&id).ok_or(ApiError::NotFound)?;
    Ok(Json(ScriptInfo {
        script_id: c.id.clone(),
        nodes: c.nodes,
        output: None,
        compile_ms: None,
    }))
}

/// `DELETE /v1/scripts/{id}`
pub async fn delete_script(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state.scripts.remove(&id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

////////////////////////////////////////////////////////////////////////////////
// Evaluation

#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EvalMode {
    /// Distance-field value at each point
    #[default]
    Value,
    /// Value plus the gradient `[dx, dy, dz]` at each point
    Gradient,
    /// Conservative `[lower, upper]` bounds over each box
    Interval,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvalRequest {
    script: Option<String>,
    script_id: Option<String>,
    #[serde(default)]
    evaluator: Evaluator,
    #[serde(default)]
    mode: EvalMode,
    /// `[x, y, z]` sample positions (value / gradient modes)
    #[serde(default)]
    points: Vec<[f32; 3]>,
    /// `[[xmin, xmax], [ymin, ymax], [zmin, zmax]]` boxes (interval mode)
    #[serde(default)]
    intervals: Vec<[[f32; 2]; 3]>,
}

#[derive(Serialize)]
pub struct EvalResponse {
    script_id: String,
    /// Values per point; non-finite results are reported as `null`
    #[serde(skip_serializing_if = "Option::is_none")]
    values: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gradients: Option<Vec<[f32; 3]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    intervals: Option<Vec<[f32; 2]>>,
    compute_ms: f64,
}

/// `POST /v1/eval` — evaluate the shape at points or over boxes
pub async fn eval(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<EvalRequest>,
) -> Result<Json<EvalResponse>, ApiError> {
    let max = state.config.max_eval_points;
    let n = match req.mode {
        EvalMode::Value | EvalMode::Gradient => {
            if !req.intervals.is_empty() {
                return Err(ApiError::BadRequest(
                    "`intervals` is only valid with `mode: \"interval\"`".into(),
                ));
            }
            for p in &req.points {
                finite("points", p)?;
            }
            req.points.len()
        }
        EvalMode::Interval => {
            if !req.points.is_empty() {
                return Err(ApiError::BadRequest(
                    "`points` is not valid with `mode: \"interval\"`".into(),
                ));
            }
            for b in &req.intervals {
                for [lo, hi] in b {
                    if !(lo.is_finite() && hi.is_finite() && lo <= hi) {
                        return Err(ApiError::BadRequest(
                            "each interval must be finite with lower <= upper".into(),
                        ));
                    }
                }
            }
            req.intervals.len()
        }
    };
    if n == 0 {
        return Err(ApiError::BadRequest("nothing to evaluate".into()));
    }
    if n > max {
        return Err(ApiError::LimitExceeded(format!(
            "{n} samples requested; the limit is {max}"
        )));
    }

    let src = source(&state, req.script, req.script_id)?;
    let st = state.clone();
    let out = state
        .jobs
        .run(move |ctx| {
            let (c, _) = resolve(&st, src, ctx)?;
            let start = Instant::now();
            let mut out = EvalResponse {
                script_id: c.id.clone(),
                values: None,
                gradients: None,
                intervals: None,
                compute_ms: 0.0,
            };
            match req.mode {
                EvalMode::Value => {
                    out.values = Some(ops::dispatch(
                        req.evaluator,
                        &c,
                        ops::PointEval(req.points),
                    )?);
                }
                EvalMode::Gradient => {
                    let g = ops::dispatch(req.evaluator, &c, ops::GradEval(req.points))?;
                    out.values = Some(g.iter().map(|g| g.v).collect());
                    out.gradients = Some(g.iter().map(|g| [g.dx, g.dy, g.dz]).collect());
                }
                EvalMode::Interval => {
                    out.intervals = Some(ops::dispatch(
                        req.evaluator,
                        &c,
                        ops::IntervalEval(req.intervals),
                    )?);
                }
            }
            out.compute_ms = start.elapsed().as_secs_f64() * 1e3;
            Ok(out)
        })
        .await?;
    Ok(Json(out))
}

////////////////////////////////////////////////////////////////////////////////
// Rasterization

fn default_half_size() -> f32 {
    1.0
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Raster2dRequest {
    script: Option<String>,
    script_id: Option<String>,
    #[serde(default)]
    evaluator: Evaluator,
    width: u32,
    height: u32,
    #[serde(default)]
    mode: Mode2d,
    /// Model-space point at the center of the image
    #[serde(default)]
    center: [f32; 2],
    /// Half of the visible model-space extent (the view spans
    /// `center ± half_size` along the image's longer axis)
    #[serde(default = "default_half_size")]
    half_size: f32,
}

/// `POST /v1/raster/2d` — render a 2D slice (z = 0) to PNG
pub async fn raster_2d(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<Raster2dRequest>,
) -> Result<Response, ApiError> {
    let max = state.config.max_image_size_2d;
    let (w, h) = (
        dim("width", req.width, max)?,
        dim("height", req.height, max)?,
    );
    finite("center", &req.center)?;
    positive("half_size", req.half_size)?;
    let world_to_model = Translation2::new(req.center[0], req.center[1]).to_homogeneous()
        * Scale2::new(req.half_size, req.half_size).to_homogeneous();

    let src = source(&state, req.script, req.script_id)?;
    let st = state.clone();
    let (c, png, start) = state
        .jobs
        .run(move |ctx| {
            let (c, _) = resolve(&st, src, ctx)?;
            let start = Instant::now();
            let rgba = ops::dispatch(
                req.evaluator,
                &c,
                ops::Raster2d {
                    size: ImageSize::new(w, h),
                    mode: req.mode,
                    world_to_model,
                    pool: &ctx.pool,
                    cancel: ctx.cancel.clone(),
                },
            )?;
            Ok((c, ops::encode_png(&rgba, w, h)?, start))
        })
        .await?;
    Ok(png_response(&c, png, start))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Rotation {
    /// Degrees about the Y axis
    #[serde(default)]
    yaw: f32,
    /// Degrees about the X axis
    #[serde(default)]
    pitch: f32,
    /// Degrees about the Z axis
    #[serde(default)]
    roll: f32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Raster3dRequest {
    script: Option<String>,
    script_id: Option<String>,
    #[serde(default)]
    evaluator: Evaluator,
    width: u32,
    height: u32,
    /// Voxels along the view axis; defaults to `max(width, height)`
    depth: Option<u32>,
    #[serde(default)]
    mode: Mode3d,
    /// Smooth noisy normals (ignored for `heightmap`)
    #[serde(default = "default_true")]
    denoise: bool,
    /// Screen-space ambient occlusion (only for `shaded`)
    #[serde(default)]
    ssao: bool,
    #[serde(default)]
    center: [f32; 3],
    #[serde(default = "default_half_size")]
    half_size: f32,
    #[serde(default)]
    rotation: Rotation,
    /// Perspective strength; 0 is orthographic
    #[serde(default)]
    perspective: f32,
}

/// `POST /v1/raster/3d` — render a 3D view to PNG
pub async fn raster_3d(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<Raster3dRequest>,
) -> Result<Response, ApiError> {
    let max = state.config.max_image_size_3d;
    let (w, h) = (
        dim("width", req.width, max)?,
        dim("height", req.height, max)?,
    );
    let d = dim("depth", req.depth.unwrap_or(w.max(h)), max)?;
    finite("center", &req.center)?;
    positive("half_size", req.half_size)?;
    let r = &req.rotation;
    finite("rotation", &[r.yaw, r.pitch, r.roll])?;
    finite("perspective", &[req.perspective])?;
    if !(0.0..=1.0).contains(&req.perspective) {
        return Err(ApiError::BadRequest(
            "`perspective` must be in 0..=1".into(),
        ));
    }
    if req.ssao && req.mode != Mode3d::Shaded {
        return Err(ApiError::BadRequest(
            "`ssao` requires `mode: \"shaded\"`".into(),
        ));
    }

    let rot =
        |axis: Vector3<f32>, deg: f32| Rotation3::new(axis * deg.to_radians()).to_homogeneous();
    let mut camera = Matrix4::identity();
    camera[(3, 2)] = req.perspective;
    let world_to_model = Translation3::new(req.center[0], req.center[1], req.center[2])
        .to_homogeneous()
        * rot(Vector3::y(), r.yaw)
        * rot(Vector3::z(), r.roll)
        * rot(Vector3::x(), r.pitch)
        * Scale3::new(req.half_size, req.half_size, req.half_size).to_homogeneous()
        * camera;

    let src = source(&state, req.script, req.script_id)?;
    let st = state.clone();
    let (c, png, start) = state
        .jobs
        .run(move |ctx| {
            let (c, _) = resolve(&st, src, ctx)?;
            let start = Instant::now();
            let rgba = ops::dispatch(
                req.evaluator,
                &c,
                ops::Raster3d {
                    size: VoxelSize::new(w, h, d),
                    mode: req.mode,
                    denoise: req.denoise,
                    ssao: req.ssao,
                    world_to_model,
                    pool: &ctx.pool,
                    cancel: ctx.cancel.clone(),
                },
            )?;
            Ok((c, ops::encode_png(&rgba, w, h)?, start))
        })
        .await?;
    Ok(png_response(&c, png, start))
}

fn png_response(c: &Compiled, png: Vec<u8>, start: Instant) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(X_SCRIPT_ID, id_header(c));
    headers.insert(X_COMPUTE_MS, ms(start));
    (headers, png).into_response()
}

////////////////////////////////////////////////////////////////////////////////
// STL export

fn default_mesh_depth() -> u8 {
    6
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StlRequest {
    script: Option<String>,
    script_id: Option<String>,
    #[serde(default)]
    evaluator: Evaluator,
    /// Octree depth; the region is subdivided into up to `(2^depth)^3` cells
    #[serde(default = "default_mesh_depth")]
    depth: u8,
    /// Center of the meshed region
    #[serde(default)]
    center: [f32; 3],
    /// The meshed region is the cube `center ± half_size`
    #[serde(default = "default_half_size")]
    half_size: f32,
}

/// `POST /v1/export/stl` — mesh the shape and return a binary STL
pub async fn export_stl(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<StlRequest>,
) -> Result<Response, ApiError> {
    let max_depth = state.config.max_mesh_depth;
    if !(1..=max_depth).contains(&req.depth) {
        return Err(ApiError::LimitExceeded(format!(
            "`depth` must be in 1..={max_depth}"
        )));
    }
    finite("center", &req.center)?;
    positive("half_size", req.half_size)?;
    let world_to_model = Translation3::new(req.center[0], req.center[1], req.center[2])
        .to_homogeneous()
        * Scale3::new(req.half_size, req.half_size, req.half_size).to_homogeneous();

    let src = source(&state, req.script, req.script_id)?;
    let st = state.clone();
    let max_triangles = state.config.max_mesh_triangles;
    let (c, stl, start) = state
        .jobs
        .run(move |ctx| {
            let (c, _) = resolve(&st, src, ctx)?;
            let start = Instant::now();
            let stl = ops::dispatch(
                req.evaluator,
                &c,
                ops::MeshJob {
                    depth: req.depth,
                    world_to_model,
                    max_triangles,
                    pool: &ctx.pool,
                    cancel: ctx.cancel.clone(),
                },
            )?;
            Ok((c, stl, start))
        })
        .await?;

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("model/stl"));
    let disposition = format!("attachment; filename=\"{}.stl\"", &c.id[..16]);
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).expect("hex is a valid header"),
    );
    headers.insert(X_SCRIPT_ID, id_header(&c));
    headers.insert(X_COMPUTE_MS, ms(start));
    headers.insert(X_TRIANGLES, HeaderValue::from(stl.triangles));
    tracing::debug!(
        triangles = stl.triangles,
        vertices = stl.vertices,
        "mesh built"
    );
    Ok((headers, stl.bytes).into_response())
}

////////////////////////////////////////////////////////////////////////////////
// Health

/// `GET /healthz` — liveness
pub async fn healthz() -> &'static str {
    "ok"
}

#[derive(Serialize)]
pub struct Readiness {
    status: &'static str,
    active_jobs: usize,
    job_capacity: usize,
    cached_scripts: usize,
}

/// `GET /readyz` — readiness; 503 once shutdown has begun
pub async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    let draining = state.is_draining();
    let body = Readiness {
        status: if draining { "draining" } else { "ready" },
        active_jobs: state.jobs.active(),
        job_capacity: state.jobs.capacity(),
        cached_scripts: state.scripts.len(),
    };
    let status = if draining {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (status, Json(body))
}
