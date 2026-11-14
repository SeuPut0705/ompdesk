use std::io;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{
    AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf,
};
use tokio::task::JoinHandle;

use super::{Answer, Call, Registry, Reply, at_once, serve};

type Lines = BufReader<ReadHalf<DuplexStream>>;

fn native(call: Call) -> Answer {
    let params: Value = call.params().unwrap();
    let mode = params["mode"].as_str().unwrap_or("wait");
    let answer = call.events.call(
        "shell.action",
        json!({"name": "native"}),
        Some(vec![0, 10, 255]),
        Duration::from_secs(10),
        call.scope,
    );
    if mode == "drop" {
        drop(answer);
        at_once(Reply::json(&"dropped"))
    } else {
        answer
    }
}

fn ordinary(_: Call) -> Answer {
    at_once(Reply::json(&"ordinary"))
}

async fn start() -> (Lines, WriteHalf<DuplexStream>, JoinHandle<io::Result<()>>) {
    let (shell, core) = tokio::io::duplex(1 << 16);
    let (core_read, core_write) = tokio::io::split(core);
    let mut registry = Registry::default();
    registry.add("native", native);
    registry.add("ordinary", ordinary);
    let task = tokio::spawn(serve(core_read, core_write, registry));
    let (shell_read, shell_write) = tokio::io::split(shell);
    let mut lines = BufReader::new(shell_read);
    assert_eq!(next(&mut lines).await.0["event"], "ready");
    (lines, shell_write, task)
}

async fn next(lines: &mut Lines) -> (Value, Option<Vec<u8>>) {
    let mut line = String::new();
    assert_ne!(lines.read_line(&mut line).await.unwrap(), 0);
    let head: Value = serde_json::from_str(&line).unwrap();
    let bin = if let Some(len) = head["bin"].as_u64() {
        let mut bytes = vec![0; len as usize];
        lines.read_exact(&mut bytes).await.unwrap();
        Some(bytes)
    } else {
        None
    };
    (head, bin)
}

async fn send(write: &mut WriteHalf<DuplexStream>, head: Value, bin: &[u8]) {
    let mut data = serde_json::to_vec(&head).unwrap();
    data.push(b'\n');
    write.write_all(&data).await.unwrap();
    write.write_all(bin).await.unwrap();
}

async fn request(write: &mut WriteHalf<DuplexStream>, id: u64, mode: &str) {
    send(
        write,
        json!({"id": id, "method": "native", "params": {"mode": mode}}),
        &[],
    )
    .await;
}

async fn native_request(lines: &mut Lines) -> u64 {
    let (head, bin) = next(lines).await;
    assert_eq!(head["method"], "shell.action");
    assert_eq!(head["params"], json!({"name": "native"}));
    assert_eq!(bin, Some(vec![0, 10, 255]));
    head["id"].as_u64().unwrap()
}

#[tokio::test]
async fn native_reply_and_ordinary_request_share_a_duplex_connection() {
    let (mut lines, mut write, task) = start().await;
    request(&mut write, 1, "wait").await;
    let id = native_request(&mut lines).await;
    send(&mut write, json!({"id": 2, "method": "ordinary"}), &[]).await;
    let (head, _) = next(&mut lines).await;
    assert_eq!(head["id"], 2);
    assert_eq!(head["result"], "ordinary");
    send(
        &mut write,
        json!({"id": id, "ok": true, "result": {"raw": 1}, "bin": 3}),
        &[255, 10, 0],
    )
    .await;
    let (head, bin) = next(&mut lines).await;
    assert_eq!(head["id"], 1);
    assert_eq!(head["result"], json!({"raw": 1}));
    assert_eq!(bin, Some(vec![255, 10, 0]));
    write.shutdown().await.unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn native_coded_and_malformed_replies_fail_the_request() {
    let (mut lines, mut write, task) = start().await;
    request(&mut write, 1, "wait").await;
    let id = native_request(&mut lines).await;
    send(
        &mut write,
        json!({"id": id, "ok": false, "error": {"code": "denied", "message": "no"}}),
        &[],
    )
    .await;
    let (head, _) = next(&mut lines).await;
    assert_eq!(head["error"], json!({"code": "denied", "message": "no"}));
    request(&mut write, 2, "wait").await;
    let id = native_request(&mut lines).await;
    send(
        &mut write,
        json!({"id": id, "ok": false, "error": {"code": 3}, "bin": 2}),
        b"xy",
    )
    .await;
    let (head, _) = next(&mut lines).await;
    assert_eq!(head["error"]["code"], "invalid_reply");
    send(&mut write, json!({"id": 3, "method": "ordinary"}), &[]).await;
    assert_eq!(next(&mut lines).await.0["result"], "ordinary");
    write.shutdown().await.unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn dropping_cancelling_and_timing_out_withdraw_native_requests() {
    let (mut lines, mut write, task) = start().await;
    request(&mut write, 1, "drop").await;
    let id = native_request(&mut lines).await;
    assert_eq!(next(&mut lines).await.0["cancel"], id);
    assert_eq!(next(&mut lines).await.0["result"], "dropped");

    request(&mut write, 2, "wait").await;
    let id = native_request(&mut lines).await;
    send(&mut write, json!({"cancel": 2}), &[]).await;
    assert_eq!(next(&mut lines).await.0["cancel"], id);
    assert_eq!(next(&mut lines).await.0["error"]["code"], "cancelled");

    request(&mut write, 3, "wait").await;
    let id = native_request(&mut lines).await;
    tokio::time::advance(Duration::from_secs(10)).await;
    assert_eq!(next(&mut lines).await.0["cancel"], id);
    assert_eq!(next(&mut lines).await.0["error"]["code"], "timeout");
    send(
        &mut write,
        json!({"id": id, "ok": true, "result": "late"}),
        &[],
    )
    .await;
    send(&mut write, json!({"id": 4, "method": "ordinary"}), &[]).await;
    assert_eq!(next(&mut lines).await.0["id"], 4);
    write.shutdown().await.unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn eof_releases_waiters_and_old_replies_cannot_complete_a_new_connection() {
    let (mut old_lines, mut old_write, old_task) = start().await;
    request(&mut old_write, 1, "wait").await;
    let old_id = native_request(&mut old_lines).await;
    old_write.shutdown().await.unwrap();
    let (head, _) = next(&mut old_lines).await;
    assert_eq!(head["error"]["code"], "unavailable");
    old_task.await.unwrap().unwrap();

    let (mut lines, mut write, task) = start().await;
    request(&mut write, 2, "wait").await;
    let id = native_request(&mut lines).await;
    assert_ne!(old_id, id);
    send(
        &mut write,
        json!({"id": old_id, "ok": true, "result": "stale"}),
        &[],
    )
    .await;
    send(&mut write, json!({"id": 3, "method": "ordinary"}), &[]).await;
    assert_eq!(next(&mut lines).await.0["id"], 3);
    send(
        &mut write,
        json!({"id": id, "ok": true, "result": "fresh"}),
        &[],
    )
    .await;
    assert_eq!(next(&mut lines).await.0["result"], "fresh");
    write.shutdown().await.unwrap();
    task.await.unwrap().unwrap();
}
