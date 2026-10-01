//! Fidget operations: point / gradient / interval evaluation, 2D and 3D
//! rasterization, and meshing to STL.  Everything here is synchronous and
//! meant to run inside a [`Jobs`](crate::jobs::Jobs) slot.

use std::panic::{AssertUnwindSafe, catch_unwind};

use fidget::{
    eval::{Function, MathFunction},
    render::{CancelToken, ImageSize, RenderHints, ThreadPool, VoxelSize},
    shape::{BoundShape, Shape, ShapeBulkEval},
    types::{Grad, Interval},
};
use nalgebra::{Matrix3, Matrix4, Point2, Point3};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::{
    error::ApiError,
    jobs::{Stage, panic_message},
    script::Compiled,
};

/// Bulk evaluators work in chunks of this many points
const EVAL_CHUNK: usize = 16 * 1024;

/// Samples per axis when a render checks its view for NaN
const RENDER_PROBE_2D: usize = 129;
const RENDER_PROBE_3D: usize = 65;

/// Most samples per axis on each face when a mesh checks for clipping
const MAX_FACE_PROBE: usize = 257;

#[derive(Deserialize, Serialize, Debug, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Evaluator {
    /// JIT-compiled native code (fastest for repeated evaluation)
    #[default]
    Jit,
    /// Bytecode interpreter (no compile step)
    Vm,
}

/// Work that is generic over Fidget's evaluator backends
pub trait ShapeJob {
    type Output;
    fn run<F>(self, shape: Shape<F>) -> Result<Self::Output, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone;
}

/// Builds a shape with the requested backend and runs `job` on it
pub fn dispatch<J: ShapeJob>(
    evaluator: Evaluator,
    script: &Compiled,
    job: J,
) -> Result<J::Output, ApiError> {
    // Only the graph the script produced can make this fail
    let bad = |e| ApiError::Unprocessable(format!("could not build the shape: {e}"));
    match evaluator {
        Evaluator::Jit => {
            job.run(fidget::jit::JitShape::new(&script.ctx, script.root).map_err(bad)?)
        }
        Evaluator::Vm => job.run(fidget::vm::VmShape::new(&script.ctx, script.root).map_err(bad)?),
    }
}

fn bind<F: Function>(shape: Shape<F>) -> Result<BoundShape<'static, F, f32>, ApiError> {
    BoundShape::try_from(shape)
        .map_err(|e| ApiError::Unprocessable(format!("shape has unbound variables: {e}")))
}

fn eval_err(e: impl std::fmt::Display) -> ApiError {
    ApiError::Unprocessable(format!("evaluation failed: {e}"))
}

////////////////////////////////////////////////////////////////////////////////
// Probes: sampling the field on a grid to explain failures and spot mistakes

/// Coordinate `i` of `n` evenly spaced samples across `[-1, 1]` (0 when `n == 1`)
fn grid_coord(i: usize, n: usize) -> f32 {
    if n <= 1 {
        0.0
    } else {
        -1.0 + 2.0 * i as f32 / (n - 1) as f32
    }
}

/// Formats a model-space number compactly: at most 4 decimals, no trailing zeros
fn num(v: f32) -> String {
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.into() }
}

fn point(p: Point3<f32>) -> String {
    format!("({}, {}, {})", num(p.x), num(p.y), num(p.z))
}

/// The region `world_to_model` maps the `[-1, 1]` cube onto, for messages.
/// ASCII only, because messages are also sent as header values.
fn region(world_to_model: &Matrix4<f32>) -> String {
    let c = world_to_model.transform_point(&Point3::origin());
    let h = world_to_model
        .transform_point(&Point3::new(1.0, 0.0, 0.0))
        .x
        - c.x;
    format!("center {} +/- {}", point(c), num(h))
}

/// Lifts a 2D view transform to 3D, leaving z unchanged
fn embed_2d(m: &Matrix3<f32>) -> Matrix4<f32> {
    let mut out = Matrix4::identity();
    out.fixed_view_mut::<2, 2>(0, 0)
        .copy_from(&m.fixed_view::<2, 2>(0, 0));
    out[(0, 3)] = m[(0, 2)];
    out[(1, 3)] = m[(1, 2)];
    out
}

/// Maps the `[-1, 1]` probe cube onto the box between two world-space corners
fn probe_extent(a: Point3<f32>, b: Point3<f32>) -> Matrix4<f32> {
    let half = (b - a) / 2.0;
    Matrix4::new_translation(&(a + half).coords) * Matrix4::new_nonuniform_scaling(&half)
}

/// Maps the `[-1, 1]` probe square onto the world-space view a 2D render of
/// `size` covers.  Fidget scales the shorter axis to `[-1, 1]`, so the longer
/// one reaches past it.  z is left at 0.
fn view_2d(size: ImageSize) -> Matrix4<f32> {
    let (w, h) = (size.width() as i32, size.height() as i32);
    let a = size.transform_point(Point2::new(0, 0));
    let b = size.transform_point(Point2::new(w, h));
    let mut m = probe_extent(Point3::new(a.x, a.y, 0.0), Point3::new(b.x, b.y, 0.0));
    m[(2, 2)] = 1.0;
    m
}

/// Maps the `[-1, 1]` probe cube onto the world-space view a 3D render of
/// `size` covers, as [`view_2d`] does for 2D
fn view_3d(size: VoxelSize) -> Matrix4<f32> {
    let (w, h, d) = (
        size.width() as i32,
        size.height() as i32,
        size.depth() as i32,
    );
    let a = size.transform_point(Point3::new(0, 0, 0));
    let b = size.transform_point(Point3::new(w, h, d));
    probe_extent(a, b)
}

/// A sample where the field is NaN or infinite
struct NonFinite {
    /// Model-space position
    at: Point3<f32>,
    value: f32,
}

impl std::fmt::Display for NonFinite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = if self.value.is_nan() {
            "NaN"
        } else {
            "infinite"
        };
        write!(f, "the field is {what} at {}", point(self.at))
    }
}

/// Searches `layers` z-slices of an `n` x `n` grid over the `[-1, 1]` view
/// cube (mapped to model space by `world_to_model`, exactly as the mesher and
/// renderers map it) for a sample where the field is NaN or infinite.
///
/// Returns `Ok(None)` if there is none, or if `cancel` is tripped first.
fn find_non_finite<F>(
    shape: &Shape<F>,
    world_to_model: &Matrix4<f32>,
    n: usize,
    layers: usize,
    pool: &ThreadPool,
    cancel: &CancelToken,
) -> Result<Option<NonFinite>, ApiError>
where
    F: Function + MathFunction + RenderHints + Clone,
{
    let tape = shape.float_slice_tape(Default::default());
    let rows_per_chunk = (EVAL_CHUNK / n).max(1);
    let search_layer = |eval: &mut ShapeBulkEval<F::FloatSliceEval>,
                        k: usize|
     -> Option<Result<NonFinite, ApiError>> {
        if cancel.is_cancelled() {
            return None;
        }
        let z = grid_coord(k, layers);
        let (mut xs, mut ys, mut zs) = (vec![], vec![], vec![]);
        for first_row in (0..n).step_by(rows_per_chunk) {
            xs.clear();
            ys.clear();
            zs.clear();
            for j in first_row..(first_row + rows_per_chunk).min(n) {
                for i in 0..n {
                    xs.push(grid_coord(i, n));
                    ys.push(grid_coord(j, n));
                    zs.push(z);
                }
            }
            let out = match eval.eval_with_transform(&tape, &xs, &ys, &zs, world_to_model) {
                Ok(out) => out,
                Err(e) => return Some(Err(eval_err(e))),
            };
            if let Some(i) = out.iter().position(|v| !v.is_finite()) {
                let at = world_to_model.transform_point(&Point3::new(xs[i], ys[i], zs[i]));
                return Some(Ok(NonFinite { at, value: out[i] }));
            }
        }
        None
    };
    pool.run(|| {
        (0..layers)
            .into_par_iter()
            .map_init(Shape::<F>::new_float_slice_eval, search_layer)
            .find_map_any(|r| r)
    })
    .transpose()
}

/// What the field looks like on the six faces of the meshed region
struct Boundary {
    /// Faces with at least one sample inside the shape
    touched: Vec<&'static str>,
    /// Samples inside the shape, over all faces
    inside: usize,
    /// Samples taken, over all faces
    total: usize,
}

fn check_boundary<F>(
    shape: &Shape<F>,
    world_to_model: &Matrix4<f32>,
    n: usize,
    cancel: &CancelToken,
) -> Result<Boundary, ApiError>
where
    F: Function + MathFunction + RenderHints + Clone,
{
    const FACES: [(&str, usize, f32); 6] = [
        ("-x", 0, -1.0),
        ("+x", 0, 1.0),
        ("-y", 1, -1.0),
        ("+y", 1, 1.0),
        ("-z", 2, -1.0),
        ("+z", 2, 1.0),
    ];
    let tape = shape.float_slice_tape(Default::default());
    let mut eval = Shape::<F>::new_float_slice_eval();
    let mut out = Boundary {
        touched: vec![],
        inside: 0,
        total: 0,
    };
    let mut coords: [Vec<f32>; 3] = Default::default();
    for (name, axis, side) in FACES {
        let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
        coords.iter_mut().for_each(Vec::clear);
        for a in 0..n {
            for b in 0..n {
                coords[axis].push(side);
                coords[u].push(grid_coord(a, n));
                coords[v].push(grid_coord(b, n));
            }
        }
        let mut inside = 0;
        for c in 0..coords[0].len().div_ceil(EVAL_CHUNK) {
            if cancel.is_cancelled() {
                return Err(ApiError::cancelled());
            }
            let r = c * EVAL_CHUNK..((c + 1) * EVAL_CHUNK).min(coords[0].len());
            let vals = eval
                .eval_with_transform(
                    &tape,
                    &coords[0][r.clone()],
                    &coords[1][r.clone()],
                    &coords[2][r.clone()],
                    world_to_model,
                )
                .map_err(eval_err)?;
            inside += vals.iter().filter(|v| **v < 0.0).count();
        }
        if inside > 0 {
            out.touched.push(name);
        }
        out.inside += inside;
        out.total += n * n;
    }
    Ok(out)
}

/// A warning for renders whose view contains NaN or infinite values: the
/// renderers skip such samples without reporting them, while the mesher
/// panics on them.
fn render_nan_warning<F>(
    shape: &Shape<F>,
    world_to_model: &Matrix4<f32>,
    n: usize,
    layers: usize,
    pool: &ThreadPool,
    cancel: &CancelToken,
) -> Result<Vec<String>, ApiError>
where
    F: Function + MathFunction + RenderHints + Clone,
{
    Ok(
        find_non_finite(shape, world_to_model, n, layers, pool, cancel)?
            .map(|bad| format!("{bad}, inside this view"))
            .into_iter()
            .collect(),
    )
}

////////////////////////////////////////////////////////////////////////////////
// Evaluation

pub struct PointEval(pub Vec<[f32; 3]>);

impl ShapeJob for PointEval {
    type Output = Vec<f32>;
    fn run<F>(self, shape: Shape<F>) -> Result<Vec<f32>, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        let tape = shape.float_slice_tape(Default::default());
        let mut eval = Shape::<F>::new_float_slice_eval();
        let mut out = Vec::with_capacity(self.0.len());
        let (mut xs, mut ys, mut zs) = (vec![], vec![], vec![]);
        for chunk in self.0.chunks(EVAL_CHUNK) {
            xs.clear();
            ys.clear();
            zs.clear();
            for [x, y, z] in chunk {
                xs.push(*x);
                ys.push(*y);
                zs.push(*z);
            }
            out.extend_from_slice(eval.eval(&tape, &xs, &ys, &zs).map_err(eval_err)?);
        }
        Ok(out)
    }
}

pub struct GradEval(pub Vec<[f32; 3]>);

impl ShapeJob for GradEval {
    type Output = Vec<Grad>;
    fn run<F>(self, shape: Shape<F>) -> Result<Vec<Grad>, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        let tape = shape.grad_slice_tape(Default::default());
        let mut eval = Shape::<F>::new_grad_slice_eval();
        let mut out = Vec::with_capacity(self.0.len());
        let (mut xs, mut ys, mut zs) = (vec![], vec![], vec![]);
        for chunk in self.0.chunks(EVAL_CHUNK) {
            xs.clear();
            ys.clear();
            zs.clear();
            for [x, y, z] in chunk {
                xs.push(Grad::new(*x, 1.0, 0.0, 0.0));
                ys.push(Grad::new(*y, 0.0, 1.0, 0.0));
                zs.push(Grad::new(*z, 0.0, 0.0, 1.0));
            }
            out.extend_from_slice(eval.eval(&tape, &xs, &ys, &zs).map_err(eval_err)?);
        }
        Ok(out)
    }
}

/// Axis-aligned boxes, each given as `[[xmin, xmax], [ymin, ymax], [zmin, zmax]]`
pub struct IntervalEval(pub Vec<[[f32; 2]; 3]>);

impl ShapeJob for IntervalEval {
    type Output = Vec<[f32; 2]>;
    fn run<F>(self, shape: Shape<F>) -> Result<Vec<[f32; 2]>, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        let tape = shape.interval_tape(Default::default());
        let mut eval = Shape::<F>::new_interval_eval();
        self.0
            .iter()
            .map(|b| {
                let [x, y, z] = b.map(|[lo, hi]| Interval::new(lo, hi));
                let (i, _trace) = eval.eval(&tape, x, y, z).map_err(eval_err)?;
                Ok([i.lower(), i.upper()])
            })
            .collect()
    }
}

////////////////////////////////////////////////////////////////////////////////
// 2D rasterization

#[derive(Deserialize, Debug, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode2d {
    /// White-on-black silhouette
    #[default]
    Mono,
    /// Signed distance field visualization (pixel-perfect evaluation)
    Sdf,
    /// Colors pixels by the interval-arithmetic level that resolved them
    Debug,
}

pub struct Raster2d<'a> {
    pub size: ImageSize,
    pub mode: Mode2d,
    pub world_to_model: Matrix3<f32>,
    pub pool: &'a ThreadPool,
    pub cancel: CancelToken,
}

/// A rendered image and anything about it worth telling the caller
pub struct Rendered {
    /// RGBA8 pixels, row-major
    pub rgba: Vec<u8>,
    pub warnings: Vec<String>,
}

impl ShapeJob for Raster2d<'_> {
    type Output = Rendered;
    fn run<F>(self, shape: Shape<F>) -> Result<Rendered, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        use fidget::raster::{
            effects,
            pixel::{EvalConfig, RenderConfig, render},
        };
        let threads = Some(self.pool);
        let cfg = RenderConfig {
            pixel_perfect: self.mode == Mode2d::Sdf,
            world_to_model: self.world_to_model,
            ..RenderConfig::from_size(self.size)
        };
        let eval = EvalConfig {
            threads,
            cancel: self.cancel.clone(),
            ..Default::default()
        };
        let img = render(bind(shape.clone())?, &cfg, &eval).ok_or_else(ApiError::cancelled)?;
        let rgba = match self.mode {
            Mode2d::Mono => effects::to_rgba_bitmap(img, false, threads),
            Mode2d::Sdf => effects::to_rgba_distance(img, threads),
            Mode2d::Debug => effects::to_debug_bitmap(img, threads),
        };
        let warnings = render_nan_warning(
            &shape,
            &(embed_2d(&self.world_to_model) * view_2d(self.size)),
            RENDER_PROBE_2D,
            1,
            self.pool,
            &self.cancel,
        )?;
        Ok(Rendered {
            rgba: rgba.into_iter().flatten().collect(),
            warnings,
        })
    }
}

////////////////////////////////////////////////////////////////////////////////
// 3D rasterization

#[derive(Deserialize, Debug, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode3d {
    /// Grayscale depth map
    Heightmap,
    /// Surface normals mapped to RGB
    Normals,
    /// Lit, shaded surface
    #[default]
    Shaded,
}

pub struct Raster3d<'a> {
    pub size: VoxelSize,
    pub mode: Mode3d,
    pub denoise: bool,
    pub ssao: bool,
    pub world_to_model: Matrix4<f32>,
    pub pool: &'a ThreadPool,
    pub cancel: CancelToken,
}

impl ShapeJob for Raster3d<'_> {
    /// Background pixels are transparent
    type Output = Rendered;
    fn run<F>(self, shape: Shape<F>) -> Result<Rendered, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        use fidget::raster::{
            effects,
            voxel::{EvalConfig, RenderConfig, render},
        };
        let threads = Some(self.pool);
        let cfg = RenderConfig {
            world_to_model: self.world_to_model,
            ..RenderConfig::from_size(self.size)
        };
        let eval = EvalConfig {
            threads,
            cancel: self.cancel.clone(),
            ..Default::default()
        };
        let image = render(bind(shape.clone())?, &cfg, &eval).ok_or_else(ApiError::cancelled)?;
        if self.cancel.is_cancelled() {
            return Err(ApiError::cancelled());
        }

        let image = if self.denoise && self.mode != Mode3d::Heightmap {
            effects::denoise_normals(&image, threads)
        } else {
            image
        };
        let out = match self.mode {
            Mode3d::Heightmap => {
                let z_max = u64::from(image.iter().map(|p| p.depth).max().unwrap_or(1).max(1));
                image
                    .iter()
                    .flat_map(|p| {
                        if p.depth > 0 {
                            let z = (u64::from(p.depth) * 255 / z_max) as u8;
                            [z, z, z, 255]
                        } else {
                            [0; 4]
                        }
                    })
                    .collect()
            }
            Mode3d::Normals => image
                .iter()
                .flat_map(|p| {
                    if p.depth > 0 {
                        let [r, g, b] = p.to_color();
                        [r, g, b, 255]
                    } else {
                        [0; 4]
                    }
                })
                .collect(),
            Mode3d::Shaded => {
                let color = effects::apply_shading(&image, self.ssao, threads);
                image
                    .iter()
                    .zip(color.iter())
                    .flat_map(|(p, c)| {
                        if p.depth > 0 {
                            [c[0], c[1], c[2], 255]
                        } else {
                            [0; 4]
                        }
                    })
                    .collect()
            }
        };
        let warnings = render_nan_warning(
            &shape,
            &(self.world_to_model * view_3d(self.size)),
            RENDER_PROBE_3D,
            RENDER_PROBE_3D,
            self.pool,
            &self.cancel,
        )?;
        Ok(Rendered {
            rgba: out,
            warnings,
        })
    }
}

////////////////////////////////////////////////////////////////////////////////
// Meshing

pub struct MeshJob<'a> {
    pub depth: u8,
    pub world_to_model: Matrix4<f32>,
    pub max_triangles: usize,
    pub pool: &'a ThreadPool,
    pub cancel: CancelToken,
    /// Reports progress, so that a timeout can say which stage ran out
    pub set_stage: &'a dyn Fn(Stage),
}

pub struct StlOutput {
    pub bytes: Vec<u8>,
    pub triangles: usize,
    pub vertices: usize,
    pub warnings: Vec<String>,
}

impl ShapeJob for MeshJob<'_> {
    type Output = StlOutput;
    fn run<F>(self, shape: Shape<F>) -> Result<StlOutput, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        let settings = fidget::mesh::Settings {
            depth: self.depth,
            world_to_model: self.world_to_model,
            threads: Some(self.pool),
            cancel: self.cancel.clone(),
        };
        let bound = bind(shape.clone())?;
        // Fidget's mesher asserts that every sample is either inside or
        // outside, so a NaN in the field makes it panic.  Catch that here,
        // where the shape is still at hand to find out why.
        let built = catch_unwind(AssertUnwindSafe(|| {
            fidget::mesh::Octree::build(&bound, &settings).map(|octree| octree.walk_dual())
        }));
        let mesh = match built {
            Ok(Some(mesh)) => mesh,
            Ok(None) => return Err(ApiError::cancelled()),
            Err(panic) => return Err(self.diagnose(&shape, &panic_message(panic))),
        };
        if self.cancel.is_cancelled() {
            return Err(ApiError::cancelled());
        }

        let triangles = mesh.triangles.len();
        if triangles > self.max_triangles {
            return Err(ApiError::LimitExceeded(format!(
                "mesh has {triangles} triangles; the limit is {} \
                 (reduce `depth`)",
                self.max_triangles
            )));
        }

        (self.set_stage)(Stage::Checking);
        let face_samples = ((1usize << self.depth) + 1).min(MAX_FACE_PROBE);
        let boundary = check_boundary(&shape, &self.world_to_model, face_samples, &self.cancel)?;
        let region = region(&self.world_to_model);
        if triangles == 0 {
            return Err(ApiError::EmptyMesh(format!(
                "meshing the region {region} at depth {} produced no triangles; \
                 {} of {} samples on the region's boundary are inside the shape",
                self.depth, boundary.inside, boundary.total
            )));
        }
        let mut warnings = vec![];
        if !boundary.touched.is_empty() {
            warnings.push(format!(
                "the shape reaches the boundary of the meshed region {region} on its {} \
                 side(s); {} of {} samples on the region's boundary are inside the shape",
                boundary.touched.join(", "),
                boundary.inside,
                boundary.total
            ));
        }

        // Binary STL: 80-byte header + u32 count + 50 bytes per triangle
        let mut bytes = Vec::with_capacity(84 + 50 * triangles);
        mesh.write_stl(&mut bytes)
            .map_err(|e| ApiError::Internal(format!("writing STL: {e}")))?;
        Ok(StlOutput {
            bytes,
            triangles,
            vertices: mesh.vertices.len(),
            warnings,
        })
    }
}

impl MeshJob<'_> {
    /// Reports a mesher panic together with what the octree's grid holds:
    /// either a sample where the field is NaN or infinite, or that none was found.
    fn diagnose<F>(&self, shape: &Shape<F>, panic: &str) -> ApiError
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        (self.set_stage)(Stage::Checking);
        let n = (1usize << self.depth) + 1;
        let found = find_non_finite(shape, &self.world_to_model, n, n, self.pool, &self.cancel);
        if self.cancel.is_cancelled() {
            return ApiError::cancelled();
        }
        match found {
            Ok(Some(bad)) => ApiError::NonFiniteField(format!(
                "meshing failed: {bad}; the mesher panicked with \"{panic}\""
            )),
            Ok(None) => ApiError::MeshFailed(format!(
                "meshing failed: the mesher panicked with \"{panic}\"; the field is finite \
                 at all {n}x{n}x{n} corners of the depth-{} octree grid",
                self.depth
            )),
            Err(e) => e,
        }
    }
}

////////////////////////////////////////////////////////////////////////////////
// Encoding

/// Encodes RGBA8 pixels as a PNG
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, ApiError> {
    use image::{ImageEncoder, codecs::png::PngEncoder};
    // The encoder panics on a size mismatch; report it as an error instead.
    let expected = width as usize * height as usize * 4;
    if rgba.len() != expected {
        return Err(ApiError::Internal(format!(
            "encoding PNG: expected {expected} bytes for {width}x{height}, got {}",
            rgba.len()
        )));
    }
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| ApiError::Internal(format!("encoding PNG: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::{ScriptLimits, compile};

    fn shape(src: &str) -> Compiled {
        let limits = ScriptLimits {
            max_operations: 100_000,
            max_nodes: 10_000,
            max_string_size: 4096,
        };
        compile(src, &limits, &CancelToken::new()).unwrap()
    }

    fn cancelled() -> CancelToken {
        let c = CancelToken::new();
        c.cancel();
        c
    }

    const SPHERE: &str = "sqrt(x*x + y*y + z*z) - 0.5";

    #[test]
    fn jit_and_vm_agree() {
        let c = shape(SPHERE);
        let pts: Vec<[f32; 3]> = (0..100)
            .map(|i| [i as f32 / 50.0 - 1.0, 0.25, -0.1])
            .collect();
        let jit = dispatch(Evaluator::Jit, &c, PointEval(pts.clone())).unwrap();
        let vm = dispatch(Evaluator::Vm, &c, PointEval(pts.clone())).unwrap();
        for (a, b) in jit.iter().zip(&vm) {
            assert!((a - b).abs() < 1e-5);
        }
        let g = dispatch(Evaluator::Vm, &c, GradEval(pts)).unwrap();
        for (g, v) in g.iter().zip(&vm) {
            assert!((g.v - v).abs() < 1e-5);
            // Gradient of a distance field has unit length
            let n = (g.dx * g.dx + g.dy * g.dy + g.dz * g.dz).sqrt();
            assert!((n - 1.0).abs() < 1e-3, "{n}");
        }
    }

    #[test]
    fn interval_bounds_contain_samples() {
        let c = shape(SPHERE);
        let boxes = vec![[[-1.0, 1.0]; 3], [[0.9, 1.0], [0.0, 0.1], [0.0, 0.1]]];
        let out = dispatch(Evaluator::Jit, &c, IntervalEval(boxes)).unwrap();
        // Box around the origin straddles the surface; the far box is outside
        assert!(out[0][0] < 0.0 && out[0][1] > 0.0);
        assert!(out[1][0] > 0.0);
    }

    #[test]
    fn cancelled_jobs_return_timeout() {
        let c = shape(SPHERE);
        let pool = ThreadPool::Global;
        let r = dispatch(
            Evaluator::Vm,
            &c,
            Raster2d {
                size: ImageSize::new(64, 64),
                mode: Mode2d::Mono,
                world_to_model: Matrix3::identity(),
                pool: &pool,
                cancel: cancelled(),
            },
        );
        assert!(matches!(r, Err(ApiError::Timeout(_))));
        let r = dispatch(
            Evaluator::Vm,
            &c,
            Raster3d {
                size: VoxelSize::new(64, 64, 64),
                mode: Mode3d::Shaded,
                denoise: true,
                ssao: false,
                world_to_model: Matrix4::identity(),
                pool: &pool,
                cancel: cancelled(),
            },
        );
        assert!(matches!(r, Err(ApiError::Timeout(_))));
        let r = dispatch(
            Evaluator::Vm,
            &c,
            MeshJob {
                depth: 5,
                world_to_model: Matrix4::identity(),
                max_triangles: usize::MAX,
                pool: &pool,
                cancel: cancelled(),
                set_stage: &|_| {},
            },
        );
        assert!(matches!(r, Err(ApiError::Timeout(_))));
    }

    #[test]
    fn heightmap_is_brighter_nearer_the_viewer() {
        let c = shape(SPHERE);
        let pool = ThreadPool::Global;
        let rgba = dispatch(
            Evaluator::Jit,
            &c,
            Raster3d {
                size: VoxelSize::new(32, 32, 32),
                mode: Mode3d::Heightmap,
                denoise: false,
                ssao: false,
                world_to_model: Matrix4::identity(),
                pool: &pool,
                cancel: CancelToken::new(),
            },
        )
        .unwrap()
        .rgba;
        let px = |x: usize, y: usize| &rgba[(y * 32 + x) * 4..][..4];
        // The sphere's front (center) is the highest point: full brightness
        assert_eq!(px(16, 16), [255, 255, 255, 255]);
        assert!(px(16, 16)[0] > px(16, 7)[0]);
        assert_eq!(px(0, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn mesh_counts_match_stl() {
        let c = shape(SPHERE);
        let out = dispatch(
            Evaluator::Jit,
            &c,
            MeshJob {
                depth: 4,
                world_to_model: Matrix4::identity(),
                max_triangles: usize::MAX,
                pool: &ThreadPool::Global,
                cancel: CancelToken::new(),
                set_stage: &|_| {},
            },
        )
        .unwrap();
        assert!(out.triangles > 0 && out.vertices > 0);
        assert_eq!(out.bytes.len(), 84 + 50 * out.triangles);
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
    }

    /// The sphere, except NaN (0/0) on the plane x = 0.25, which the depth-4
    /// grid samples exactly
    const NAN_SPHERE: &str = "(sqrt(x*x + y*y + z*z) - 0.5) * ((x - 0.25) / (x - 0.25))";

    fn mesh(src: &str, depth: u8, world_to_model: Matrix4<f32>) -> Result<StlOutput, ApiError> {
        let stages = std::sync::Mutex::new(vec![]);
        let r = dispatch(
            Evaluator::Jit,
            &shape(src),
            MeshJob {
                depth,
                world_to_model,
                max_triangles: usize::MAX,
                pool: &ThreadPool::Global,
                cancel: CancelToken::new(),
                set_stage: &|s| stages.lock().unwrap().push(s),
            },
        );
        assert!(stages.lock().unwrap().iter().all(|s| *s == Stage::Checking));
        r
    }

    #[test]
    fn mesher_panic_on_nan_is_diagnosed() {
        let Err(ApiError::NonFiniteField(m)) = mesh(NAN_SPHERE, 4, Matrix4::identity()) else {
            panic!("expected the NaN to be reported")
        };
        assert!(
            m.starts_with("meshing failed: the field is NaN at (0.25, "),
            "{m}"
        );
        assert!(m.contains("; the mesher panicked with \""), "{m}");
    }

    #[test]
    fn empty_meshes_report_the_region_and_boundary_samples() {
        // Depth 4 samples each face on a 17 x 17 grid: 6 * 289 = 1734 samples
        let far = "sqrt(square(x - 5) + y*y + z*z) - 0.5";
        let Err(ApiError::EmptyMesh(m)) = mesh(far, 4, Matrix4::identity()) else {
            panic!("expected an empty-mesh error")
        };
        assert_eq!(
            m,
            "meshing the region center (0, 0, 0) +/- 1 at depth 4 produced no triangles; \
             0 of 1734 samples on the region's boundary are inside the shape"
        );

        let huge = "sqrt(x*x + y*y + z*z) - 10";
        let Err(ApiError::EmptyMesh(m)) = mesh(huge, 4, Matrix4::identity()) else {
            panic!("expected an empty-mesh error")
        };
        assert!(m.ends_with("1734 of 1734 samples on the region's boundary are inside the shape"));
    }

    #[test]
    fn clipped_meshes_warn_and_name_the_sides() {
        // Radius 1.2 pokes through all six faces of the unit cube
        let out = mesh("sqrt(x*x + y*y + z*z) - 1.2", 4, Matrix4::identity()).unwrap();
        assert_eq!(out.warnings.len(), 1);
        assert!(
            out.warnings[0].contains("on its -x, +x, -y, +y, -z, +z side(s); "),
            "{:?}",
            out.warnings
        );
        // A long bar along x is only cut at the x faces; messages use the
        // model-space region
        let m = crate::api::transform_3d([1.0, 0.0, 0.0], 2.0);
        let out = mesh("max(abs(y), abs(z)) - 0.5", 4, m).unwrap();
        assert!(
            out.warnings[0].contains("center (1, 0, 0) +/- 2 on its -x, +x side(s)"),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn renders_warn_about_nan() {
        let pool = ThreadPool::Global;
        let r2 = |src| {
            dispatch(
                Evaluator::Jit,
                &shape(src),
                Raster2d {
                    size: ImageSize::new(32, 32),
                    mode: Mode2d::Mono,
                    world_to_model: Matrix3::identity(),
                    pool: &pool,
                    cancel: CancelToken::new(),
                },
            )
            .unwrap()
        };
        assert!(r2(SPHERE).warnings.is_empty());
        let w = r2(NAN_SPHERE).warnings;
        assert_eq!(w.len(), 1);
        assert!(w[0].starts_with("the field is NaN at (0.25, "), "{w:?}");
        assert!(w[0].ends_with("), inside this view"), "{w:?}");

        let out = dispatch(
            Evaluator::Vm,
            &shape("sqrt(x*x + y*y + z*z) - 0.5 + 1 / x"),
            Raster3d {
                size: VoxelSize::new(16, 16, 16),
                mode: Mode3d::Shaded,
                denoise: true,
                ssao: false,
                world_to_model: Matrix4::identity(),
                pool: &pool,
                cancel: CancelToken::new(),
            },
        )
        .unwrap();
        assert!(
            out.warnings[0].starts_with("the field is infinite at (0, "),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn non_square_renders_probe_their_whole_view() {
        // NaN only past x = 1.5, which a wide view reaches and a square one doesn't
        let edge_nan = "sqrt(1.5 - x) + y*y + z*z - 0.5";
        let pool = ThreadPool::Global;
        let r2 = |w, h| {
            dispatch(
                Evaluator::Jit,
                &shape(edge_nan),
                Raster2d {
                    size: ImageSize::new(w, h),
                    mode: Mode2d::Mono,
                    world_to_model: Matrix3::identity(),
                    pool: &pool,
                    cancel: CancelToken::new(),
                },
            )
            .unwrap()
            .warnings
        };
        assert!(r2(32, 32).is_empty());
        let w = r2(64, 32);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].starts_with("the field is NaN at ("), "{w:?}");

        let r3 = |w, h, d| {
            dispatch(
                Evaluator::Jit,
                &shape(edge_nan),
                Raster3d {
                    size: VoxelSize::new(w, h, d),
                    mode: Mode3d::Heightmap,
                    denoise: false,
                    ssao: false,
                    world_to_model: Matrix4::identity(),
                    pool: &pool,
                    cancel: CancelToken::new(),
                },
            )
            .unwrap()
            .warnings
        };
        assert!(r3(16, 16, 16).is_empty());
        assert_eq!(r3(32, 16, 16).len(), 1);
    }

    #[test]
    fn probe_views_match_the_renderers() {
        // 2:1 images reach x = +/-2; the short axis stays near [-1, 1]
        let m = view_2d(ImageSize::new(64, 32));
        let a = m.transform_point(&Point3::new(-1.0, -1.0, 0.0));
        let b = m.transform_point(&Point3::new(1.0, 1.0, 0.0));
        assert_eq!((a.x, b.x), (-2.0, 2.0));
        assert!((a.y - b.y).abs() - 2.0 < 0.1, "{a} {b}");
        assert_eq!((a.z, b.z), (0.0, 0.0));
        let m = view_3d(VoxelSize::new(16, 16, 48));
        let a = m.transform_point(&Point3::new(-1.0, -1.0, -1.0));
        let b = m.transform_point(&Point3::new(1.0, 1.0, 1.0));
        assert_eq!((a.x, b.x), (-1.0, 1.0));
        assert_eq!((a.z, b.z), (-3.0, 3.0));
    }

    #[test]
    fn boundary_check_stops_when_cancelled() {
        struct Probe(CancelToken);
        impl ShapeJob for Probe {
            type Output = ();
            fn run<F>(self, shape: Shape<F>) -> Result<(), ApiError>
            where
                F: Function + MathFunction + RenderHints + Clone,
            {
                check_boundary(&shape, &Matrix4::identity(), 17, &self.0).map(|_| ())
            }
        }
        let c = shape(SPHERE);
        assert!(dispatch(Evaluator::Jit, &c, Probe(CancelToken::new())).is_ok());
        let r = dispatch(Evaluator::Jit, &c, Probe(cancelled()));
        assert!(matches!(r, Err(ApiError::Timeout(_))));
    }

    #[test]
    fn number_and_region_formatting() {
        assert_eq!(num(-12.0), "-12");
        assert_eq!(num(0.25), "0.25");
        assert_eq!(num(-0.00001), "0");
        assert_eq!(num(1.0 / 3.0), "0.3333");
        assert_eq!(
            region(&crate::api::transform_3d([0.0, 0.0, -10.0], 22.0)),
            "center (0, 0, -10) +/- 22"
        );
        let m = embed_2d(&crate::api::transform_2d([1.0, 2.0], 3.0));
        assert_eq!(
            m.transform_point(&Point3::new(1.0, 1.0, 0.5)),
            Point3::new(4.0, 5.0, 0.5)
        );
    }

    #[test]
    fn png_round_trip() {
        let rgba: Vec<u8> = (0..3 * 2 * 4).map(|i| i as u8 * 10).collect();
        let png = encode_png(&rgba, 3, 2).unwrap();
        let img = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (3, 2));
        assert_eq!(img.into_raw(), rgba);
        // Mismatched buffer size is an error, not a panic
        assert!(matches!(
            encode_png(&rgba, 4, 4),
            Err(ApiError::Internal(_))
        ));
    }
}
