//! The updater's requests, made through the shell's own `net.rs` (Chromium's stack: the system proxy, PAC and
//! certificate store, as Electron's `net` gave them) and waited on from the updater's threads, never the UI thread.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::net::{self, Got};

pub enum Fail {
    /// Chromium's `net::ERR_…`, or why the request could not start.
    Net(String),
    /// Nothing came within the wait.
    Timeout,
}

pub struct Response {
    id: u64,
    rx: Receiver<Got>,
    ended: bool,
    pub status: u16,
    headers: Vec<(String, String)>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// The next piece of the body; `None` at its end.
    pub fn next(&mut self, wait: Duration) -> Result<Option<Vec<u8>>, Fail> {
        if self.ended {
            return Ok(None);
        }
        match self.rx.recv_timeout(wait) {
            Ok(Got::Chunk(bytes)) => Ok(Some(bytes)),
            Ok(Got::End(None)) => {
                self.ended = true;
                Ok(None)
            }
            Ok(Got::End(Some(error)) | Got::Failed(error)) => {
                self.ended = true;
                Err(Fail::Net(error))
            }
            Ok(Got::Head(_)) => Err(Fail::Net("a second response head".into())),
            Err(RecvTimeoutError::Timeout) => Err(Fail::Timeout),
            Err(RecvTimeoutError::Disconnected) => {
                self.ended = true;
                Err(Fail::Net("the request ended without an answer".into()))
            }
        }
    }

    /// The whole body, by `deadline`.
    pub fn body(&mut self, deadline: Instant) -> Result<Vec<u8>, Fail> {
        let mut body = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Fail::Timeout);
            }
            match self.next(left)? {
                Some(bytes) => body.extend_from_slice(&bytes),
                None => return Ok(body),
            }
        }
    }
}

impl Drop for Response {
    fn drop(&mut self) {
        if !self.ended {
            net::cancel_in_shell(self.id);
        }
    }
}

/// How a request treats a 3xx (`fetch`'s `redirect`).
#[derive(Clone, Copy)]
pub enum Redirect {
    Follow,
    /// The 3xx itself is the answer (its `location` read by the caller).
    Manual,
}

/// A GET; waits up to `wait` for the head.
pub fn get(
    url: &str,
    headers: &[(String, String)],
    redirect: Redirect,
    no_store: bool,
    wait: Duration,
) -> Result<Response, Fail> {
    let pairs: Vec<Value> = headers.iter().map(|(k, v)| json!([k, v])).collect();
    let params = json!({
        "url": url,
        "method": "GET",
        "headers": pairs,
        "redirect": match redirect { Redirect::Follow => "follow", Redirect::Manual => "manual" },
        "credentials": "omit",
        "cache": if no_store { "no-store" } else { "default" },
        "partition": "",
    });
    let (id, rx) = net::fetch_in_shell(params).map_err(Fail::Net)?;
    let head = match rx.recv_timeout(wait) {
        Ok(Got::Head(head)) => head,
        Ok(Got::Failed(error) | Got::End(Some(error))) => return Err(Fail::Net(error)),
        Ok(_) => return Err(Fail::Net("a response without a head".into())),
        Err(RecvTimeoutError::Timeout) => {
            net::cancel_in_shell(id);
            return Err(Fail::Timeout);
        }
        Err(RecvTimeoutError::Disconnected) => {
            return Err(Fail::Net("the request ended without an answer".into()));
        }
    };
    let headers = head["headers"]
        .as_array()
        .map(|pairs| {
            pairs
                .iter()
                .filter_map(|pair| {
                    Some((pair[0].as_str()?.to_string(), pair[1].as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Response {
        id,
        rx,
        ended: false,
        status: head["status"].as_u64().unwrap_or(0) as u16,
        headers,
    })
}
