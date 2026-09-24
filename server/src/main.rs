use std::time::Duration;

use clap::Parser;
use madcad::{
    AppState,
    config::{Config, LogFormat},
};
use tracing_subscriber::EnvFilter;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::parse();
    config.validate()?;
    init_tracing(config.log_format);

    // Dedicated Rayon pool for Fidget, sized independently of Tokio's workers.
    let threads = config
        .render_threads
        .map(|n| n.get())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()));
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("fidget-{i}"))
        .build()?;

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = rt.block_on(serve(
        config,
        fidget::render::ThreadPool::Custom(pool),
        threads,
    ));
    // Abandoned blocking jobs have been cancelled and normally stop quickly;
    // never let a stuck one hold the process open indefinitely.
    rt.shutdown_timeout(Duration::from_secs(5));
    tracing::info!("shutdown complete");
    result
}

async fn serve(
    config: Config,
    pool: fidget::render::ThreadPool,
    threads: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(
        addr = %listener.local_addr()?,
        render_threads = threads,
        max_concurrent_jobs = config.max_concurrent_jobs,
        auth = config.api_token.is_some(),
        "listening"
    );
    if config.api_token.is_none() {
        tracing::warn!("MADCAD_API_TOKEN is not set; the API is unauthenticated");
    }

    let state = AppState::new(config, pool);
    let app = madcad::router(state.clone());

    let drain = state.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutdown signal received; draining");
            drain.start_draining();
        })
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => {
                tracing::error!("failed to install SIGTERM handler: {e}");
                std::future::pending::<()>().await
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

fn init_tracing(format: LogFormat) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info"));
    // Colour only on a terminal, so log collectors don't get escape codes.
    let ansi = std::io::IsTerminal::is_terminal(&std::io::stdout());
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(ansi);
    match format {
        LogFormat::Json => builder.json().init(),
        LogFormat::Text => builder.init(),
    }
}
