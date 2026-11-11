//! One connection to OMPdesk: JSON objects, one per line, over a Unix socket or a Windows named pipe.

use std::io::{self, Read, Write};

use serde_json::{Map, Value, json};

use crate::json::{Unread, read, utf16_units};
use crate::protocol::MAX_FRAME_BYTES;

pub type Frame = Map<String, Value>;

pub struct Conn {
    reader: Box<dyn Read>,
    writer: Box<dyn Write>,
    buf: Vec<u8>,
    scanned: usize,
    units: usize,
    next: u64,
    closed: bool,
}

/// The response a request gets when the connection ends before its answer.
pub fn gone(id: u64) -> Frame {
    match json!({ "id": id, "ok": false, "error": { "code": "unavailable", "message": "OMPdesk closed the connection" } })
    {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

impl Conn {
    #[cfg(unix)]
    pub fn open(path: &str) -> io::Result<Conn> {
        let stream = std::os::unix::net::UnixStream::connect(path)?;
        Ok(Conn::new(Box::new(stream.try_clone()?), Box::new(stream)))
    }

    #[cfg(windows)]
    pub fn open(path: &str) -> io::Result<Conn> {
        use std::time::{Duration, Instant};
        const ERROR_PIPE_BUSY: i32 = 231;
        let start = Instant::now();
        loop {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
            {
                Ok(pipe) => return Ok(Conn::new(Box::new(pipe.try_clone()?), Box::new(pipe))),
                Err(e)
                    if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                        && start.elapsed() < Duration::from_secs(5) =>
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn new(reader: Box<dyn Read>, writer: Box<dyn Write>) -> Conn {
        Conn {
            reader,
            writer,
            buf: Vec::new(),
            scanned: 0,
            units: 0,
            next: 1,
            closed: false,
        }
    }

    /// Writes `body` with the next id; `None` when the connection is closed.
    pub fn send(&mut self, mut body: Frame) -> Option<u64> {
        if self.closed {
            return None;
        }
        let id = self.next;
        self.next += 1;
        body.insert("id".into(), id.into());
        let mut line = serde_json::to_vec(&body).unwrap_or_default();
        line.push(b'\n');
        if self
            .writer
            .write_all(&line)
            .and_then(|()| self.writer.flush())
            .is_err()
        {
            self.closed = true;
            return None;
        }
        Some(id)
    }

    /// Sends `body` and waits for the response carrying its id, skipping everything else.
    pub fn request(&mut self, body: Frame) -> Frame {
        let Some(id) = self.send(body) else {
            return gone(0);
        };
        while let Some(frame) = self.next_frame() {
            if !frame.contains_key("sub") && is_response_to(&frame, id) {
                return frame;
            }
        }
        gone(id)
    }

    /// The next line that is a JSON object; `None` once the stream ended, a line outgrew `MAX_FRAME_BYTES`
    /// (counted in UTF-16 units, as the TypeScript CLI counted its decoded buffer) or a line nests deeper than
    /// this reader goes (it may be the answer waited for, so the wait ends instead of running on).
    pub fn next_frame(&mut self) -> Option<Frame> {
        loop {
            // `buf[..scanned]` is known to hold no newline and to be `units` UTF-16 units long.
            if let Some(found) = self.buf[self.scanned..].iter().position(|b| *b == b'\n') {
                let at = self.scanned + found;
                let line: Vec<u8> = self.buf.drain(..=at).collect();
                (self.scanned, self.units) = (0, 0);
                match read(&line[..at]) {
                    Ok(Value::Object(frame)) => return Some(frame),
                    Err(Unread::TooDeep) => {
                        self.closed = true;
                        return None;
                    }
                    _ => continue,
                }
            }
            self.units += utf16_units(&self.buf[self.scanned..]);
            self.scanned = self.buf.len();
            if self.closed || self.units > MAX_FRAME_BYTES {
                self.closed = true;
                return None;
            }
            let mut chunk = [0u8; 64 * 1024];
            match self.reader.read(&mut chunk) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Ok(0) | Err(_) => {
                    self.closed = true;
                    return None;
                }
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
            }
        }
    }
}

pub fn is_response_to(frame: &Frame, id: u64) -> bool {
    frame.contains_key("ok") && frame.get("id").and_then(Value::as_f64) == Some(id as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answered(lines: Vec<u8>) -> Frame {
        let mut conn = Conn::new(Box::new(io::Cursor::new(lines)), Box::new(io::sink()));
        let mut body = Map::new();
        body.insert("method".into(), "state".into());
        conn.request(body)
    }

    #[test]
    fn a_title_cut_through_an_emoji_still_answers() {
        // OMPdesk cuts titles by UTF-16 unit; half an emoji arrives as a lone escape serde_json alone refuses.
        let line = br#"{"id":1,"ok":true,"result":{"title":"t\ud83d"}}"#.to_vec();
        let frame = answered([line, b"\n".to_vec()].concat());
        assert_eq!(frame["result"]["title"], "t\u{fffd}");
    }

    #[test]
    fn skips_what_is_not_its_answer() {
        let lines = b"\nnot json\n[1]\n{\"id\":7,\"ok\":true}\n{\"sub\":1,\"ok\":true,\"id\":1}\n{\"id\":1,\"ok\":true,\"result\":2}\n";
        assert_eq!(answered(lines.to_vec())["result"], 2);
    }

    #[test]
    fn the_end_of_the_stream_answers_unavailable() {
        let frame = answered(b"{\"id\":1,\"ok\":tr".to_vec());
        assert_eq!(frame["error"]["code"], "unavailable");
    }

    #[test]
    fn an_answer_nested_deeper_than_it_reads_ends_the_wait() {
        let deep = format!(
            "{{\"id\":1,\"ok\":true,\"result\":{}{}}}\n",
            "[".repeat(200),
            "]".repeat(200)
        );
        let frame = answered([deep.as_bytes(), b"{\"id\":1,\"ok\":true,\"result\":2}\n"].concat());
        assert_eq!(frame["error"]["code"], "unavailable");
    }

    #[test]
    fn the_frame_limit_counts_characters_not_bytes() {
        // Just under the limit in UTF-16 units, three times that in bytes.
        let text = "가".repeat(MAX_FRAME_BYTES - 64);
        let line = format!("{{\"id\":1,\"ok\":true,\"result\":\"{text}\"}}\n");
        assert_eq!(answered(line.into_bytes())["result"], text.as_str());
        let long = format!(
            "{{\"id\":1,\"ok\":true,\"result\":\"{}\"}}\n",
            "a".repeat(MAX_FRAME_BYTES + 128 * 1024)
        );
        assert_eq!(answered(long.into_bytes())["error"]["code"], "unavailable");
    }
}
