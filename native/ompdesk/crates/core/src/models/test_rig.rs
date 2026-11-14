use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::machine::{Environment, Runtime};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub struct Fixture {
    pub dir: PathBuf,
}
impl Fixture {
    pub fn new(name: &str) -> Self {
        let root =
            std::env::var_os("OMPDESK_RUN_TEMP").map_or_else(std::env::temp_dir, PathBuf::from);
        let dir = root.join(format!(
            "native-model-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }
    pub fn script(&self, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = self.dir.join(name);
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        bin
    }
    pub fn runtime(&self, script: &str) -> Runtime {
        let bin = self.script("fake omp", script);
        let env = Environment::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), self.dir.to_string_lossy().into_owned()),
        ]);
        Runtime {
            bin,
            version: "18.20.0".into(),
            package_root: None,
            env,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub async fn start_then<F: Future>(future: F, started: impl FnOnce()) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut started = Some(started);
    std::future::poll_fn(|cx| {
        let result = future.as_mut().poll(cx);
        if let Some(started) = started.take() {
            started();
        }
        result
    })
    .await
}
