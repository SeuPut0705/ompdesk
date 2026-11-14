use std::time::Duration;

use serde_json::{Value, json};

use crate::server::{Events, Scope};

use super::accounts::{SecretBox, SecretFuture};

pub struct ShellSecrets {
    events: Events,
}

impl ShellSecrets {
    pub fn new(events: Events) -> Self {
        Self { events }
    }

    async fn status(&self) -> Result<(bool, bool), ()> {
        let reply = self
            .events
            .call(
                "native.secret.status",
                Value::Null,
                None,
                Duration::from_secs(30),
                Scope::detached(),
            )
            .await
            .map_err(|_| ())?;
        let state: Value = serde_json::from_str(reply.result.get()).map_err(|_| ())?;
        Ok((
            state["available"].as_bool().ok_or(())?,
            state["blocked"].as_bool().ok_or(())?,
        ))
    }
}

impl SecretBox for ShellSecrets {
    fn available(&self) -> SecretFuture<'_, bool> {
        Box::pin(async move { self.status().await.map(|state| state.0) })
    }

    fn blocked(&self) -> SecretFuture<'_, bool> {
        Box::pin(async move { self.status().await.map(|state| state.1) })
    }

    fn encrypt<'a>(&'a self, text: &'a str) -> SecretFuture<'a, Vec<u8>> {
        Box::pin(async move {
            let reply = self
                .events
                .call(
                    "native.secret.encrypt",
                    json!({"text": text}),
                    None,
                    Duration::from_secs(30),
                    Scope::detached(),
                )
                .await
                .map_err(|_| ())?;
            reply.bin.ok_or(())
        })
    }

    fn decrypt<'a>(&'a self, bytes: &'a [u8]) -> SecretFuture<'a, String> {
        Box::pin(async move {
            let reply = self
                .events
                .call(
                    "native.secret.decrypt",
                    Value::Null,
                    Some(bytes.to_owned()),
                    Duration::from_secs(30),
                    Scope::detached(),
                )
                .await
                .map_err(|_| ())?;
            serde_json::from_str(reply.result.get()).map_err(|_| ())
        })
    }
}
