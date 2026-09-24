//! HTTP handlers and request / response types for `/v1`
//!
//! The API is stateless: every request carries its Rhai script, which is
//! executed in the sandbox and then evaluated, rendered or meshed.

use std::time::Instant;

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use fidget::render::{ImageSize, VoxelSize};
use nalgebra::{Matrix3, Matrix4, Rotation3, Scale2, Scale3, Translation2, Translation3, Vector3};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    error::{ApiError, ApiJson},
    jobs::JobCtx,
    ops::{self, Evaluator, Mode2d, Mode3d},
    script::{self, Compiled},
};

const X_COMPUTE_MS: HeaderName = HeaderName::from_static("x-compute-ms");
const X_TRIANGLES: HeaderName = HeaderName::from_static("x-triangle-count");

////////////////////////////////////////////////////////////////////////////////
// Validation helpers

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

/// Runs the script in the sandbox; called inside a job
fn compile(state: &AppState, src: &str, ctx: &JobCtx) -> Result<Compiled, ApiError> {
    script::compile(src, &state.limits, &ctx.cancel)
}

pub(crate) fn finite<const N: usize>(name: &str, v: &[f32; N]) -> Result<(), ApiError> {
    if v.iter().all(|x| x.is_finite()) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!("`{name}` must be finite")))
    }
}

pub(crate) fn positive(name: &str, v: f32) -> Result<(), ApiError> {
    if v.is_finite() && v > 0.0 {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "`{name}` must be a positive number"
        )))
    }
}

pub(crate) fn dim(name: &str, v: u32, max: u32) -> Result<u32, ApiError> {
    if (1..=max).contains(&v) {
        Ok(v)
    } else {
        Err(ApiError::LimitExceeded(format!(
            "`{name}` must be in 1..={max}"
        )))
    }
}

fn ms_since(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1e3
}

fn ms_header(ms: f64) -> HeaderValue {
    HeaderValue::from_str(&format!("{ms:.3}")).expect("number is a valid header")
}

////////////////////////////////////////////////////////////////////////////////
// Transforms

/// Maps the renderer's `[-1, 1]` square onto `center ± half_size`
pub(crate) fn transform_2d(center: [f32; 2], half_size: f32) -> Matrix3<f32> {
    Translation2::new(center[0], center[1]).to_homogeneous()
        * Scale2::new(half_size, half_size).to_homogeneous()
}

/// Maps the renderer's / mesher's `[-1, 1]` cube onto `center ± half_size`
pub(crate) fn transform_3d(center: [f32; 3], half_size: f32) -> Matrix4<f32> {
    Translation3::new(center[0], center[1], center[2]).to_homogeneous()
        * Scale3::new(half_size, half_size, half_size).to_homogeneous()
}

/// Camera transform for 3D rendering: rotation (degrees) and perspective,
/// composed in the same order as Fidget's CLI demo
pub(crate) fn camera_3d(
    center: [f32; 3],
    half_size: f32,
    rotation: &Rotation,
    perspective: f32,
) -> Matrix4<f32> {
    let rot =
        |axis: Vector3<f32>, deg: f32| Rotation3::new(axis * deg.to_radians()).to_homogeneous();
    let mut camera = Matrix4::identity();
    camera[(3, 2)] = perspective;
    Translation3::new(center[0], center[1], center[2]).to_homogeneous()
        * rot(Vector3::y(), rotation.yaw)
        * rot(Vector3::z(), rotation.roll)
        * rot(Vector3::x(), rotation.pitch)
        * Scale3::new(half_size, half_size, half_size).to_homogeneous()
        * camera
}

////////////////////////////////////////////////////////////////////////////////
// Script validation

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidateRequest {
    script: String,
}

#[derive(Serialize)]
pub struct ValidateResponse {
    /// Unique nodes in the compiled math graph
    nodes: usize,
    /// `print` / `debug` output from the script
    output: Vec<String>,
    compile_ms: f64,
}

/// `POST /v1/scripts/validate` — run a script and report on the shape it
/// produces, without evaluating it.  Nothing is stored.
pub async fn validate_script(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<ValidateRequest>,
) -> Result<Json<ValidateResponse>, ApiError> {
    check_script_len(&state, &req.script)?;
    let st = state.clone();
    let c = state
        .jobs
        .run(move |ctx| compile(&st, &req.script, ctx))
        .await?;
    Ok(Json(ValidateResponse {
        nodes: c.nodes,
        output: c.output,
        compile_ms: c.compile_ms,
    }))
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
    script: String,
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

impl EvalRequest {
    /// Checks the samples against the mode and limits; returns their count
    fn validate(&self, max: usize) -> Result<usize, ApiError> {
        let n = match self.mode {
            EvalMode::Value | EvalMode::Gradient => {
                if !self.intervals.is_empty() {
                    return Err(ApiError::BadRequest(
                        "`intervals` is only valid with `mode: \"interval\"`".into(),
                    ));
                }
                for p in &self.points {
                    finite("points", p)?;
                }
                self.points.len()
            }
            EvalMode::Interval => {
                if !self.points.is_empty() {
                    return Err(ApiError::BadRequest(
                        "`points` is not valid with `mode: \"interval\"`".into(),
                    ));
                }
                for [lo, hi] in self.intervals.iter().flatten() {
                    if !(lo.is_finite() && hi.is_finite() && lo <= hi) {
                        return Err(ApiError::BadRequest(
                            "each interval must be finite with lower <= upper".into(),
                        ));
                    }
                }
                self.intervals.len()
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
        Ok(n)
    }
}

#[derive(Serialize, Default)]
pub struct EvalResponse {
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
    req.validate(state.config.max_eval_points)?;
    check_script_len(&state, &req.script)?;

    let st = state.clone();
    let out = state
        .jobs
        .run(move |ctx| {
            let c = compile(&st, &req.script, ctx)?;
            let start = Instant::now();
            let mut out = EvalResponse::default();
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
            out.compute_ms = ms_since(start);
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
    script: String,
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
    check_script_len(&state, &req.script)?;
    let world_to_model = transform_2d(req.center, req.half_size);

    let st = state.clone();
    let (png, ms) = state
        .jobs
        .run(move |ctx| {
            let c = compile(&st, &req.script, ctx)?;
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
            let png = ops::encode_png(&rgba, w, h)?;
            Ok((png, ms_since(start)))
        })
        .await?;
    Ok(png_response(png, ms))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Rotation {
    /// Degrees about the Y axis
    #[serde(default)]
    pub yaw: f32,
    /// Degrees about the X axis
    #[serde(default)]
    pub pitch: f32,
    /// Degrees about the Z axis
    #[serde(default)]
    pub roll: f32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Raster3dRequest {
    script: String,
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
    check_script_len(&state, &req.script)?;
    let world_to_model = camera_3d(req.center, req.half_size, r, req.perspective);

    let st = state.clone();
    let (png, ms) = state
        .jobs
        .run(move |ctx| {
            let c = compile(&st, &req.script, ctx)?;
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
            let png = ops::encode_png(&rgba, w, h)?;
            Ok((png, ms_since(start)))
        })
        .await?;
    Ok(png_response(png, ms))
}

fn png_response(png: Vec<u8>, ms: f64) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(X_COMPUTE_MS, ms_header(ms));
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
    script: String,
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
    check_script_len(&state, &req.script)?;
    let world_to_model = transform_3d(req.center, req.half_size);

    let st = state.clone();
    let max_triangles = state.config.max_mesh_triangles;
    let (stl, ms) = state
        .jobs
        .run(move |ctx| {
            let c = compile(&st, &req.script, ctx)?;
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
            Ok((stl, ms_since(start)))
        })
        .await?;

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("model/stl"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"shape.stl\""),
    );
    headers.insert(X_COMPUTE_MS, ms_header(ms));
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
}

/// `GET /readyz` — readiness; 503 once shutdown has begun
pub async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    let draining = state.is_draining();
    let body = Readiness {
        status: if draining { "draining" } else { "ready" },
        active_jobs: state.jobs.active(),
        job_capacity: state.jobs.capacity(),
    };
    let status = if draining {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (status, Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::Point3;

    fn close(a: Point3<f32>, b: [f32; 3]) -> bool {
        (a - Point3::from(b)).norm() < 1e-5
    }

    #[test]
    fn validators() {
        assert!(finite("p", &[0.0, 1.0]).is_ok());
        assert!(finite("p", &[f32::NAN]).is_err());
        assert!(finite("p", &[f32::INFINITY, 0.0]).is_err());
        assert!(positive("s", 0.5).is_ok());
        for bad in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            assert!(positive("s", bad).is_err(), "{bad}");
        }
        assert_eq!(dim("w", 1, 8).unwrap(), 1);
        assert_eq!(dim("w", 8, 8).unwrap(), 8);
        assert!(matches!(dim("w", 0, 8), Err(ApiError::LimitExceeded(_))));
        assert!(matches!(dim("w", 9, 8), Err(ApiError::LimitExceeded(_))));
    }

    #[test]
    fn region_transforms_map_unit_cube_to_region() {
        let m = transform_3d([1.0, 2.0, 3.0], 4.0);
        assert!(close(
            m.transform_point(&Point3::new(-1.0, -1.0, -1.0)),
            [-3.0, -2.0, -1.0]
        ));
        assert!(close(
            m.transform_point(&Point3::new(1.0, 1.0, 1.0)),
            [5.0, 6.0, 7.0]
        ));

        let m = transform_2d([1.0, -1.0], 2.0);
        let p = m.transform_point(&nalgebra::Point2::new(1.0, 1.0));
        assert!((p - nalgebra::Point2::new(3.0, 1.0)).norm() < 1e-6);
    }

    #[test]
    fn camera_without_rotation_matches_region_transform() {
        let r = Rotation::default();
        assert_eq!(
            camera_3d([1.0, 2.0, 3.0], 2.0, &r, 0.0),
            transform_3d([1.0, 2.0, 3.0], 2.0)
        );
    }

    #[test]
    fn camera_rotation_and_perspective() {
        // 90° of yaw (about Y) takes +X to -Z
        let r = Rotation {
            yaw: 90.0,
            ..Default::default()
        };
        let m = camera_3d([0.0; 3], 1.0, &r, 0.0);
        assert!(close(
            m.transform_point(&Point3::new(1.0, 0.0, 0.0)),
            [0.0, 0.0, -1.0]
        ));

        // Perspective shrinks points further from the viewer (larger z)
        let m = camera_3d([0.0; 3], 1.0, &Rotation::default(), 0.5);
        let near = m.transform_point(&Point3::new(1.0, 0.0, -1.0));
        let far = m.transform_point(&Point3::new(1.0, 0.0, 1.0));
        assert!(near.x > far.x);
    }

    fn eval_req(mode: EvalMode, points: usize, intervals: usize) -> EvalRequest {
        EvalRequest {
            script: "x".into(),
            evaluator: Evaluator::Vm,
            mode,
            points: vec![[0.0; 3]; points],
            intervals: vec![[[0.0, 1.0]; 3]; intervals],
        }
    }

    #[test]
    fn eval_request_validation() {
        assert_eq!(eval_req(EvalMode::Value, 3, 0).validate(10).unwrap(), 3);
        assert_eq!(
            eval_req(EvalMode::Gradient, 10, 0).validate(10).unwrap(),
            10
        );
        assert_eq!(eval_req(EvalMode::Interval, 0, 2).validate(10).unwrap(), 2);

        let bad = |r: EvalRequest, max| r.validate(max).unwrap_err();
        assert!(matches!(
            bad(eval_req(EvalMode::Value, 0, 0), 10),
            ApiError::BadRequest(_)
        ));
        assert!(matches!(
            bad(eval_req(EvalMode::Value, 1, 1), 10),
            ApiError::BadRequest(_)
        ));
        assert!(matches!(
            bad(eval_req(EvalMode::Interval, 1, 1), 10),
            ApiError::BadRequest(_)
        ));
        assert!(matches!(
            bad(eval_req(EvalMode::Interval, 0, 0), 10),
            ApiError::BadRequest(_)
        ));
        assert!(matches!(
            bad(eval_req(EvalMode::Value, 11, 0), 10),
            ApiError::LimitExceeded(_)
        ));
        assert!(matches!(
            bad(eval_req(EvalMode::Interval, 0, 11), 10),
            ApiError::LimitExceeded(_)
        ));

        let mut r = eval_req(EvalMode::Value, 1, 0);
        r.points[0][1] = f32::NAN;
        assert!(matches!(bad(r, 10), ApiError::BadRequest(_)));
        let mut r = eval_req(EvalMode::Interval, 0, 1);
        r.intervals[0][2] = [2.0, 1.0];
        assert!(matches!(bad(r, 10), ApiError::BadRequest(_)));
        let mut r = eval_req(EvalMode::Interval, 0, 1);
        r.intervals[0][0] = [f32::NEG_INFINITY, 1.0];
        assert!(matches!(bad(r, 10), ApiError::BadRequest(_)));
    }
}
