//! The core's own tokio runtime. Every async call the bindings export runs its work here and awaits the join handle,
//! so it completes whatever executor polls it (Swift's, Kotlin's coroutines over UniFFI's futures, or a test's):
//! nothing depends on the caller's thread having a tokio context.

use std::{future::Future, sync::LazyLock};

static RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("moss-phone-core")
        .enable_all()
        .build()
        .expect("the core's runtime")
});

pub fn handle() -> &'static tokio::runtime::Handle {
    RT.handle()
}

/// Aborts the task when the call awaiting it is dropped before it finished.
struct AbortOnDrop(Option<tokio::task::AbortHandle>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            h.abort();
        }
    }
}

/// Runs `fut` on the core's runtime and waits for it. When the caller stops awaiting (a Swift task or a Kotlin
/// coroutine cancelled), the work is aborted at its next await point, never finished unseen: a pairing a cancelled
/// `confirm` was running keeps nothing on the phone, and an answer not yet sent is not sent. A panic in it comes back
/// as a panic here.
pub async fn spawn<T: Send + 'static>(fut: impl Future<Output = T> + Send + 'static) -> T {
    let task = RT.spawn(fut);
    let mut guard = AbortOnDrop(Some(task.abort_handle()));
    let r = task.await;
    guard.0 = None;
    match r {
        Ok(v) => v,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}
