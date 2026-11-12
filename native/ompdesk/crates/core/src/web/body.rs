//! The edge's response body: bytes in memory, framed by `content-length` when the answer's headers say so and
//! chunked when they do not, as Node framed the same answers (a `writeHead` without a length ends chunked).

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};

use hyper::body::{Body, Bytes, Frame, SizeHint};

pub struct Out {
    data: Option<Bytes>,
    /// Report the length: hyper then writes `content-length` when no header names one. Off, the length is unknown
    /// to hyper and the answer is chunked.
    sized: bool,
}

impl Out {
    pub fn sized(data: Bytes) -> Self {
        Self {
            data: Some(data),
            sized: true,
        }
    }

    pub fn chunked(data: Bytes) -> Self {
        Self {
            data: Some(data),
            sized: false,
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
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        Poll::Ready(
            self.data
                .take()
                .filter(|d| !d.is_empty())
                .map(|d| Ok(Frame::data(d))),
        )
    }

    fn is_end_stream(&self) -> bool {
        self.sized && self.data.as_ref().is_none_or(Bytes::is_empty)
    }

    fn size_hint(&self) -> SizeHint {
        match (&self.data, self.sized) {
            (Some(data), true) => SizeHint::with_exact(data.len() as u64),
            (None, true) => SizeHint::with_exact(0),
            _ => SizeHint::default(),
        }
    }
}
