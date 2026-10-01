//! Execution of CPU-bound work off the async runtime.
//!
//! Every job:
//! - waits (bounded by the queue timeout) for one of a fixed number of slots,
//!   returning 503 if none frees up;
//! - runs on a blocking thread, holding its slot until the work *actually*
//!   stops, so timed-out work can never oversubscribe the CPU;
//! - gets a [`CancelToken`] that is tripped on timeout or when the client
//!   disconnects (the request future is dropped), which Fidget's renderers,
//!   the mesher and our Rhai sandbox all poll.

use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use fidget::render::{CancelToken, ThreadPool};
use tokio::sync::Semaphore;

use crate::error::ApiError;

/// What a job is doing, so that a timeout can say what ran out of time
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Stage {
    Script,
    Evaluating,
    Rendering,
    Meshing,
    /// Checking a finished mesh, or diagnosing a failed one
    Checking,
}

impl Stage {
    const ALL: [Stage; 5] = [
        Stage::Script,
        Stage::Evaluating,
        Stage::Rendering,
        Stage::Meshing,
        Stage::Checking,
    ];

    fn describe(self) -> &'static str {
        match self {
            Stage::Script => "running the script",
            Stage::Evaluating => "evaluating the samples",
            Stage::Rendering => "rendering",
            Stage::Meshing => "meshing",
            Stage::Checking => "checking the mesh",
        }
    }
}

/// Context handed to a running job
pub struct JobCtx {
    pub cancel: CancelToken,
    pub pool: Arc<ThreadPool>,
    stage: Arc<AtomicU8>,
}

impl JobCtx {
    /// Records what the job is doing; jobs start in [`Stage::Script`]
    pub fn set_stage(&self, stage: Stage) {
        self.stage.store(stage as u8, Ordering::Relaxed);
    }
}

pub struct Jobs {
    slots: Arc<Semaphore>,
    max_slots: usize,
    queue_timeout: Duration,
    job_timeout: Duration,
    pool: Arc<ThreadPool>,
}

/// Cancels the token when dropped (request finished, timed out or aborted)
struct CancelOnDrop(CancelToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl Jobs {
    pub fn new(
        max_slots: usize,
        queue_timeout: Duration,
        job_timeout: Duration,
        pool: ThreadPool,
    ) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(max_slots)),
            max_slots,
            queue_timeout,
            job_timeout,
            pool: Arc::new(pool),
        }
    }

    /// Number of jobs currently executing
    pub fn active(&self) -> usize {
        self.max_slots - self.slots.available_permits()
    }

    pub fn capacity(&self) -> usize {
        self.max_slots
    }

    /// Stops accepting new jobs (used during shutdown)
    pub fn close(&self) {
        self.slots.close();
    }

    pub async fn run<T, F>(&self, f: F) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: FnOnce(&JobCtx) -> Result<T, ApiError> + Send + 'static,
    {
        let permit = tokio::time::timeout(self.queue_timeout, self.slots.clone().acquire_owned())
            .await
            .map_err(|_| ApiError::Overloaded)?
            .map_err(|_| ApiError::Overloaded)?; // semaphore closed: shutting down

        let cancel = CancelToken::new();
        let _guard = CancelOnDrop(cancel.clone());
        let stage = Arc::new(AtomicU8::new(Stage::Script as u8));
        let ctx = JobCtx {
            cancel: cancel.clone(),
            pool: self.pool.clone(),
            stage: stage.clone(),
        };
        let handle = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f(&ctx)
        });

        match tokio::time::timeout(self.job_timeout, handle).await {
            Ok(Ok(result)) => result,
            Ok(Err(e)) if e.is_panic() => Err(ApiError::Internal(format!(
                "job panicked: {}",
                panic_message(e.into_panic())
            ))),
            Ok(Err(e)) => Err(ApiError::Internal(format!("job failed: {e}"))),
            Err(_elapsed) => {
                cancel.cancel();
                let stage = Stage::ALL[usize::from(stage.load(Ordering::Relaxed))];
                Err(ApiError::Timeout(format!(
                    "{} exceeded the {} s job budget",
                    stage.describe(),
                    self.job_timeout.as_secs_f64(),
                )))
            }
        }
    }
}

/// The message a panic was raised with, when it has one
pub fn panic_message(panic: Box<dyn std::any::Any + Send>) -> String {
    panic
        .downcast::<String>()
        .map(|s| *s)
        .or_else(|p| p.downcast::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|_| "unknown panic".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jobs(slots: usize, queue_ms: u64, job_ms: u64) -> Jobs {
        Jobs::new(
            slots,
            Duration::from_millis(queue_ms),
            Duration::from_millis(job_ms),
            ThreadPool::Global,
        )
    }

    /// Busy-waits until cancelled, like a render loop
    fn spin(ctx: &JobCtx) -> Result<(), ApiError> {
        while !ctx.cancel.is_cancelled() {
            std::thread::sleep(Duration::from_millis(1));
        }
        Err(ApiError::cancelled())
    }

    #[tokio::test]
    async fn timeout_cancels_and_frees_slot() {
        let j = jobs(1, 2_000, 50);
        assert!(matches!(j.run(spin).await, Err(ApiError::Timeout(_))));
        // The slot is released once the job observes cancellation.
        assert_eq!(j.run(|_| Ok(7)).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn timeout_names_the_stage_and_budget() {
        let j = jobs(1, 2_000, 50);
        let r = j
            .run(|ctx| {
                ctx.set_stage(Stage::Meshing);
                spin(ctx)
            })
            .await;
        let Err(ApiError::Timeout(m)) = r else {
            panic!("expected a timeout")
        };
        assert_eq!(m, "meshing exceeded the 0.05 s job budget");
    }

    #[tokio::test]
    async fn overload_returns_503() {
        let j = Arc::new(jobs(1, 20, 500));
        let j2 = j.clone();
        let busy = tokio::spawn(async move { j2.run(spin).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(matches!(j.run(|_| Ok(())).await, Err(ApiError::Overloaded)));
        let _ = busy.await;
    }

    #[tokio::test]
    async fn panics_are_contained() {
        let j = jobs(1, 100, 1_000);
        let r: Result<(), _> = j.run(|_| panic!("boom")).await;
        assert!(matches!(r, Err(ApiError::Internal(m)) if m.contains("boom")));
        assert_eq!(j.active(), 0);
    }
}
