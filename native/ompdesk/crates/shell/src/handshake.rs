//! The two ends of an answer that is not ready when CEF opens the request (`ipc.invoke`: Node answers later, on another
//! thread). CEF's `ResourceHandler::Open` must say `handle_request = false` and have the `Continue` callback called once
//! the response is ready, and the reply can come before `Open` has returned. Either order has to end with the whole body
//! delivered and the callback called at most once, and only after `Open` said it would wait:
//!
//! - the answer comes first: `answer()` says "do not call the callback" and `open_returns()` says "handle it now";
//! - `open_returns()` comes first: it says "wait", and `answer()` then says "call the callback".

#[derive(Debug, Default, PartialEq, Eq)]
enum Phase {
    /// `open` has not decided yet.
    #[default]
    Opening,
    /// `open` returned `handle_request = false`: the answer calls the callback.
    Waiting,
    /// The answer arrived while `open` was still running: `open` handles the request itself.
    AnsweredEarly,
    Done,
}

#[derive(Debug, Default)]
pub struct Handshake {
    phase: Phase,
}

impl Handshake {
    /// The reply is stored. True when the caller must now call the callback.
    pub fn answer(&mut self) -> bool {
        match self.phase {
            Phase::Opening => {
                self.phase = Phase::AnsweredEarly;
                false
            }
            Phase::Waiting => {
                self.phase = Phase::Done;
                true
            }
            Phase::AnsweredEarly | Phase::Done => false,
        }
    }

    /// `open` is about to return. True: tell CEF to wait (`handle_request = false`); false: the answer is already there,
    /// tell CEF to handle the request now (`handle_request = true`) and call no callback.
    pub fn open_returns(&mut self) -> bool {
        match self.phase {
            Phase::Opening => {
                self.phase = Phase::Waiting;
                true
            }
            Phase::AnsweredEarly => {
                self.phase = Phase::Done;
                false
            }
            Phase::Waiting | Phase::Done => false,
        }
    }
}

/// The next bytes of the in-memory body `data` (from `pos`, up to `end`) into `out`; how many were copied. Called once per
/// CEF `Read`, whose buffer can be smaller than the body.
pub fn mem_chunk(data: &[u8], pos: u64, end: u64, out: &mut [u8]) -> usize {
    let end = usize::try_from(end).unwrap_or(usize::MAX).min(data.len());
    let pos = usize::try_from(pos).unwrap_or(usize::MAX).min(end);
    let n = (end - pos).min(out.len());
    out[..n].copy_from_slice(&data[pos..pos + n]);
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_after_open_returned_calls_the_callback() {
        let mut h = Handshake::default();
        assert!(h.open_returns(), "open says wait");
        assert!(h.answer(), "the reply continues the request");
        assert!(!h.answer(), "once");
    }

    #[test]
    fn an_answer_before_open_returned_is_handled_by_open_and_calls_no_callback() {
        let mut h = Handshake::default();
        assert!(!h.answer(), "too early for the callback");
        assert!(!h.open_returns(), "open handles the request itself");
        assert!(!h.answer());
    }

    #[test]
    fn a_body_larger_than_one_read_buffer_arrives_whole() {
        let body: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let mut pos = 0u64;
        let mut got = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let n = mem_chunk(&body, pos, body.len() as u64, &mut buffer);
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buffer[..n]);
            pos += n as u64;
        }
        assert_eq!(got, body);
        assert_eq!(mem_chunk(&body, 9_999, 10_000, &mut buffer), 1);
        assert_eq!(mem_chunk(&body, 5, 5, &mut buffer), 0);
        assert_eq!(
            mem_chunk(&body, 20_000, 30_000, &mut buffer),
            0,
            "a position past the data copies nothing"
        );
        // A range response ends before the data does.
        assert_eq!(mem_chunk(&body, 10, 14, &mut buffer), 4);
    }
}
