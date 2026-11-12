//! The edge's response body: bytes in memory, framed by `content-length` when the answer's headers say so and
//! chunked when they do not, as Node framed the same answers (a `writeHead` without a length ends chunked). A blob
//! too large to hold (a recording, a long file) is a stream of chunks instead (`Out::stream`).

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};

use hyper::body::{Body, Bytes, Frame, SizeHint};
use tokio::sync::mpsc;

pub struct Out {
    data: Option<Bytes>,
    /// Report the length: hyper then writes `content-length` when no header names one. Off, the length is unknown
    /// to hyper and the answer is chunked.
    sized: bool,
    /// Chunks produced while the answer is written; `data` is then unused.
    stream: Option<Chunks>,
}

struct Chunks {
    receiver: mpsc::Receiver<Bytes>,
    /// The bytes the answer promises; a stream that ends short of it breaks the connection, as a destroyed
    /// response did.
    length: Option<u64>,
}

impl Out {
    pub fn sized(data: Bytes) -> Self {
        Self {
            data: Some(data),
            sized: true,
            stream: None,
        }
    }

    pub fn chunked(data: Bytes) -> Self {
        Self {
            data: Some(data),
            sized: false,
            stream: None,
        }
    }

    /// An answer written chunk by chunk as `receiver` yields them, `length` bytes in all when known (the answer's
    /// headers then say so too). Dropping the body drops the receiver, which is how the producer learns the client
    /// went.
    pub fn stream(receiver: mpsc::Receiver<Bytes>, length: Option<u64>) -> Self {
        Self {
            data: None,
            sized: length.is_some(),
            stream: Some(Chunks { receiver, length }),
        }
    }

    pub fn empty() -> Self {
        Self::sized(Bytes::new())
    }
}

impl Body for Out {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if let Some(chunks) = self.stream.as_mut() {
            return chunks
                .receiver
                .poll_recv(cx)
                .map(|chunk| chunk.map(|data| Ok(Frame::data(data))));
        }
        Poll::Ready(
            self.data
                .take()
                .filter(|d| !d.is_empty())
                .map(|d| Ok(Frame::data(d))),
        )
    }

    fn is_end_stream(&self) -> bool {
        if let Some(chunks) = &self.stream {
            return chunks.length == Some(0);
        }
        self.sized && self.data.as_ref().is_none_or(Bytes::is_empty)
    }

    fn size_hint(&self) -> SizeHint {
        if let Some(chunks) = &self.stream {
            return chunks
                .length
                .map_or_else(SizeHint::default, SizeHint::with_exact);
        }
        match (&self.data, self.sized) {
            (Some(data), true) => SizeHint::with_exact(data.len() as u64),
            (None, true) => SizeHint::with_exact(0),
            _ => SizeHint::default(),
        }
    }
}
