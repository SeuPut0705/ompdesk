//! Queued lines handed out through fixed-size reads (CEF asks a resource for at most N bytes at a time).

use std::collections::VecDeque;

/// Copies queued bytes into `out`: whole lines first, the rest of a line that did not fit stays queued.
pub fn fill(queue: &mut VecDeque<Vec<u8>>, out: &mut [u8]) -> usize {
    let mut written = 0;
    while written < out.len() {
        let Some(mut line) = queue.pop_front() else {
            break;
        };
        let n = line.len().min(out.len() - written);
        out[written..written + n].copy_from_slice(&line[..n]);
        written += n;
        if n < line.len() {
            queue.push_front(line.split_off(n));
            break;
        }
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_fill_a_small_buffer_in_order_and_keep_the_rest() {
        let mut queue: VecDeque<Vec<u8>> = VecDeque::from([b"abcdef\n".to_vec(), b"gh\n".to_vec()]);
        let mut out = [0u8; 4];
        assert_eq!(fill(&mut queue, &mut out), 4);
        assert_eq!(&out, b"abcd");
        let mut out = [0u8; 16];
        assert_eq!(fill(&mut queue, &mut out), 6);
        assert_eq!(&out[..6], b"ef\ngh\n");
        assert_eq!(fill(&mut queue, &mut out), 0);
    }
}
