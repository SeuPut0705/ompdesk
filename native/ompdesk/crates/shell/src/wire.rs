//! Frames between Node and the shell, the core's wire (`crates/core/src/wire.rs`) read synchronously: one JSON object
//! per line, UTF-8; a frame whose JSON carries `"bin": n` is followed by exactly `n` raw bytes that belong to it.
//! Both sides send requests (`{id, method, params}`, ids per direction), answers (`{id, ok: true, result}` or
//! `{id, ok: false, error: {code, message}}`) and events (`{event, data}`).

use std::io::{self, BufRead, Write};

use serde_json::{Map, Value, json};

/// What one line held.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: u64,
        method: String,
        params: Value,
        bin: Option<Vec<u8>>,
    },
    Answer {
        id: u64,
        result: Result<Value, WireError>,
        bin: Option<Vec<u8>>,
    },
    Event {
        event: String,
        data: Value,
        bin: Option<Vec<u8>>,
    },
    /// `{"cancel": id}`: the sender no longer waits for its request `id`.
    Cancel(u64),
    /// Not a frame this side understands (its `bin` tail, when it announced one, is consumed).
    Skipped(String),
}

#[derive(Debug, PartialEq, Clone)]
pub struct WireError {
    pub code: String,
    pub message: String,
}

impl WireError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// The largest `bin` tail a peer may announce: a screenshot or a media chunk, never a file.
pub const MAX_BIN: usize = 256 * 1024 * 1024;

/// Reads the next frame; `None` at end of input.
pub fn read_frame<R: BufRead>(reader: &mut R) -> io::Result<Option<Incoming>> {
    let mut line = Vec::new();
    if reader.read_until(b'\n', &mut line)? == 0 {
        return Ok(None);
    }
    let text = line.strip_suffix(b"\n").unwrap_or(&line);
    let text = text.strip_suffix(b"\r").unwrap_or(text);
    let value: Value = match serde_json::from_slice(text) {
        Ok(value) => value,
        Err(error) => return Ok(Some(Incoming::Skipped(format!("malformed line: {error}")))),
    };
    let Value::Object(mut head) = value else {
        return Ok(Some(Incoming::Skipped(
            "a frame that is not an object".into(),
        )));
    };
    let bin = match head.remove("bin") {
        Some(Value::Number(n)) => {
            let len = n.as_u64().map(|n| n as usize).filter(|n| *n <= MAX_BIN);
            let Some(len) = len else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("a bin tail of {n} bytes"),
                ));
            };
            let mut bytes = vec![0; len];
            reader.read_exact(&mut bytes)?;
            Some(bytes)
        }
        _ => None,
    };
    Ok(Some(classify(head, bin)))
}

fn classify(mut head: Map<String, Value>, bin: Option<Vec<u8>>) -> Incoming {
    let id = head.get("id").and_then(Value::as_u64);
    if let (Some(id), Some(Value::String(_))) = (id, head.get("method")) {
        let Some(Value::String(method)) = head.remove("method") else {
            unreachable!()
        };
        let params = head.remove("params").unwrap_or(Value::Null);
        return Incoming::Request {
            id,
            method,
            params,
            bin,
        };
    }
    if let (Some(id), Some(Value::Bool(ok))) = (id, head.get("ok")) {
        let ok = *ok;
        let result = if ok {
            Ok(head.remove("result").unwrap_or(Value::Null))
        } else {
            let error = head.remove("error").unwrap_or(Value::Null);
            Err(WireError {
                code: error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("error")
                    .to_string(),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        };
        return Incoming::Answer { id, result, bin };
    }
    if let Some(Value::String(_)) = head.get("event") {
        let Some(Value::String(event)) = head.remove("event") else {
            unreachable!()
        };
        let data = head.remove("data").unwrap_or(Value::Null);
        return Incoming::Event { event, data, bin };
    }
    if let (Some(id), None) = (
        head.get("cancel").and_then(Value::as_u64),
        head.get("method"),
    ) {
        return Incoming::Cancel(id);
    }
    Incoming::Skipped("a frame that is no request, answer or event".into())
}

/// One frame as bytes: its JSON line, then its `bin` tail. `bin` is added to the head here.
pub fn encode(mut head: Value, bin: Option<&[u8]>) -> Vec<u8> {
    if let (Some(bytes), Value::Object(map)) = (bin, &mut head) {
        map.insert("bin".into(), json!(bytes.len()));
    }
    let mut out = serde_json::to_vec(&head).unwrap_or_default();
    out.push(b'\n');
    if let Some(bytes) = bin {
        out.extend_from_slice(bytes);
    }
    out
}

pub fn request(id: u64, method: &str, params: Value, bin: Option<&[u8]>) -> Vec<u8> {
    encode(json!({ "id": id, "method": method, "params": params }), bin)
}

pub fn answer_ok(id: u64, result: Value, bin: Option<&[u8]>) -> Vec<u8> {
    encode(json!({ "id": id, "ok": true, "result": result }), bin)
}

pub fn answer_err(id: u64, error: &WireError) -> Vec<u8> {
    encode(
        json!({ "id": id, "ok": false, "error": { "code": error.code, "message": error.message } }),
        None,
    )
}

pub fn cancel(id: u64) -> Vec<u8> {
    encode(json!({ "cancel": id }), None)
}

pub fn event(name: &str, data: Value, bin: Option<&[u8]>) -> Vec<u8> {
    encode(json!({ "event": name, "data": data }), bin)
}

pub fn write_all<W: Write>(writer: &mut W, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn read_all(bytes: Vec<u8>) -> Vec<Incoming> {
        let mut cursor = Cursor::new(bytes);
        let mut out = Vec::new();
        while let Some(frame) = read_frame(&mut cursor).unwrap() {
            out.push(frame);
        }
        out
    }

    #[test]
    fn frames_round_trip_both_ways() {
        let mut wire = request(7, "win.op", json!({ "winId": 1, "op": "show" }), None);
        wire.extend(answer_ok(7, json!({ "value": 3 }), None));
        wire.extend(answer_err(8, &WireError::new("no_window", "no window 9")));
        wire.extend(event(
            "win.state",
            json!({ "winId": 1, "focused": true }),
            None,
        ));
        let frames = read_all(wire);
        assert_eq!(
            frames[0],
            Incoming::Request {
                id: 7,
                method: "win.op".into(),
                params: json!({ "winId": 1, "op": "show" }),
                bin: None
            }
        );
        assert_eq!(
            frames[1],
            Incoming::Answer {
                id: 7,
                result: Ok(json!({ "value": 3 })),
                bin: None
            }
        );
        assert_eq!(
            frames[2],
            Incoming::Answer {
                id: 8,
                result: Err(WireError::new("no_window", "no window 9")),
                bin: None
            }
        );
        assert_eq!(
            frames[3],
            Incoming::Event {
                event: "win.state".into(),
                data: json!({ "winId": 1, "focused": true }),
                bin: None
            }
        );
    }

    #[test]
    fn a_bin_tail_belongs_to_its_frame_and_may_hold_newlines() {
        let tail = b"line one\nline two\r\n{\"id\":1}".to_vec();
        let mut wire = answer_ok(3, json!({ "format": "png" }), Some(&tail));
        wire.extend(event("wc.paint", json!({ "wcId": 2 }), None));
        let frames = read_all(wire);
        assert_eq!(frames.len(), 2);
        assert_eq!(
            frames[0],
            Incoming::Answer {
                id: 3,
                result: Ok(json!({ "format": "png" })),
                bin: Some(tail)
            }
        );
        assert!(matches!(frames[1], Incoming::Event { .. }));
    }

    #[test]
    fn the_head_names_the_tail_length() {
        let wire = event("wc.chunk", json!({}), Some(b"abc"));
        let split = wire.iter().position(|b| *b == b'\n').unwrap();
        let head: Value = serde_json::from_slice(&wire[..split]).unwrap();
        assert_eq!(head, json!({ "event": "wc.chunk", "data": {}, "bin": 3 }));
        assert_eq!(&wire[split + 1..], b"abc");
    }

    #[test]
    fn a_malformed_line_is_skipped_and_the_next_frame_still_reads() {
        let mut wire = b"not json\n[1,2]\n{\"id\":1}\n".to_vec();
        wire.extend(request(2, "app.focus", Value::Null, None));
        let frames = read_all(wire);
        assert!(matches!(frames[0], Incoming::Skipped(_)));
        assert!(matches!(frames[1], Incoming::Skipped(_)));
        assert!(matches!(frames[2], Incoming::Skipped(_)));
        assert_eq!(
            frames[3],
            Incoming::Request {
                id: 2,
                method: "app.focus".into(),
                params: Value::Null,
                bin: None
            }
        );
    }

    #[test]
    fn a_tail_cut_short_is_an_error_and_an_absurd_one_is_refused() {
        let mut wire = event("x", json!({}), Some(b"abcdef"));
        wire.truncate(wire.len() - 2);
        assert!(read_frame(&mut Cursor::new(wire)).is_err());
        let huge = b"{\"event\":\"x\",\"bin\":99999999999}\n".to_vec();
        assert!(read_frame(&mut Cursor::new(huge)).is_err());
    }

    #[test]
    fn a_cancel_names_the_request_it_stops() {
        let frames = read_all(cancel(12));
        assert_eq!(frames, vec![Incoming::Cancel(12)]);
    }

    #[test]
    fn numbers_keep_their_digits() {
        let line = b"{\"id\":1,\"method\":\"m\",\"params\":{\"n\":0.1,\"big\":9007199254740993}}\n"
            .to_vec();
        let Some(Incoming::Request { params, .. }) = read_frame(&mut Cursor::new(line)).unwrap()
        else {
            panic!()
        };
        assert_eq!(params["n"].as_f64(), Some(0.1));
        assert_eq!(params["big"].as_u64(), Some(9007199254740993));
    }
}
