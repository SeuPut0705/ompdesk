//! Methods and dispatch. A handler is an async function from a request's params (and its `bin` tail) to a result or
//! a coded error. Requests run concurrently and are answered in completion order; at end of input the server waits
//! for the ones in flight, then returns.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::wire::{self, Frame, Incoming};

/// The wire's version, announced in `ready`.
pub const PROTOCOL: u32 = 1;

/// A failure a request answers with: a stable code and a message.
#[derive(Debug, Clone, PartialEq)]
pub struct Fault {
    pub code: Cow<'static, str>,
    pub message: String,
}

impl Fault {
    pub fn new(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Fault {
        Fault {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// What a handler is given.
pub struct Call {
    pub params: Box<RawValue>,
    pub bin: Option<Vec<u8>>,
}

impl Call {
    /// The params as `T`; a mismatch is `invalid_params`.
    pub fn params<T: DeserializeOwned>(&self) -> Result<T, Fault> {
        serde_json::from_str(self.params.get())
            .map_err(|error| Fault::new("invalid_params", error.to_string()))
    }
}

/// A handler's answer: its JSON result and an optional `bin` tail.
pub struct Reply {
    pub result: Box<RawValue>,
    pub bin: Option<Vec<u8>>,
}

impl Reply {
    pub fn json<T: Serialize>(value: &T) -> Result<Reply, Fault> {
        let result = serde_json::value::to_raw_value(value)
            .map_err(|error| Fault::new("internal", error.to_string()))?;
        Ok(Reply { result, bin: None })
    }

    pub fn with_bin(mut self, bin: Vec<u8>) -> Reply {
        self.bin = Some(bin);
        self
    }
}

pub type Answer = Pin<Box<dyn Future<Output = Result<Reply, Fault>> + Send>>;
pub type Handler = fn(Call) -> Answer;

/// Method name → handler.
#[derive(Default)]
pub struct Registry {
    methods: HashMap<&'static str, Handler>,
}

impl Registry {
    pub fn add(&mut self, name: &'static str, handler: Handler) {
        let previous = self.methods.insert(name, handler);
        assert!(previous.is_none(), "method {name} registered twice");
    }

    fn get(&self, name: &str) -> Option<Handler> {
        self.methods.get(name).copied()
    }
}

/// Every method the core serves.
pub fn registry() -> Registry {
    let mut registry = Registry::default();
    registry.add("core.echo", |call| Box::pin(echo(call)));
    crate::fs::register(&mut registry);
    crate::git::register(&mut registry);
    registry
}

#[derive(Serialize)]
struct Ready {
    version: &'static str,
    protocol: u32,
}

/// Serves requests from `input`, answering on `output`, until `input` ends. Announces `ready` first.
pub async fn serve<R, W>(input: R, output: W, registry: Registry) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let registry = Arc::new(registry);
    let (frames, writer) = wire::spawn_writer(output);
    let ready = Ready {
        version: env!("CARGO_PKG_VERSION"),
        protocol: PROTOCOL,
    };
    let _ = frames.send(Frame::event("ready", &ready));
    let mut reader = BufReader::new(input);
    let mut line = Vec::new();
    let mut in_flight = JoinSet::new();
    let read_result = loop {
        match wire::read_request(&mut reader, &mut line).await {
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
            Ok(Some(Incoming::Skipped(reason))) => {
                eprintln!("ompdesk-core: skipped a frame: {reason}")
            }
            Ok(Some(Incoming::Request(request))) => {
                let registry = Arc::clone(&registry);
                let frames = frames.clone();
                in_flight.spawn(async move {
                    let id = request.id;
                    let frame = match answer(&registry, request).await {
                        Ok(reply) => Frame::result(id, &reply.result, reply.bin),
                        Err(fault) => Frame::error(id, &fault.code, &fault.message),
                    };
                    let _ = frames.send(frame);
                });
            }
        }
        while in_flight.try_join_next().is_some() {}
    };
    while in_flight.join_next().await.is_some() {}
    drop(frames);
    let written = writer.await.map_err(io::Error::other)?;
    read_result.and(written)
}

async fn answer(registry: &Registry, request: wire::Request) -> Result<Reply, Fault> {
    let Some(handler) = registry.get(&request.method) else {
        return Err(Fault::new(
            "unknown_method",
            format!("Unknown method \"{}\"", request.method),
        ));
    };
    let call = Call {
        params: request.params,
        bin: request.bin,
    };
    // Its own task, so a panic fails this request instead of the connection.
    match tokio::spawn(handler(call)).await {
        Ok(outcome) => outcome,
        Err(error) if error.is_panic() => {
            Err(Fault::new("internal", "The request's handler panicked"))
        }
        Err(_) => Err(Fault::new(
            "internal",
            "The request's handler was cancelled",
        )),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EchoParams {
    #[serde(default)]
    value: serde_json::Value,
    wait_for: Option<String>,
    release: Option<String>,
}

#[derive(Serialize)]
struct EchoResult {
    value: serde_json::Value,
}

/// Named gates for `core.echo`: a `release` opens one for exactly one `waitFor`, in either order.
fn gate(name: &str) -> Arc<Semaphore> {
    static GATES: LazyLock<Mutex<HashMap<String, Arc<Semaphore>>>> =
        LazyLock::new(Default::default);
    let mut gates = GATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(
        gates
            .entry(name.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(0))),
    )
}

/// The wire's own check: answers `value` and the `bin` tail it was given. `waitFor` holds the answer until another
/// request `release`s that name, which is how the plumbing tests get answers out of order without timing.
async fn echo(call: Call) -> Result<Reply, Fault> {
    let params: EchoParams = call.params()?;
    if let Some(name) = &params.release {
        gate(name).add_permits(1);
    }
    if let Some(name) = &params.wait_for {
        let gate = gate(name);
        let permit = gate
            .acquire()
            .await
            .map_err(|error| Fault::new("internal", error.to_string()))?;
        permit.forget();
    }
    let reply = Reply::json(&EchoResult {
        value: params.value,
    })?;
    Ok(match call.bin {
        Some(bin) => reply.with_bin(bin),
        None => reply,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn answers_in_completion_order_and_ends_with_its_input() {
        let (mut client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(serve(server_read, server_write, registry()));
        let (client_read, mut client_write) = tokio::io::split(&mut client);
        let mut lines = tokio::io::BufReader::new(client_read);
        let mut line = String::new();
        lines.read_line(&mut line).await.unwrap();
        assert!(
            line.starts_with("{\"event\":\"ready\",\"data\":{\"version\":"),
            "{line}"
        );

        client_write
            .write_all(b"{\"id\":1,\"method\":\"core.echo\",\"params\":{\"value\":1,\"waitFor\":\"unit\"}}\n")
            .await
            .unwrap();
        client_write
            .write_all(b"{\"id\":2,\"method\":\"core.echo\",\"params\":{\"value\":2,\"release\":\"unit\"},\"bin\":3}\nxyz")
            .await
            .unwrap();
        client_write
            .write_all(b"garbage\n{\"id\":3,\"method\":\"nope\"}\n")
            .await
            .unwrap();
        let mut answers = Vec::new();
        for _ in 0..3 {
            line.clear();
            lines.read_line(&mut line).await.unwrap();
            let head: serde_json::Value = serde_json::from_str(&line).unwrap();
            if head["bin"] == 3 {
                let mut bin = [0; 3];
                lines.read_exact(&mut bin).await.unwrap();
                assert_eq!(&bin, b"xyz");
            }
            answers.push(head);
        }
        let position = |id: u64| answers.iter().position(|a| a["id"] == id).unwrap();
        assert!(position(2) < position(1), "{answers:?}");
        assert_eq!(answers[position(1)]["result"]["value"], 1);
        assert_eq!(answers[position(3)]["error"]["code"], "unknown_method");
        client_write.shutdown().await.unwrap();
        drop(client_write);
        server.await.unwrap().unwrap();
    }
}
