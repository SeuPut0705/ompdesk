use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::machine::{Boxed, Proxy};
use crate::server::{Events, Fault, Scope};

use super::prefs::Prefs;

/// The one shell's existing system PAC resolver, over the native process boundary.
pub struct ShellProxy {
    prefs: Arc<Prefs>,
    shell: Events,
}

impl ShellProxy {
    pub fn new(prefs: Arc<Prefs>, shell: Events) -> Self {
        Self { prefs, shell }
    }
}

impl Proxy for ShellProxy {
    fn configured(&self) -> Option<String> {
        self.prefs
            .get("proxyUrl")
            .ok()
            .flatten()
            .and_then(|value| value.as_str().map(str::to_owned))
    }

    fn system<'a>(&'a self, url: &'a str) -> Boxed<'a, Result<String, Fault>> {
        Box::pin(async move {
            let reply = self
                .shell
                .call(
                    "native.proxy.resolve",
                    json!({"url":url}),
                    None,
                    Duration::from_secs(30),
                    Scope::detached(),
                )
                .await?;
            let value: Value = serde_json::from_str(reply.result.get())
                .map_err(|error| Fault::new("shell_proxy", error.to_string()))?;
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| Fault::new("shell_proxy", "The native shell returned no PAC result"))
        })
    }
}
