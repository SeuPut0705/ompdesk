//! Frames on the wire, both ways over stdio: one JSON object per line, UTF-8. A frame whose JSON carries
//! `"bin": <n>` is followed by exactly `n` raw bytes after its newline, which belong to it (a file's contents,
//! never base64). One writer task owns the output, so frames never interleave. Main also sends `{"cancel": <id>}`,
//! which stops a request it no longer waits for.

use std::io;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufWriter,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// A request from main: `{"id", "method", "params"}`, and its `bin` tail when it has one.
pub struct Request {
    pub id: u64,
    pub method: String,
    pub params: Box<RawValue>,
    pub bin: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct Head {
    id: Option<u64>,
    method: Option<String>,
    params: Option<Box<RawValue>>,
    bin: Option<usize>,
    cancel: Option<u64>,
}

/// One line read: a request, a cancel of one, or why it was skipped.
pub enum Incoming {
    Request(Request),
    Cancel(u64),
    Skipped(String),
}

/// Reads the next frame; `None` at end of input. A line that is not JSON is skipped (its bytes are unknown, so a
/// `bin` it may have announced is read as lines); valid JSON without an id and a method is skipped with its tail.
pub async fn read_request<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> io::Result<Option<Incoming>> {
    line.clear();
    if reader.read_until(b'\n', line).await? == 0 {
        return Ok(None);
    }
    let text = line.strip_suffix(b"\n").unwrap_or(line);
    let text = text.strip_suffix(b"\r").unwrap_or(text);
    let head: Head = match serde_json::from_slice(text) {
        Ok(head) => head,
        Err(error) => return Ok(Some(Incoming::Skipped(format!("malformed line: {error}")))),
    };
    let bin = match head.bin {
        Some(len) => {
            let mut bytes = vec![0; len];
            reader.read_exact(&mut bytes).await?;
            Some(bytes)
        }
        None => None,
    };
    let (Some(id), Some(method)) = (head.id, head.method) else {
        return Ok(Some(match head.cancel {
            Some(id) => Incoming::Cancel(id),
            None => Incoming::Skipped("a frame without an integer id and a method".into()),
        }));
    };
    let params = match head.params {
        Some(params) => params,
        None => RawValue::from_string("null".into()).map_err(io::Error::other)?,
    };
    Ok(Some(Incoming::Request(Request {
        id,
        method,
        params,
        bin,
    })))
}

/// A frame to write: its JSON line (newline included) and its `bin` tail.
pub struct Frame {
    head: Vec<u8>,
    bin: Option<Vec<u8>>,
}

#[derive(Serialize)]
struct EventHead<'a, T: Serialize> {
    event: &'a str,
    data: &'a T,
}

#[derive(Serialize)]
struct ResultHead<'a> {
    id: u64,
    ok: bool,
    result: &'a RawValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    bin: Option<usize>,
}

#[derive(Serialize)]
struct ErrorHead<'a> {
    id: u64,
    ok: bool,
    error: ErrorBody<'a>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
}

fn line<T: Serialize>(value: &T) -> Vec<u8> {
    // These heads hold only strings, numbers and already-valid JSON: serializing them cannot fail.
    let mut head = serde_json::to_vec(value).unwrap_or_default();
    head.push(b'\n');
    head
}

impl Frame {
    pub fn event<T: Serialize>(event: &str, data: &T) -> Frame {
        Frame {
            head: line(&EventHead { event, data }),
            bin: None,
        }
    }

    pub fn result(id: u64, result: &RawValue, bin: Option<Vec<u8>>) -> Frame {
        Frame {
            head: line(&ResultHead {
                id,
                ok: true,
                result,
                bin: bin.as_ref().map(Vec::len),
            }),
            bin,
        }
    }

    pub fn error(id: u64, code: &str, message: &str) -> Frame {
        Frame {
            head: line(&ErrorHead {
                id,
                ok: false,
                error: ErrorBody { code, message },
            }),
            bin: None,
        }
    }
}

/// The one writer: frames sent to the returned channel go out whole, in the order sent. It ends when every sender
/// is gone, after flushing.
pub fn spawn_writer<W: AsyncWrite + Unpin + Send + 'static>(
    output: W,
) -> (mpsc::UnboundedSender<Frame>, JoinHandle<io::Result<()>>) {
    let (sender, mut frames) = mpsc::unbounded_channel::<Frame>();
    let task = tokio::spawn(async move {
        let mut output = BufWriter::new(output);
        while let Some(frame) = frames.recv().await {
            output.write_all(&frame.head).await?;
            if let Some(bin) = &frame.bin {
                output.write_all(bin).await?;
            }
            if frames.is_empty() {
                output.flush().await?;
            }
        }
        output.flush().await
    });
    (sender, task)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read_all(input: &[u8]) -> Vec<Result<(u64, String, String, Option<Vec<u8>>), String>> {
        let mut reader = tokio::io::BufReader::new(input);
        let mut line = Vec::new();
        let mut out = Vec::new();
        while let Some(incoming) = read_request(&mut reader, &mut line).await.unwrap() {
            out.push(match incoming {
                Incoming::Request(r) => Ok((r.id, r.method, r.params.get().to_owned(), r.bin)),
                Incoming::Cancel(id) => Err(format!("cancel {id}")),
                Incoming::Skipped(reason) => Err(reason),
            });
        }
        out
    }

    #[tokio::test]
    async fn reads_lines_and_bin_tails() {
        let input = b"{\"id\":1,\"method\":\"a\",\"params\":{\"x\":1}}\n{\"id\":2,\"method\":\"b\",\"params\":null,\"bin\":3}\nab\n{\"id\":3,\"method\":\"c\"}\r\n";
        let frames = read_all(input).await;
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0], Ok((1, "a".into(), "{\"x\":1}".into(), None)));
        assert_eq!(
            frames[1],
            Ok((2, "b".into(), "null".into(), Some(b"ab\n".to_vec())))
        );
        assert_eq!(frames[2], Ok((3, "c".into(), "null".into(), None)));
    }

    #[tokio::test]
    async fn skips_malformed_lines_and_frames_without_an_id() {
        let input = b"not json\n{\"method\":\"x\",\"bin\":2}\nzz{\"id\":4,\"method\":\"d\",\"params\":{}}\n";
        let frames = read_all(input).await;
        assert!(matches!(&frames[0], Err(reason) if reason.starts_with("malformed line")));
        assert!(matches!(&frames[1], Err(reason) if reason.contains("without an integer id")));
        assert_eq!(frames[2], Ok((4, "d".into(), "{}".into(), None)));
    }

    #[tokio::test]
    async fn reads_a_cancel_frame() {
        let frames = read_all(b"{\"cancel\":7}\n{\"cancel\":\"x\"}\n").await;
        assert_eq!(frames[0], Err("cancel 7".into()));
        assert!(matches!(&frames[1], Err(reason) if reason.starts_with("malformed line")));
    }

    #[test]
    fn writes_heads_with_their_bin_length() {
        let result = RawValue::from_string("{\"size\":2}".into()).unwrap();
        let frame = Frame::result(7, &result, Some(vec![1, 2]));
        assert_eq!(
            frame.head,
            b"{\"id\":7,\"ok\":true,\"result\":{\"size\":2},\"bin\":2}\n"
        );
        let frame = Frame::error(8, "unknown_method", "Unknown method \"x\"");
        assert_eq!(
            frame.head,
            b"{\"id\":8,\"ok\":false,\"error\":{\"code\":\"unknown_method\",\"message\":\"Unknown method \\\"x\\\"\"}}\n"
        );
    }
}
