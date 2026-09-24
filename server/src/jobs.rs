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

use std::{sync::Arc, time::Duration};

use fidget::render::{CancelToken, ThreadPool};
use tokio::sync::Semaphore;

use crate::error::ApiError;

/// Context handed to a running job
pub struct JobCtx {
    pub cancel: CancelToken,
    pub pool: Arc<ThreadPool>,
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
        let ctx = JobCtx {
            cancel: cancel.clone(),
            pool: self.pool.clone(),
        };
        let handle = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f(&ctx)
        });

        match tokio::time::timeout(self.job_timeout, handle).await {
            Ok(Ok(result)) => result,
            Ok(Err(e)) if e.is_panic() => {
                let msg = e
                    .into_panic()
                    .downcast::<String>()
                    .map(|s| *s)
                    .or_else(|p| p.downcast::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|_| "unknown panic".into());
                Err(ApiError::Internal(format!("job panicked: {msg}")))
            }
            Ok(Err(e)) => Err(ApiError::Internal(format!("job failed: {e}"))),
            Err(_elapsed) => {
                cancel.cancel();
                Err(ApiError::Timeout)
            }
        }
    }
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
        Err(ApiError::Timeout)
    }

    #[tokio::test]
    async fn timeout_cancels_and_frees_slot() {
        let j = jobs(1, 2_000, 50);
        assert!(matches!(j.run(spin).await, Err(ApiError::Timeout)));
        // The slot is released once the job observes cancellation.
        assert_eq!(j.run(|_| Ok(7)).await.unwrap(), 7);
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
