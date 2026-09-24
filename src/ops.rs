//! Fidget operations: point / gradient / interval evaluation, 2D and 3D
//! rasterization, and meshing to STL.  Everything here is synchronous and
//! meant to run inside a [`Jobs`](crate::jobs::Jobs) slot.

use fidget::{
    eval::{Function, MathFunction},
    render::{CancelToken, ImageSize, RenderHints, ThreadPool, VoxelSize},
    shape::{BoundShape, Shape},
    types::{Grad, Interval},
};
use nalgebra::{Matrix3, Matrix4};
use serde::{Deserialize, Serialize};

use crate::{error::ApiError, script::Compiled};

/// Bulk evaluators work in chunks of this many points
const EVAL_CHUNK: usize = 16 * 1024;

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
    let bad = |e| ApiError::Internal(format!("building shape: {e}"));
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

impl ShapeJob for Raster2d<'_> {
    /// RGBA8 pixels, row-major
    type Output = Vec<u8>;
    fn run<F>(self, shape: Shape<F>) -> Result<Vec<u8>, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        use fidget::raster::{effects, pixel::RenderConfig};
        let threads = Some(self.pool);
        let cfg = RenderConfig {
            threads,
            pixel_perfect: self.mode == Mode2d::Sdf,
            world_to_model: self.world_to_model,
            cancel: self.cancel,
            ..RenderConfig::from_size(self.size)
        };
        let img = cfg.run(bind(shape)?).ok_or(ApiError::Timeout)?;
        let rgba = match self.mode {
            Mode2d::Mono => effects::to_rgba_bitmap(img, false, threads),
            Mode2d::Sdf => effects::to_rgba_distance(img, threads),
            Mode2d::Debug => effects::to_debug_bitmap(img, threads),
        };
        Ok(rgba.into_iter().flatten().collect())
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
    /// RGBA8 pixels, row-major; background pixels are transparent
    type Output = Vec<u8>;
    fn run<F>(self, shape: Shape<F>) -> Result<Vec<u8>, ApiError>
    where
        F: Function + MathFunction + RenderHints + Clone,
    {
        use fidget::raster::{effects, voxel::RenderConfig};
        let threads = Some(self.pool);
        let cfg = RenderConfig {
            threads,
            world_to_model: self.world_to_model,
            cancel: self.cancel.clone(),
            ..RenderConfig::from_size(self.size)
        };
        let image = cfg.run(bind(shape)?).ok_or(ApiError::Timeout)?;
        if self.cancel.is_cancelled() {
            return Err(ApiError::Timeout);
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
        Ok(out)
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
}

pub struct StlOutput {
    pub bytes: Vec<u8>,
    pub triangles: usize,
    pub vertices: usize,
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
        let octree =
            fidget::mesh::Octree::build(&bind(shape)?, &settings).ok_or(ApiError::Timeout)?;
        if self.cancel.is_cancelled() {
            return Err(ApiError::Timeout);
        }
        let mesh = octree.walk_dual();
        drop(octree);

        let triangles = mesh.triangles.len();
        if triangles > self.max_triangles {
            return Err(ApiError::LimitExceeded(format!(
                "mesh has {triangles} triangles; the limit is {} \
                 (reduce `depth`)",
                self.max_triangles
            )));
        }
        // Binary STL: 80-byte header + u32 count + 50 bytes per triangle
        let mut bytes = Vec::with_capacity(84 + 50 * triangles);
        mesh.write_stl(&mut bytes)
            .map_err(|e| ApiError::Internal(format!("writing STL: {e}")))?;
        Ok(StlOutput {
            bytes,
            triangles,
            vertices: mesh.vertices.len(),
        })
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
        assert!(matches!(r, Err(ApiError::Timeout)));
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
        assert!(matches!(r, Err(ApiError::Timeout)));
        let r = dispatch(
            Evaluator::Vm,
            &c,
            MeshJob {
                depth: 5,
                world_to_model: Matrix4::identity(),
                max_triangles: usize::MAX,
                pool: &pool,
                cancel: cancelled(),
            },
        );
        assert!(matches!(r, Err(ApiError::Timeout)));
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
        .unwrap();
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
            },
        )
        .unwrap();
        assert!(out.triangles > 0 && out.vertices > 0);
        assert_eq!(out.bytes.len(), 84 + 50 * out.triangles);
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
