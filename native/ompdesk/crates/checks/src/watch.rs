//! What a heavy command does to the disk while it runs: the volumes it writes to are read every few seconds, a person
//! and the session hear when one falls under what a new heavy command needs (with how fast it falls), and the command
//! is stopped when one falls under `DANGER`, before the disk fills and takes the system's own writes with it. Its output
//! is kept to a head and a tail (`Capped`), so a command that prints an error line in a loop cannot fill the disk
//! through it.
//!
//! Measured on 13 Nov 2026: a test whose loop printed one error line after a panic wrote 26 GB in ten minutes on a Mac
//! mini (two log files of 7-8 GB each), the system disk reached 116 MB free, OMPdesk's own settings write failed with
//! an OS error box and another session's check died.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::heavy::Volumes;

const GIB: u64 = 1024 * 1024 * 1024;
/// Free space under which a running heavy command is stopped: what the system still needs to write its own files.
pub const DANGER: u64 = 3 * GIB;
/// How often the volumes are read.
const EVERY: Duration = Duration::from_secs(5);
/// How long a stopped command has between SIGTERM and SIGKILL (Windows ends the tree at once).
#[cfg_attr(windows, allow(dead_code))]
pub const GRACE: Duration = Duration::from_secs(10);
/// Output kept from the start of a command, and from its end, when it prints more than both.
pub const HEAD: usize = 32 * 1024 * 1024;
pub const TAIL: usize = 8 * 1024 * 1024;

/// A size as people read it: `258.1 GB`, `17 MB` under a gigabyte.
pub fn gb(bytes: u64) -> String {
    if bytes < GIB {
        format!("{} MB", bytes / (1024 * 1024))
    } else {
        format!("{:.1} GB", bytes as f64 / GIB as f64)
    }
}

/// The volumes' watch for one running command; ends when dropped.
pub struct Watch {
    stop: Arc<AtomicBool>,
    stopped_for_disk: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Watch {
    /// `say` tells a person and the session (a line on stderr or the check's log); `stop_command` ends the command
    /// (SIGTERM, then SIGKILL after `GRACE`) on its own thread, once; without one (`heavy hold`, which does not know
    /// its holder's command) the line says to stop it.
    pub fn start(
        volumes: Volumes,
        every: Option<Duration>,
        say: impl Fn(&str) + Send + 'static,
        stop_command: Option<Box<dyn FnOnce() + Send>>,
    ) -> Watch {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped_for_disk = Arc::new(AtomicBool::new(false));
        let (stop_flag, stopped) = (stop.clone(), stopped_for_disk.clone());
        let every = every.unwrap_or(EVERY);
        let handle = std::thread::spawn(move || {
            let begun = Instant::now();
            let first: Vec<(String, u64)> = volumes
                .read()
                .into_iter()
                .map(|d| (d.path, d.free))
                .collect();
            let mut previous: Vec<(String, u64, Instant)> =
                first.iter().map(|(p, f)| (p.clone(), *f, begun)).collect();
            let mut low: Vec<String> = Vec::new();
            let mut stop_command = stop_command;
            let mut warned_danger = false;
            while !stop_flag.load(Ordering::Relaxed) {
                let wake = Instant::now() + every;
                while Instant::now() < wake && !stop_flag.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100).min(every));
                }
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }
                let now = Instant::now();
                for disk in volumes.read() {
                    let before = previous.iter().find(|(p, ..)| *p == disk.path);
                    let rate = before.map_or(0.0, |(_, free, at)| {
                        let minutes = now.duration_since(*at).as_secs_f64() / 60.0;
                        if minutes > 0.0 {
                            (*free as f64 - disk.free as f64) / minutes
                        } else {
                            0.0
                        }
                    });
                    let since_start = first
                        .iter()
                        .find(|(p, _)| *p == disk.path)
                        .map_or(0, |(_, f)| f.saturating_sub(disk.free));
                    let pace = format!(
                        "falling {}/min, {} written there since the command started",
                        gb(rate.max(0.0) as u64),
                        gb(since_start)
                    );
                    if disk.free < DANGER && stop_command.is_none() && !warned_danger {
                        warned_danger = true;
                        say(&format!(
                            "only {} left on {} (under {}), {pace}: stop the heavy command holding this slot now",
                            gb(disk.free),
                            disk.path,
                            gb(DANGER)
                        ));
                    } else if disk.free < DANGER {
                        if let Some(stop_now) = stop_command.take() {
                            stopped.store(true, Ordering::Relaxed);
                            say(&format!(
                                "stopping the command: {} left on {} (under {}), {pace}; its log and results stay",
                                gb(disk.free),
                                disk.path,
                                gb(DANGER)
                            ));
                            std::thread::spawn(stop_now);
                        }
                    } else if disk.low() && !low.contains(&disk.path) {
                        low.push(disk.path.clone());
                        say(&format!(
                            "disk low while running: {} free on {} (new heavy work waits under {}), {pace}; it is stopped under {}",
                            gb(disk.free),
                            disk.path,
                            gb(disk.need),
                            gb(DANGER)
                        ));
                    } else if !disk.low() {
                        low.retain(|p| *p != disk.path);
                    }
                    previous.retain(|(p, ..)| *p != disk.path);
                    previous.push((disk.path, disk.free, now));
                }
            }
        });
        Watch {
            stop,
            stopped_for_disk,
            handle: Some(handle),
        }
    }

    pub fn stopped_for_disk(&self) -> bool {
        self.stopped_for_disk.load(Ordering::Relaxed)
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct CapState<W> {
    out: W,
    written: usize,
    tail: VecDeque<u8>,
    dropped: u64,
    marked: bool,
}

/// A writer that passes the first `HEAD` bytes, then keeps only the last `TAIL` and writes them with a note of what
/// was cut at `finish`. Shared by the threads that copy a command's stdout and stderr.
pub struct Capped<W: Write> {
    state: Mutex<CapState<W>>,
    head: usize,
    tail: usize,
}

impl<W: Write> Capped<W> {
    pub fn new(out: W) -> Capped<W> {
        Capped::with_limits(out, HEAD, TAIL)
    }

    pub fn with_limits(out: W, head: usize, tail: usize) -> Capped<W> {
        Capped {
            state: Mutex::new(CapState {
                out,
                written: 0,
                tail: VecDeque::new(),
                dropped: 0,
                marked: false,
            }),
            head,
            tail,
        }
    }

    pub fn write(&self, mut chunk: &[u8]) {
        let Ok(mut s) = self.state.lock() else {
            return;
        };
        if s.written < self.head {
            let n = chunk.len().min(self.head - s.written);
            let _ = s.out.write_all(&chunk[..n]);
            let _ = s.out.flush();
            s.written += n;
            chunk = &chunk[n..];
        }
        if chunk.is_empty() {
            return;
        }
        if !s.marked {
            s.marked = true;
            let note = format!(
                "\n[ompdesk: the output passed {} MB; the rest is cut and its last {} MB are written when the command ends]\n",
                self.head / (1024 * 1024),
                self.tail / (1024 * 1024)
            );
            let _ = s.out.write_all(note.as_bytes());
            let _ = s.out.flush();
        }
        s.tail.extend(chunk);
        let over = s.tail.len().saturating_sub(self.tail);
        if over > 0 {
            s.tail.drain(..over);
            s.dropped += over as u64;
        }
    }

    /// Copies a reader through the cap until it ends.
    pub fn pump(&self, mut from: impl io::Read) {
        let mut buf = vec![0u8; 64 * 1024];
        while let Ok(n) = from.read(&mut buf) {
            if n == 0 {
                break;
            }
            self.write(&buf[..n]);
        }
    }

    /// Writes the kept tail; the bytes cut, if any.
    pub fn finish(&self) -> u64 {
        let Ok(mut s) = self.state.lock() else {
            return 0;
        };
        if s.tail.is_empty() {
            return 0;
        }
        let dropped = s.dropped;
        let note =
            format!("[ompdesk: {dropped} bytes of output cut here; the last part follows]\n");
        let _ = s.out.write_all(note.as_bytes());
        let tail: Vec<u8> = s.tail.drain(..).collect();
        let _ = s.out.write_all(&tail);
        let _ = s.out.flush();
        dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn output_past_the_cap_keeps_its_head_and_tail() {
        let capped = Capped::with_limits(Vec::new(), 10, 4);
        capped.write(b"0123456789abcdef");
        capped.write(b"ghij");
        assert_eq!(capped.finish(), 6);
        let out = String::from_utf8(capped.state.into_inner().unwrap().out).unwrap();
        assert!(out.starts_with("0123456789\n[ompdesk: the output passed"));
        assert!(out.contains("[ompdesk: 6 bytes of output cut here; the last part follows]\nghij"));
        let short = Capped::with_limits(Vec::new(), 10, 4);
        short.write(b"abc");
        assert_eq!(short.finish(), 0);
        assert_eq!(short.state.into_inner().unwrap().out, b"abc");
    }

    #[test]
    fn a_filling_disk_is_reported_then_stops_the_command() {
        let free = Arc::new(AtomicU64::new(100 * GIB));
        let probe_free = free.clone();
        let volumes = Volumes::of_work(&std::env::temp_dir(), &[], &|_| None).with_probe(Arc::new(
            move |_| Some((probe_free.load(Ordering::Relaxed), 500 * GIB)),
        ));
        let said = Arc::new(Mutex::new(Vec::<String>::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let (said2, stopped2) = (said.clone(), stopped.clone());
        let watch = Watch::start(
            volumes,
            Some(Duration::from_millis(20)),
            move |line| said2.lock().unwrap().push(line.to_string()),
            Some(Box::new(move || stopped2.store(true, Ordering::Relaxed))),
        );
        let wait_for = |cond: &dyn Fn() -> bool| {
            let until = Instant::now() + Duration::from_secs(5);
            while !cond() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        free.store(15 * GIB, Ordering::Relaxed);
        wait_for(&|| !said.lock().unwrap().is_empty());
        assert!(said.lock().unwrap()[0].starts_with("disk low while running: 15.0 GB free"));
        assert!(!stopped.load(Ordering::Relaxed));
        free.store(2 * GIB, Ordering::Relaxed);
        wait_for(&|| stopped.load(Ordering::Relaxed));
        assert!(stopped.load(Ordering::Relaxed));
        assert!(watch.stopped_for_disk());
        let lines = said.lock().unwrap().clone();
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with("stopping the command: 2.0 GB left"))
        );
        assert_eq!(
            lines.iter().filter(|l| l.starts_with("disk low")).count(),
            1
        );
    }
}
