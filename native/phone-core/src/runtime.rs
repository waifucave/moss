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

/// Runs `fut` on the core's runtime and waits for it. A panic in it comes back as a panic here.
pub async fn spawn<T: Send + 'static>(fut: impl Future<Output = T> + Send + 'static) -> T {
    match RT.spawn(fut).await {
        Ok(v) => v,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}
