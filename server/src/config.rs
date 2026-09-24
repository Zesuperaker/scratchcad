//! Runtime configuration, sourced from CLI flags or `MADCAD_*` env vars.

use std::{net::SocketAddr, num::NonZeroUsize, time::Duration};

use clap::Parser;

/// HTTP API for Fidget: Rhai scripting, evaluation, rasterization and STL export
#[derive(Parser, Debug, Clone)]
#[command(version, about)]
pub struct Config {
    /// Address to listen on
    #[arg(long, env = "MADCAD_LISTEN", default_value = "0.0.0.0:8080")]
    pub listen: SocketAddr,

    /// Optional bearer token required on every `/v1` route
    #[arg(long, env = "MADCAD_API_TOKEN", hide_env_values = true)]
    pub api_token: Option<String>,

    /// Log output format
    #[arg(long, env = "MADCAD_LOG_FORMAT", value_enum, default_value_t = LogFormat::Text)]
    pub log_format: LogFormat,

    /// Worker threads used by Fidget for rendering and meshing
    /// (defaults to the number of CPUs)
    #[arg(long, env = "MADCAD_RENDER_THREADS")]
    pub render_threads: Option<NonZeroUsize>,

    /// Maximum number of jobs executing at once; further requests queue
    #[arg(long, env = "MADCAD_MAX_CONCURRENT_JOBS", default_value_t = 4)]
    pub max_concurrent_jobs: usize,

    /// How long a request may wait for a job slot before getting a 503
    #[arg(long, env = "MADCAD_QUEUE_TIMEOUT_MS", default_value_t = 5_000)]
    pub queue_timeout_ms: u64,

    /// Wall-clock budget for a single job (script + evaluation / render)
    #[arg(long, env = "MADCAD_JOB_TIMEOUT_MS", default_value_t = 30_000)]
    pub job_timeout_ms: u64,

    /// Maximum request body size in bytes
    #[arg(long, env = "MADCAD_MAX_BODY_BYTES", default_value_t = 4 * 1024 * 1024)]
    pub max_body_bytes: usize,

    /// Maximum Rhai script size in bytes
    #[arg(long, env = "MADCAD_MAX_SCRIPT_BYTES", default_value_t = 64 * 1024)]
    pub max_script_bytes: usize,

    /// Maximum number of Rhai operations a script may execute
    #[arg(
        long,
        env = "MADCAD_MAX_SCRIPT_OPERATIONS",
        default_value_t = 1_000_000
    )]
    pub max_script_operations: u64,

    /// Maximum number of unique nodes in the math graph a script produces
    #[arg(long, env = "MADCAD_MAX_NODES", default_value_t = 100_000)]
    pub max_nodes: usize,

    /// Maximum number of points (or intervals) per evaluation request
    #[arg(long, env = "MADCAD_MAX_EVAL_POINTS", default_value_t = 100_000)]
    pub max_eval_points: usize,

    /// Maximum width / height of a 2D raster image
    #[arg(long, env = "MADCAD_MAX_IMAGE_SIZE_2D", default_value_t = 4096)]
    pub max_image_size_2d: u32,

    /// Maximum width / height / depth of a 3D raster image
    #[arg(long, env = "MADCAD_MAX_IMAGE_SIZE_3D", default_value_t = 2048)]
    pub max_image_size_3d: u32,

    /// Maximum octree depth for meshing
    #[arg(long, env = "MADCAD_MAX_MESH_DEPTH", default_value_t = 8)]
    pub max_mesh_depth: u8,

    /// Maximum number of triangles in an exported mesh
    #[arg(long, env = "MADCAD_MAX_MESH_TRIANGLES", default_value_t = 4_000_000)]
    pub max_mesh_triangles: usize,
}

#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Text,
    Json,
}

impl Config {
    pub fn queue_timeout(&self) -> Duration {
        Duration::from_millis(self.queue_timeout_ms)
    }

    pub fn job_timeout(&self) -> Duration {
        Duration::from_millis(self.job_timeout_ms)
    }

    /// Upper bound on total request latency, used by the outer timeout layer
    /// as a backstop in case a handler misbehaves.
    pub fn request_timeout(&self) -> Duration {
        self.queue_timeout() + self.job_timeout() + Duration::from_secs(5)
    }

    /// Checks invariants that clap cannot express
    pub fn validate(&self) -> Result<(), String> {
        let nonzero = [
            ("max_concurrent_jobs", self.max_concurrent_jobs as u64),
            ("job_timeout_ms", self.job_timeout_ms),
            ("max_body_bytes", self.max_body_bytes as u64),
            ("max_script_bytes", self.max_script_bytes as u64),
            // Rhai treats 0 as "unlimited"
            ("max_script_operations", self.max_script_operations),
            ("max_nodes", self.max_nodes as u64),
            ("max_eval_points", self.max_eval_points as u64),
            ("max_image_size_2d", self.max_image_size_2d.into()),
            ("max_image_size_3d", self.max_image_size_3d.into()),
            ("max_mesh_depth", self.max_mesh_depth.into()),
            ("max_mesh_triangles", self.max_mesh_triangles as u64),
        ];
        if let Some((name, _)) = nonzero.iter().find(|(_, v)| *v == 0) {
            return Err(format!("{name} must be at least 1"));
        }
        if self.max_script_bytes > self.max_body_bytes {
            return Err("max_script_bytes must not exceed max_body_bytes".into());
        }
        if matches!(&self.api_token, Some(t) if t.len() < 16) {
            return Err("api_token must be at least 16 characters".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation() {
        let parse = |args: &[&str]| {
            Config::parse_from(std::iter::once("madcad").chain(args.iter().copied()))
        };
        assert!(parse(&[]).validate().is_ok());
        assert!(parse(&["--max-nodes", "0"]).validate().is_err());
        assert!(parse(&["--max-script-operations", "0"]).validate().is_err());
        assert!(parse(&["--api-token", "short"]).validate().is_err());
        assert!(
            parse(&["--max-body-bytes", "10", "--max-script-bytes", "20"])
                .validate()
                .is_err()
        );
    }
}
