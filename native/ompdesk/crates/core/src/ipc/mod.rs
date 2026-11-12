//! The command entry (unit 9a): the channels of the page's `invoke`/`send` the core serves itself. Main's
//! `IpcRegistry` (`src/main/web/ipc-registry.ts`) asks for this table once per core (`ipc.start`), registers each
//! channel in it on Electron's `ipcMain` and in its web table, and hands every call of one to `ipc.call`; every other
//! channel stays main's and never touches the core, so a core that is down or resting fails only the channels here.
//!
//! The table names channels and their handlers, nothing else: a channel's direction and web permission are
//! `IPC_POLICY`'s (`src/main/web/ipc-policy.ts`, typed over the channel union), which main hands over as data in
//! `ipc.start`. A channel served here that the policy does not list as `invoke` or `send` refuses the start.
//!
//! Order: a page's calls reach a handler in the order the page made them, as Electron runs them. Each caller (a
//! window's page, a paired page's connection) has a lane that takes its calls in the order their lines came (the
//! server calls `ipc.call`'s handler before it reads the next line). A `send` runs to its end before the lane takes
//! the next call; an `invoke` is started (its handler called) in turn and then answers on its own, as an async
//! Electron handler does.
//!
//! The web permission check of a paired page's call stays in main's `ws-router.ts` until the web router moves (8c).

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::server::{Answer, Call, Fault, Registry, Reply};

pub fn register(registry: &mut Registry) {
    // Taken in the read loop, as `ipc.call` is: a call whose line follows the start's finds the table.
    registry.add("ipc.start", |call| {
        let started = start(&call);
        Box::pin(async move { started })
    });
    registry.add("ipc.call", enqueue);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Dir {
    Invoke,
    Send,
}

/// Who made a call, as main describes it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    /// One per page that calls (`w<webContents id>`, `d<device>:<connection>`): the lane its calls are ordered in.
    pub key: String,
    /// The calling window's routing id; null when the page has none.
    #[allow(dead_code)]
    pub window: Option<i64>,
    /// A paired page's connection.
    #[allow(dead_code)]
    pub conn_id: Option<String>,
}

type Handled = Pin<Box<dyn Future<Output = Result<Value, Fault>> + Send>>;
type ChannelHandler = fn(Caller, Vec<Value>) -> Handled;

struct Owned {
    channel: &'static str,
    handler: ChannelHandler,
}

/// The channels the core serves. Empty until the first subsystem behind a channel moves here (9d, the pool).
const OWNED: &[Owned] = &[];

/// Plumbing channels for main's tests (as `core.echo` is the wire's), served only when `ipc.start` asks for them.
const TEST_OWNED: &[Owned] = &[
    Owned {
        channel: "test:ipc.record",
        handler: |caller, args| Box::pin(record(caller, args)),
    },
    Owned {
        channel: "test:ipc.recorded",
        handler: |caller, _| Box::pin(recorded(caller)),
    },
];

struct Entry {
    dir: Dir,
    handler: ChannelHandler,
}

struct Item {
    dir: Dir,
    handler: ChannelHandler,
    caller: Caller,
    args: Vec<Value>,
    reply: oneshot::Sender<Result<Value, Fault>>,
}

#[derive(Default)]
struct State {
    /// None until `ipc.start`: a core started again has no table until main hands it the policy again.
    table: Option<HashMap<&'static str, Entry>>,
    lanes: HashMap<String, mpsc::UnboundedSender<Item>>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);

fn state() -> MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Deserialize)]
struct PolicyEntry {
    dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    /// `IPC_POLICY` as main has it.
    policy: HashMap<String, PolicyEntry>,
    #[serde(default)]
    test_channels: bool,
}

#[derive(Serialize)]
struct Served {
    channel: &'static str,
    dir: Dir,
}

#[derive(Serialize)]
struct StartResult {
    channels: Vec<Served>,
}

fn table_of(
    policy: &HashMap<String, PolicyEntry>,
    owned: impl Iterator<Item = &'static Owned>,
) -> Result<HashMap<&'static str, Entry>, Fault> {
    let mut table = HashMap::new();
    for owned in owned {
        let dir = match policy.get(owned.channel).map(|entry| entry.dir.as_str()) {
            Some("invoke") => Dir::Invoke,
            Some("send") => Dir::Send,
            _ => {
                return Err(Fault::new(
                    "ipc_policy_missing",
                    format!(
                        "{} is served by ompdesk-core but IPC_POLICY lists it as no invoke or send channel",
                        owned.channel
                    ),
                ));
            }
        };
        table.insert(
            owned.channel,
            Entry {
                dir,
                handler: owned.handler,
            },
        );
    }
    Ok(table)
}

fn start(call: &Call) -> Result<Reply, Fault> {
    let params: StartParams = call.params()?;
    let tests = if params.test_channels {
        TEST_OWNED
    } else {
        &[]
    };
    let table = table_of(&params.policy, OWNED.iter().chain(tests))?;
    let mut channels: Vec<Served> = table
        .iter()
        .map(|(channel, entry)| Served {
            channel,
            dir: entry.dir,
        })
        .collect();
    channels.sort_by_key(|served| served.channel);
    state().table = Some(table);
    Reply::json(&StartResult { channels })
}

#[derive(Deserialize)]
struct CallParams {
    caller: Caller,
    channel: String,
    dir: Dir,
    #[serde(default)]
    args: Vec<Value>,
}

#[derive(Serialize)]
struct CallResult {
    value: Value,
}

/// `ipc.call`: takes the call's place in its caller's lane now, before the server reads the next line.
fn enqueue(call: Call) -> Answer {
    let placed = place(&call);
    Box::pin(async move {
        let value = placed?
            .await
            .map_err(|_| Fault::new("internal", "The call's lane ended before it answered"))??;
        Reply::json(&CallResult { value })
    })
}

fn place(call: &Call) -> Result<oneshot::Receiver<Result<Value, Fault>>, Fault> {
    let params: CallParams = call.params()?;
    let mut state = state();
    let Some(table) = &state.table else {
        return Err(Fault::new(
            "ipc_not_started",
            "ompdesk-core has not been handed IPC_POLICY",
        ));
    };
    let Some(entry) = table.get(params.channel.as_str()) else {
        return Err(Fault::new(
            "no_handler",
            format!("No handler registered for '{}'", params.channel),
        ));
    };
    if entry.dir != params.dir {
        let asked = match params.dir {
            Dir::Invoke => "invoke",
            Dir::Send => "send",
        };
        return Err(Fault::new(
            "ipc_direction",
            format!("{} is not a {asked} channel", params.channel),
        ));
    }
    let (reply, answer) = oneshot::channel();
    let item = Item {
        dir: entry.dir,
        handler: entry.handler,
        caller: params.caller,
        args: params.args,
        reply,
    };
    let key = item.caller.key.clone();
    // Sent under the state's lock: a lane that finds its queue empty under the same lock ends, and the next call
    // makes a new one, so no call is ever left in a lane that already ended.
    let item = match state.lanes.get(&key) {
        Some(lane) => match lane.send(item) {
            Ok(()) => return Ok(answer),
            Err(mpsc::error::SendError(item)) => item,
        },
        None => item,
    };
    let (lane, queue) = mpsc::unbounded_channel();
    let _ = lane.send(item);
    state.lanes.insert(key.clone(), lane);
    tokio::spawn(run_lane(key, queue));
    Ok(answer)
}

async fn run_lane(key: String, mut queue: mpsc::UnboundedReceiver<Item>) {
    loop {
        let item = {
            let mut state = state();
            match queue.try_recv() {
                Ok(item) => item,
                Err(_) => {
                    state.lanes.remove(&key);
                    return;
                }
            }
        };
        let running = (item.handler)(item.caller, item.args);
        match item.dir {
            Dir::Send => {
                let _ = item.reply.send(running.await);
            }
            Dir::Invoke => {
                let reply = item.reply;
                tokio::spawn(async move {
                    let _ = reply.send(running.await);
                });
            }
        }
    }
}

static RECORDS: LazyLock<Mutex<HashMap<String, Vec<Value>>>> = LazyLock::new(Mutex::default);

fn records() -> MutexGuard<'static, HashMap<String, Vec<Value>>> {
    RECORDS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `test:ipc.record (value, holdMs)`: records `value` for the caller after holding `holdMs`, so a later call of the
/// same caller that overtook it would be recorded first.
async fn record(caller: Caller, args: Vec<Value>) -> Result<Value, Fault> {
    let hold = args.get(1).and_then(Value::as_u64).unwrap_or(0);
    if hold > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(hold)).await;
    }
    let value = args.into_iter().next().unwrap_or(Value::Null);
    records().entry(caller.key).or_default().push(value);
    Ok(Value::Null)
}

async fn recorded(caller: Caller) -> Result<Value, Fault> {
    Ok(Value::Array(
        records().get(&caller.key).cloned().unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(entries: &[(&str, &str)]) -> HashMap<String, PolicyEntry> {
        entries
            .iter()
            .map(|(channel, dir)| {
                (
                    channel.to_string(),
                    PolicyEntry {
                        dir: dir.to_string(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn the_shipped_table_is_empty_until_a_channel_moves() {
        let table = table_of(&policy(&[]), OWNED.iter()).unwrap();
        assert!(table.is_empty());
    }

    #[test]
    fn a_served_channel_takes_its_direction_from_the_policy() {
        let table = table_of(
            &policy(&[("test:ipc.record", "send"), ("test:ipc.recorded", "invoke")]),
            TEST_OWNED.iter(),
        )
        .unwrap();
        assert_eq!(table["test:ipc.record"].dir, Dir::Send);
        assert_eq!(table["test:ipc.recorded"].dir, Dir::Invoke);
    }

    #[test]
    fn a_served_channel_the_policy_does_not_list_refuses_the_start() {
        for dir in [None, Some("push")] {
            let entries: Vec<(&str, &str)> = match dir {
                Some(dir) => vec![("test:ipc.record", dir), ("test:ipc.recorded", "invoke")],
                None => vec![("test:ipc.recorded", "invoke")],
            };
            let fault = table_of(&policy(&entries), TEST_OWNED.iter())
                .err()
                .unwrap();
            assert_eq!(fault.code, "ipc_policy_missing");
            assert!(
                fault.message.starts_with("test:ipc.record "),
                "{}",
                fault.message
            );
        }
    }

    #[tokio::test]
    async fn a_callers_sends_run_in_the_order_its_lines_came() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(crate::serve(server_read, server_write, crate::registry()));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = tokio::io::BufReader::new(client_read);
        let policy = r#"{"test:ipc.record":{"dir":"send"},"test:ipc.recorded":{"dir":"invoke"}}"#;
        let caller = r#"{"key":"order-test","window":1,"connId":null}"#;
        let input = format!(
            "{{\"id\":1,\"method\":\"ipc.start\",\"params\":{{\"policy\":{policy},\"testChannels\":true}}}}\n\
             {{\"id\":2,\"method\":\"ipc.call\",\"params\":{{\"caller\":{caller},\"channel\":\"test:ipc.record\",\"dir\":\"send\",\"args\":[1,50]}}}}\n\
             {{\"id\":3,\"method\":\"ipc.call\",\"params\":{{\"caller\":{caller},\"channel\":\"test:ipc.record\",\"dir\":\"send\",\"args\":[2,0]}}}}\n\
             {{\"id\":4,\"method\":\"ipc.call\",\"params\":{{\"caller\":{caller},\"channel\":\"test:ipc.recorded\",\"dir\":\"invoke\",\"args\":[]}}}}\n\
             {{\"id\":5,\"method\":\"ipc.call\",\"params\":{{\"caller\":{caller},\"channel\":\"test:ipc.record\",\"dir\":\"invoke\",\"args\":[]}}}}\n"
        );
        client_write.write_all(input.as_bytes()).await.unwrap();
        client_write.shutdown().await.unwrap();
        let mut answers = HashMap::new();
        let mut line = String::new();
        while lines.read_line(&mut line).await.unwrap() > 0 {
            let frame: Value = serde_json::from_str(&line).unwrap();
            if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                answers.insert(id, frame);
            }
            line.clear();
        }
        server.await.unwrap().unwrap();
        assert_eq!(answers[&4]["result"]["value"], serde_json::json!([1, 2]));
        assert_eq!(answers[&5]["error"]["code"], "ipc_direction");
    }
}
