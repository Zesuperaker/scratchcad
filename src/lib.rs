//! HTTP API over [Fidget](https://github.com/mkeeter/fidget): run Rhai scripts,
//! evaluate implicit surfaces, rasterize them to PNG and export STL meshes.

pub mod api;
pub mod config;
pub mod error;
pub mod jobs;
pub mod ops;
pub mod script;

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use sha2::{Digest, Sha256};
use tower::ServiceBuilder;
use tower_http::{
    catch_panic::CatchPanicLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    sensitive_headers::SetSensitiveRequestHeadersLayer,
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::{DefaultOnResponse, TraceLayer},
};
use tracing::Level;

use crate::{
    config::Config,
    error::ApiError,
    jobs::Jobs,
    script::{ScriptCache, ScriptLimits},
};

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub config: Config,
    pub limits: ScriptLimits,
    pub jobs: Jobs,
    pub scripts: ScriptCache,
    draining: AtomicBool,
    /// SHA-256 of the API token, compared in constant time
    token_hash: Option<[u8; 32]>,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(config: Config, pool: fidget::render::ThreadPool) -> Self {
        let limits = ScriptLimits {
            max_operations: config.max_script_operations,
            max_nodes: config.max_nodes,
            max_string_size: config.max_script_bytes,
        };
        let jobs = Jobs::new(
            config.max_concurrent_jobs,
            config.queue_timeout(),
            config.job_timeout(),
            pool,
        );
        let token_hash = config
            .api_token
            .as_deref()
            .map(|t| Sha256::digest(t.as_bytes()).into());
        Self(Arc::new(Inner {
            limits,
            jobs,
            scripts: ScriptCache::new(config.script_cache_size),
            draining: AtomicBool::new(false),
            token_hash,
            config,
        }))
    }

    /// Marks the service as shutting down: readiness fails and queued jobs
    /// are rejected, while in-flight jobs run to completion.
    pub fn start_draining(&self) {
        self.draining.store(true, Ordering::Relaxed);
        self.jobs.close();
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::Relaxed)
    }
}

async fn require_token(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if let Some(expected) = &state.token_hash {
        let presented = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized)?;
        let got: [u8; 32] = Sha256::digest(presented.as_bytes()).into();
        // Constant-time comparison of fixed-length digests
        let diff = got
            .iter()
            .zip(expected)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b));
        if diff != 0 {
            return Err(ApiError::Unauthorized);
        }
    }
    Ok(next.run(req).await)
}

async fn not_found() -> ApiError {
    ApiError::NotFound
}

fn panic_response(_: Box<dyn std::any::Any + Send + 'static>) -> Response {
    ApiError::Internal("handler panicked".into()).into_response()
}

/// Builds the application router with all middleware
pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/v1/scripts", post(api::create_script))
        .route(
            "/v1/scripts/{id}",
            get(api::get_script).delete(api::delete_script),
        )
        .route("/v1/eval", post(api::eval))
        .route("/v1/raster/2d", post(api::raster_2d))
        .route("/v1/raster/3d", post(api::raster_3d))
        .route("/v1/export/stl", post(api::export_stl))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));

    let middleware = ServiceBuilder::new()
        .layer(SetSensitiveRequestHeadersLayer::new([
            header::AUTHORIZATION,
        ]))
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|req: &Request| {
                    let id = req
                        .headers()
                        .get("x-request-id")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("-");
                    tracing::info_span!(
                        "request",
                        method = %req.method(),
                        path = %req.uri().path(),
                        request_id = %id,
                    )
                })
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(CatchPanicLayer::custom(panic_response))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            state.config.request_timeout(),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(DefaultBodyLimit::max(state.config.max_body_bytes));

    Router::new()
        .merge(v1)
        .route("/healthz", get(api::healthz))
        .route("/readyz", get(api::readyz))
        .fallback(not_found)
        .layer(middleware)
        .with_state(state)
}
