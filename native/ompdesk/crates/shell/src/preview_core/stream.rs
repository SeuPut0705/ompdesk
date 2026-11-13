//! One viewer's streamed preview page (`src/main/web/preview-stream.ts`): the offscreen page's paints become paced JPEG
//! frames, the viewer's polls are the acknowledgements, and the JS dialogs the page opens wait here for the viewer.
//!
//! This is the TypeScript's `PageStream` with the clock, the timers and the encoder taken out. It is a state machine:
//! the glue (the UI thread) owns the real timers and the frame encoder, feeds events in by calling the methods below
//! (each takes `now_ms` where time matters) and carries out the [`Effect`]s each call returns. Nothing here sleeps,
//! spawns or reads a clock, so the pacing rules replay under an explicit clock in `cargo test`.
//!
//! What the TypeScript did with promises and `await`, the machine does with state:
//!
//! * a `poll()` promise is a poll id the glue chose; the machine answers it with [`Effect::AnswerPoll`] (at most one
//!   poll waits, the newest supersedes an older, which is answered empty);
//! * `await image.jpeg()` is [`Effect::StartEncode`] and, later, [`PageStream::encoded`]. Only one encode runs at a
//!   time; everything that happens meanwhile (a refresh, a poll leaving, another poll arriving) is handled by the
//!   state the encode left behind, exactly as the awaiting `#kick` did;
//! * `setTimeout`/`clearTimeout` are [`Effect::ArmTimer`]/[`Effect::CancelTimer`]. Every arming carries a fresh
//!   `token`; [`PageStream::timer`] ignores a firing whose token is not the one armed (a timer the glue could not
//!   cancel in time is harmless).
//!
//! The glue also owns the page: it keeps the newest non-empty paint's image (a paint that [`PageStream::on_paint`] was
//! told is empty is not stored, the machine ignores it) and, when asked to encode, encodes the image it holds *at that
//! moment* (a later paint replaces its slot but not the running encode).

use std::collections::{BTreeMap, VecDeque};

use super::layout::Bounds;
use super::pacer::{FramePacer, Readiness, StreamProfile};

/// The longest a poll is held; a still page answers empty and the viewer asks again.
pub const POLL_MAX_WAIT_MS: f64 = 20_000.0;
/// A page nobody polls for this long stops painting until the next poll (a phone asleep or gone).
pub const IDLE_PAUSE_MS: f64 = 15_000.0;
/// An unanswered dialog is dismissed after this long: the page must not stay blocked on a phone that left.
pub const DIALOG_TIMEOUT_MS: f64 = 60_000.0;
/// A page that opens more dialogs than this many in the window is flooding the phone: the rest are dismissed unseen.
pub const DIALOG_FLOOD_COUNT: usize = 5;
/// The flood window (`DIALOG_FLOOD.windowMs`).
pub const DIALOG_FLOOD_WINDOW_MS: f64 = 10_000.0;

/// What the page's `alert`, `confirm` and `prompt` get back when nobody answered (`{ accept: false, text: null }`).
pub fn dismissed() -> DialogAnswer {
    DialogAnswer {
        accept: false,
        text: None,
    }
}

/// The surface the frames are for.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamGeometry {
    /// Where the frame sits in the viewer's surface, in CSS px.
    pub rect: Bounds,
    /// The widest a frame is sent: the surface's CSS width × the profile's pixel ratio.
    pub pixel_width: f64,
    pub profile: StreamProfile,
}

/// What a viewer's poll asks (`PreviewStreamPollRequest`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PollRequest {
    /// The last frame this viewer decoded; `None` after a reconnect or on the first poll.
    pub ack: Option<u64>,
    /// Longest hold in ms; `None` is [`POLL_MAX_WAIT_MS`]. Clamped to `0..=POLL_MAX_WAIT_MS`.
    pub wait: Option<f64>,
}

/// A frame for the viewer (`PreviewStreamFrame`, with the JPEG as bytes: the wire's base64 is the glue's job).
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    /// The pacer's number for it: the viewer's next `ack` names it.
    pub seq: u64,
    /// The tab the frame shows: a viewer drops a frame of a tab it left.
    pub tab: String,
    /// The image's pixels, as the encoder reported them.
    pub width: u32,
    pub height: u32,
    pub rect: Bounds,
    pub jpeg: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DialogKind {
    Alert,
    Confirm,
    Prompt,
}

/// A dialog the page opened (`DialogRequest`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialogRequest {
    pub kind: DialogKind,
    pub message: String,
    /// A prompt's default text.
    pub initial: Option<String>,
}

/// A dialog as the viewer's poll carries it (`PreviewStreamDialog`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamDialog {
    pub id: u64,
    pub kind: DialogKind,
    pub message: String,
    pub initial: Option<String>,
}

/// What the page's dialog gets back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialogAnswer {
    pub accept: bool,
    pub text: Option<String>,
}

/// What [`PageStream::open_dialog`] did with a dialog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opening {
    /// Queued for the viewer under this id: wait for [`Effect::AnswerDialog`] with it.
    Open(u64),
    /// Refused on the spot (the stream is disposed, or the page is flooding): the glue answers the page's dialog
    /// with [`dismissed`] itself. It took no id.
    Dismissed,
}

/// The stream's timers; one of each kind is armed at most (a dialog's timeout is one per dialog id).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Timer {
    /// The waiting poll's hold ran out: answer it empty.
    PollWait,
    /// Look again at what the pacer allows (call [`PageStream::timer`] when it fires).
    Schedule,
    /// Nobody polled for [`IDLE_PAUSE_MS`]: stop painting. The glue's timer must not keep the process alive.
    Idle,
    /// The dialog with this id was not answered in [`DIALOG_TIMEOUT_MS`].
    DialogTimeout(u64),
}

/// What the glue carries out, in order, after a call.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// `page.setFrameRate(fps)`.
    SetFrameRate(f64),
    /// Ask the page for a fresh paint of the whole page (`page.invalidate()`). Not emitted for a destroyed page.
    Invalidate,
    /// `page.setPainting(on)`: the page paints only while visible and not idle-paused.
    SetPainting(bool),
    /// Encode the image the glue holds as a JPEG at `quality`, scaled down to `max_width` when given (the 1.02 rule
    /// already applied; the glue rounds it to whole pixels as its encoder needs), then call
    /// [`PageStream::encoded`] with this `epoch`: with the bytes and size, or `None` when it failed. Never twice at
    /// once.
    StartEncode {
        quality: u8,
        max_width: Option<f64>,
        epoch: u64,
    },
    /// Answer the poll the glue numbered `id` (each id is answered exactly once).
    AnswerPoll {
        id: u64,
        frame: Option<Frame>,
        dialogs: Vec<StreamDialog>,
    },
    /// Answer the page's dialog (an id [`PageStream::open_dialog`] returned). Each id is answered at most once.
    AnswerDialog { id: u64, answer: DialogAnswer },
    /// Call [`PageStream::timer`]`(timer, token)` after `after_ms`. Replaces an armed timer of the same kind.
    ArmTimer {
        timer: Timer,
        token: u64,
        after_ms: f64,
    },
    /// Forget the armed timer of this kind.
    CancelTimer { timer: Timer },
}

/// The JPEG a successful encode made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Encoded {
    /// The size it came out at.
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

/// Frames the page painted, frames sent, bytes of JPEG sent, ms spent encoding, and the pacer's skips.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StreamStats {
    pub painted: u64,
    pub sent: u64,
    pub bytes: u64,
    pub encode_ms: f64,
    pub dropped: u64,
    pub lost: u64,
}

/// `Math.min(Math.max(0, wait ?? MAX), MAX)`; a NaN wait is what `setTimeout` makes of it, 1 ms.
fn hold_ms(wait: Option<f64>) -> f64 {
    let held = super::js::min(
        super::js::max(0.0, wait.unwrap_or(POLL_MAX_WAIT_MS)),
        POLL_MAX_WAIT_MS,
    );
    if held.is_nan() { 1.0 } else { held }
}

struct Waiter {
    id: u64,
    /// The token of its `PollWait` timer, `None` once that timer fired.
    timer: Option<u64>,
}

/// The encode running: what `#kick` held across its `await`.
struct Encoding {
    started_ms: f64,
    /// Dialogs the kick took off the queue before it started encoding; they go out with the frame.
    dialogs: Vec<StreamDialog>,
}

pub struct PageStream {
    tab: String,
    pacer: FramePacer,
    /// The viewer's one counter when several streams (one per tab) share it.
    next_seq: Option<Box<dyn FnMut() -> u64>>,
    geometry: StreamGeometry,
    /// Whether the glue holds a paint to encode: the size of the newest non-empty paint.
    latest: Option<(u32, u32)>,
    waiter: Option<Waiter>,
    schedule: Option<u64>,
    idle: Option<u64>,
    painting: bool,
    visible: bool,
    disposed: bool,
    destroyed: bool,
    encoding: Option<Encoding>,
    /// Counts the moments the frame being encoded stopped being current (`refresh`, `dispose`).
    epoch: u64,
    /// A frame the pacer counted as sent whose poll had gone: the next poll takes it.
    parked: Option<Frame>,
    /// Queued for the viewer's next poll. A dialog answered or timed out stays here until a poll takes it, as in the
    /// TypeScript (the viewer then answers a dialog already gone, which does nothing).
    dialogs: VecDeque<StreamDialog>,
    /// Open dialogs: id → the token of its timeout timer.
    pending: BTreeMap<u64, u64>,
    dialog_seq: u64,
    dialog_times: VecDeque<f64>,
    tokens: u64,
    painted: u64,
    sent: u64,
    bytes: u64,
    encode_ms: f64,
}

impl PageStream {
    /// A stream of `tab`'s page for `geometry`. `next_seq` numbers the frames from the viewer's one counter (a tab
    /// switch never reuses a number); `None` counts from 1 for this stream.
    pub fn new(
        tab: impl Into<String>,
        geometry: StreamGeometry,
        next_seq: Option<Box<dyn FnMut() -> u64>>,
    ) -> (Self, Vec<Effect>) {
        let mut stream = Self {
            tab: tab.into(),
            pacer: FramePacer::new(geometry.profile.max_fps),
            next_seq,
            latest: None,
            waiter: None,
            schedule: None,
            idle: None,
            painting: true,
            visible: true,
            disposed: false,
            destroyed: false,
            encoding: None,
            epoch: 0,
            parked: None,
            dialogs: VecDeque::new(),
            pending: BTreeMap::new(),
            dialog_seq: 0,
            dialog_times: VecDeque::new(),
            tokens: 0,
            painted: 0,
            sent: 0,
            bytes: 0,
            encode_ms: 0.0,
            geometry,
        };
        let mut fx = vec![Effect::SetFrameRate(stream.geometry.profile.max_fps)];
        stream.restart_idle(&mut fx);
        (stream, fx)
    }

    /// The page's paint arrived: `width`×`height` pixels, `empty` when the image has nothing in it (a paint between a
    /// resize and the next layout), which is ignored. After [`dispose`](Self::dispose) paints are ignored too (the
    /// TypeScript unsubscribed).
    pub fn on_paint(&mut self, now_ms: f64, width: u32, height: u32, empty: bool) -> Vec<Effect> {
        let mut fx = Vec::new();
        if self.disposed || empty {
            return fx;
        }
        self.painted += 1;
        self.latest = Some((width, height));
        self.pacer.mark_dirty();
        self.arm(now_ms, &mut fx);
        fx
    }

    /// Answer a waiting poll empty now (the viewer moved to another page: it must poll that one instead).
    pub fn release(&mut self) -> Vec<Effect> {
        let mut fx = Vec::new();
        self.release_waiter(&mut fx, None, Vec::new());
        fx
    }

    /// The viewer's surface changed (a rotation, the keyboard, another viewport): the next frame is for the new size.
    pub fn configure(&mut self, geometry: StreamGeometry) -> Vec<Effect> {
        let resized = geometry.pixel_width != self.geometry.pixel_width
            || geometry.rect.width != self.geometry.rect.width
            || geometry.rect.height != self.geometry.rect.height
            || geometry.rect.x != self.geometry.rect.x
            || geometry.rect.y != self.geometry.rect.y;
        let fps = geometry.profile.max_fps;
        self.geometry = geometry;
        self.pacer.set_max_fps(fps);
        let mut fx = vec![Effect::SetFrameRate(fps)];
        // The image kept is of the old size; a new one is coming once the page repaints at the new one.
        if resized {
            self.refresh_into(&mut fx);
        }
        fx
    }

    /// The panel is covered or closed: the page stops painting and no frame goes out.
    pub fn set_visible(&mut self, visible: bool) -> Vec<Effect> {
        let mut fx = Vec::new();
        if visible == self.visible {
            return fx;
        }
        self.visible = visible;
        self.apply_painting(&mut fx);
        if visible {
            self.refresh_into(&mut fx);
        }
        fx
    }

    /// The page's webContents is gone (`isDestroyed()`): no more invalidating, painting changes or encoding. The
    /// stream still answers polls, as the TypeScript did.
    pub fn page_destroyed(&mut self) {
        self.destroyed = true;
    }

    /// The viewer needs a frame now (a navigation, a tab switch, a resize, a new viewer): repaint, skip the interval.
    pub fn refresh(&mut self) -> Vec<Effect> {
        let mut fx = Vec::new();
        self.refresh_into(&mut fx);
        fx
    }

    fn refresh_into(&mut self, fx: &mut Vec<Effect>) {
        if self.disposed {
            return;
        }
        self.latest = None;
        self.parked = None;
        self.epoch += 1;
        self.pacer.mark_urgent();
        if !self.destroyed {
            fx.push(Effect::Invalidate);
        }
    }

    /// The viewer acknowledges `request.ack` and waits for the next frame or dialog. `id` is the glue's number for
    /// this poll; it is answered by exactly one [`Effect::AnswerPoll`] carrying it (at once when disposed).
    pub fn poll(&mut self, now_ms: f64, id: u64, request: PollRequest) -> Vec<Effect> {
        let mut fx = Vec::new();
        if self.disposed {
            fx.push(Effect::AnswerPoll {
                id,
                frame: None,
                dialogs: Vec::new(),
            });
            return fx;
        }
        self.restart_idle(&mut fx);
        if !self.painting {
            // A viewer is back after an idle pause: paint again and send what the page looks like now.
            self.painting = true;
            self.apply_painting(&mut fx);
            self.refresh_into(&mut fx);
        }
        self.pacer.ack(now_ms, request.ack);
        self.release_waiter(&mut fx, None, Vec::new());
        let token = self.next_token();
        fx.push(Effect::ArmTimer {
            timer: Timer::PollWait,
            token,
            after_ms: hold_ms(request.wait),
        });
        self.waiter = Some(Waiter {
            id,
            timer: Some(token),
        });
        self.kick(now_ms, &mut fx);
        fx
    }

    /// A timer the machine armed fired. A `token` that is not the armed one is ignored.
    pub fn timer(&mut self, now_ms: f64, timer: Timer, token: u64) -> Vec<Effect> {
        let mut fx = Vec::new();
        match timer {
            Timer::PollWait => {
                if let Some(waiter) = &mut self.waiter
                    && waiter.timer == Some(token)
                {
                    waiter.timer = None;
                    self.release_waiter(&mut fx, None, Vec::new());
                }
            }
            Timer::Schedule => {
                if self.schedule == Some(token) {
                    self.schedule = None;
                    self.kick(now_ms, &mut fx);
                }
            }
            Timer::Idle => {
                if self.idle == Some(token) {
                    self.idle = None;
                    self.painting = false;
                    self.apply_painting(&mut fx);
                }
            }
            Timer::DialogTimeout(id) => {
                if self.pending.get(&id) == Some(&token) {
                    self.pending.remove(&id);
                    fx.push(Effect::AnswerDialog {
                        id,
                        answer: dismissed(),
                    });
                    self.pacer.mark_urgent();
                }
            }
        }
        fx
    }

    /// The encode [`Effect::StartEncode`] asked for finished: `result` is its JPEG, `None` when it failed (the page
    /// went away: the next paint is tried instead). `epoch` is the one `StartEncode` carried. A frame whose epoch is
    /// no longer current (a refresh or dispose came meanwhile) is dropped. The encode's time is `now_ms` minus the
    /// moment it started.
    pub fn encoded(&mut self, now_ms: f64, epoch: u64, result: Option<Encoded>) -> Vec<Effect> {
        let mut fx = Vec::new();
        let Some(encoding) = self.encoding.take() else {
            return fx;
        };
        let frame = result.and_then(|encoded| {
            self.encode_ms += now_ms - encoding.started_ms;
            // The page navigated or the viewer left while the shell encoded: the frame shows what is gone.
            if self.disposed || epoch != self.epoch {
                return None;
            }
            self.bytes += encoded.bytes.len() as u64;
            self.sent += 1;
            let seq = match self.next_seq.as_mut() {
                Some(next) => self.pacer.sent_numbered(now_ms, next()),
                None => self.pacer.sent(now_ms),
            };
            Some(Frame {
                seq,
                tab: self.tab.clone(),
                width: encoded.width,
                height: encoded.height,
                rect: self.geometry.rect,
                jpeg: encoded.bytes,
            })
        });
        self.complete(now_ms, &mut fx, frame, encoding.dialogs);
        fx
    }

    /// The page opened a dialog and is blocked until [`Effect::AnswerDialog`] names the returned id (never twice, never
    /// after [`dispose`](Self::dispose)).
    pub fn open_dialog(&mut self, now_ms: f64, request: DialogRequest) -> (Opening, Vec<Effect>) {
        let mut fx = Vec::new();
        while let Some(&first) = self.dialog_times.front()
            && now_ms - first > DIALOG_FLOOD_WINDOW_MS
        {
            self.dialog_times.pop_front();
        }
        if self.disposed || self.dialog_times.len() >= DIALOG_FLOOD_COUNT {
            return (Opening::Dismissed, fx);
        }
        self.dialog_times.push_back(now_ms);
        self.dialog_seq += 1;
        let id = self.dialog_seq;
        let token = self.next_token();
        fx.push(Effect::ArmTimer {
            timer: Timer::DialogTimeout(id),
            token,
            after_ms: DIALOG_TIMEOUT_MS,
        });
        self.pending.insert(id, token);
        self.dialogs.push_back(StreamDialog {
            id,
            kind: request.kind,
            message: request.message,
            initial: request.initial,
        });
        self.arm(now_ms, &mut fx);
        (Opening::Open(id), fx)
    }

    /// The viewer's answer (or a dismissal); an unknown or answered id does nothing.
    pub fn answer_dialog(&mut self, id: u64, answer: DialogAnswer) -> Vec<Effect> {
        let mut fx = Vec::new();
        self.answer_dialog_into(&mut fx, id, answer);
        fx
    }

    fn answer_dialog_into(&mut self, fx: &mut Vec<Effect>, id: u64, answer: DialogAnswer) {
        if self.pending.remove(&id).is_none() {
            return;
        }
        fx.push(Effect::CancelTimer {
            timer: Timer::DialogTimeout(id),
        });
        fx.push(Effect::AnswerDialog { id, answer });
        // The page continues and repaints; the viewer's frame must not wait for the interval.
        self.pacer.mark_urgent();
    }

    pub fn stats(&self) -> StreamStats {
        let skipped = self.pacer.skipped();
        StreamStats {
            painted: self.painted,
            sent: self.sent,
            bytes: self.bytes,
            encode_ms: self.encode_ms,
            dropped: skipped.dropped,
            lost: skipped.lost,
        }
    }

    /// The viewer left: every poll answers empty, every open dialog is dismissed, a running encode is dropped when
    /// it finishes. Idempotent.
    pub fn dispose(&mut self) -> Vec<Effect> {
        let mut fx = Vec::new();
        if self.disposed {
            return fx;
        }
        self.disposed = true;
        cancel(&mut fx, &mut self.schedule, Timer::Schedule);
        cancel(&mut fx, &mut self.idle, Timer::Idle);
        self.release_waiter(&mut fx, None, Vec::new());
        let open: Vec<u64> = self.pending.keys().copied().collect();
        for id in open {
            self.answer_dialog_into(&mut fx, id, dismissed());
        }
        self.latest = None;
        self.parked = None;
        self.epoch += 1;
        self.dialogs.clear();
        fx
    }

    fn next_token(&mut self) -> u64 {
        self.tokens += 1;
        self.tokens
    }

    fn apply_painting(&mut self, fx: &mut Vec<Effect>) {
        if !self.destroyed {
            fx.push(Effect::SetPainting(self.painting && self.visible));
        }
    }

    fn restart_idle(&mut self, fx: &mut Vec<Effect>) {
        cancel(fx, &mut self.idle, Timer::Idle);
        let token = self.next_token();
        self.idle = Some(token);
        fx.push(Effect::ArmTimer {
            timer: Timer::Idle,
            token,
            after_ms: IDLE_PAUSE_MS,
        });
    }

    /// Answer the waiting poll (the newest request supersedes an older one: a reconnected viewer has no use for it).
    /// Whether there was one; with none the frame and dialogs are dropped, so a caller that must keep them checks
    /// `waiter` first.
    fn release_waiter(
        &mut self,
        fx: &mut Vec<Effect>,
        frame: Option<Frame>,
        dialogs: Vec<StreamDialog>,
    ) -> bool {
        let Some(waiter) = self.waiter.take() else {
            return false;
        };
        if waiter.timer.is_some() {
            fx.push(Effect::CancelTimer {
                timer: Timer::PollWait,
            });
        }
        fx.push(Effect::AnswerPoll {
            id: waiter.id,
            frame,
            dialogs,
        });
        true
    }

    /// Takes what may go now and gives it to the waiting poll; with nothing to send, waits for the pacer.
    fn kick(&mut self, now_ms: f64, fx: &mut Vec<Effect>) {
        let dialogs: Vec<StreamDialog> = self.dialogs.drain(..).collect();
        if let Some(parked) = self.parked.take() {
            return self.complete(now_ms, fx, Some(parked), dialogs);
        }
        if self.visible
            && let Some(start) = self.encode_request(now_ms)
        {
            self.encoding = Some(Encoding {
                started_ms: now_ms,
                dialogs,
            });
            fx.push(start);
            return;
        }
        self.complete(now_ms, fx, None, dialogs);
    }

    /// The encode to start now, if the pacer lets one go: the newest paint, no encode already running.
    fn encode_request(&mut self, now_ms: f64) -> Option<Effect> {
        let (width, _) = self.latest?;
        if self.destroyed || self.encoding.is_some() {
            return None;
        }
        if !matches!(self.pacer.readiness(now_ms), Readiness::Ready) {
            return None;
        }
        let cap = self.geometry.pixel_width;
        let wide = cap > 0.0 && f64::from(width) > cap * 1.02;
        Some(Effect::StartEncode {
            quality: self.pacer.quality(),
            max_width: wide.then_some(cap),
            epoch: self.epoch,
        })
    }

    /// What `#kick` does once it has what a poll may carry (a frame, queued dialogs, or nothing).
    fn complete(
        &mut self,
        now_ms: f64,
        fx: &mut Vec<Effect>,
        frame: Option<Frame>,
        dialogs: Vec<StreamDialog>,
    ) {
        if frame.is_none() && dialogs.is_empty() {
            self.arm(now_ms, fx);
            return;
        }
        if self.waiter.is_some() {
            self.release_waiter(fx, frame, dialogs);
            return;
        }
        // The poll left while the frame was being made: what it took is kept for the next one.
        for dialog in dialogs.into_iter().rev() {
            self.dialogs.push_front(dialog);
        }
        self.parked = frame.or_else(|| self.parked.take());
    }

    /// A poll is waiting: deliver when the pacer allows, else look again when it will.
    fn arm(&mut self, now_ms: f64, fx: &mut Vec<Effect>) {
        if self.waiter.is_none() || self.disposed || self.encoding.is_some() {
            return;
        }
        cancel(fx, &mut self.schedule, Timer::Schedule);
        if !self.dialogs.is_empty() {
            self.kick(now_ms, fx);
            return;
        }
        // A destroyed page never encodes again: looking again would only spin (the TypeScript's 1 ms timer did).
        if self.destroyed {
            return;
        }
        match self.pacer.readiness(now_ms) {
            // Off the paint's own call: the page's next paint and the socket's work are not held behind the encode.
            Readiness::Ready if self.latest.is_some() && self.visible => self.arm_schedule(fx, 0.0),
            Readiness::Wait { ms } => self.arm_schedule(fx, ms),
            // `Blocked` and `Idle`: the viewer's ack or the page's next paint arms again.
            _ => {}
        }
    }

    fn arm_schedule(&mut self, fx: &mut Vec<Effect>, after_ms: f64) {
        let token = self.next_token();
        self.schedule = Some(token);
        fx.push(Effect::ArmTimer {
            timer: Timer::Schedule,
            token,
            after_ms,
        });
    }
}

/// `clearTimeout`: forget the armed timer in `slot`, telling the glue only when there was one.
fn cancel(fx: &mut Vec<Effect>, slot: &mut Option<u64>, timer: Timer) {
    if slot.take().is_some() {
        fx.push(Effect::CancelTimer { timer });
    }
}

/// The cases of `preview-stream.test.ts`, driven by a fake glue: an explicit clock, the timers the machine arms, a
/// fake encoder that completes at once (or when released) and a fake page that counts what it is told. Everything the
/// TypeScript's `FakePage` recorded is an [`Effect`] here.
#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};

    use super::super::js;
    use super::super::pacer::PHONE_PROFILE;
    use super::*;

    fn geometry() -> StreamGeometry {
        StreamGeometry {
            rect: Bounds {
                x: 0.0,
                y: 0.0,
                width: 390.0,
                height: 844.0,
            },
            pixel_width: 780.0,
            profile: PHONE_PROFILE,
        }
    }

    /// A paint's image: its size, and whether its encode waits for `release_slow` (`SlowImage`).
    #[derive(Clone, Copy)]
    struct Image {
        width: u32,
        height: u32,
        slow: bool,
    }

    /// An encode the machine asked for, with the image the glue held when it asked.
    struct Job {
        epoch: u64,
        quality: u8,
        max_width: Option<f64>,
        image: Image,
    }

    /// One viewer that polls again as soon as a frame comes (the TypeScript's `viewer()` loop) and stops at an empty
    /// answer.
    struct Viewer {
        current: u64,
        started: f64,
        times: Vec<f64>,
    }

    type Answer = (Option<Frame>, Vec<StreamDialog>);

    struct Glue {
        now: f64,
        stream: PageStream,
        armed: Vec<(f64, u64, Timer, u64)>,
        order: u64,
        frame_rate: f64,
        invalidations: usize,
        painting: Vec<bool>,
        image: Option<Image>,
        held: Vec<Job>,
        encodes: usize,
        widths: Vec<Option<f64>>,
        fail_next: bool,
        answers: HashMap<u64, Answer>,
        dialog_answers: Vec<(u64, DialogAnswer)>,
        next_poll: u64,
        viewer: Option<Viewer>,
    }

    impl Glue {
        fn new() -> Self {
            Self::with(geometry(), None)
        }

        fn with(geometry: StreamGeometry, next_seq: Option<Box<dyn FnMut() -> u64>>) -> Self {
            let (stream, fx) = PageStream::new("tab-1", geometry, next_seq);
            let mut glue = Self {
                now: 1_000_000.0,
                stream,
                armed: Vec::new(),
                order: 0,
                frame_rate: 0.0,
                invalidations: 0,
                painting: Vec::new(),
                image: None,
                held: Vec::new(),
                encodes: 0,
                widths: Vec::new(),
                fail_next: false,
                answers: HashMap::new(),
                dialog_answers: Vec::new(),
                next_poll: 0,
                viewer: None,
            };
            glue.run(fx);
            glue
        }

        /// Carry out effects in order; an encode finishes after the effects of the call that asked for it (the
        /// `await` of a microtask), and what it answers is carried out in turn.
        fn run(&mut self, fx: Vec<Effect>) {
            let mut queue: VecDeque<Effect> = fx.into();
            let mut jobs: VecDeque<Job> = VecDeque::new();
            loop {
                while let Some(effect) = queue.pop_front() {
                    match effect {
                        Effect::SetFrameRate(fps) => self.frame_rate = fps,
                        Effect::Invalidate => self.invalidations += 1,
                        Effect::SetPainting(on) => self.painting.push(on),
                        Effect::StartEncode {
                            quality,
                            max_width,
                            epoch,
                        } => {
                            let image = self
                                .image
                                .expect("an encode is asked for only while a paint is held");
                            self.widths.push(max_width);
                            let job = Job {
                                epoch,
                                quality,
                                max_width,
                                image,
                            };
                            if image.slow {
                                self.held.push(job);
                            } else {
                                jobs.push_back(job);
                            }
                        }
                        Effect::AnswerPoll { id, frame, dialogs } => {
                            assert!(!self.answers.contains_key(&id), "poll {id} answered twice");
                            let next = match &mut self.viewer {
                                Some(viewer) if viewer.current == id => {
                                    frame.as_ref().map(|frame| {
                                        viewer.times.push(self.now - viewer.started);
                                        self.next_poll += 1;
                                        viewer.current = self.next_poll;
                                        (self.next_poll, frame.seq)
                                    })
                                }
                                _ => None,
                            };
                            self.answers.insert(id, (frame, dialogs));
                            if let Some((next, ack)) = next {
                                let request = PollRequest {
                                    ack: Some(ack),
                                    wait: Some(1000.0),
                                };
                                queue.extend(self.stream.poll(self.now, next, request));
                            }
                        }
                        Effect::AnswerDialog { id, answer } => {
                            self.dialog_answers.push((id, answer))
                        }
                        Effect::ArmTimer {
                            timer,
                            token,
                            after_ms,
                        } => {
                            self.armed.retain(|armed| armed.2 != timer);
                            self.order += 1;
                            self.armed
                                .push((self.now + after_ms, self.order, timer, token));
                        }
                        Effect::CancelTimer { timer } => {
                            self.armed.retain(|armed| armed.2 != timer)
                        }
                    }
                }
                let Some(job) = jobs.pop_front() else { break };
                queue.extend(self.finish(job));
            }
        }

        /// `FakeImage.jpeg`: scaled down to the width asked when that is narrower, `width × height × quality / 1000`
        /// bytes.
        fn finish(&mut self, job: Job) -> Vec<Effect> {
            let image = job.image;
            let result = if std::mem::take(&mut self.fail_next) {
                None
            } else {
                self.encodes += 1;
                let width = match job.max_width {
                    Some(cap) if cap < f64::from(image.width) => cap,
                    _ => f64::from(image.width),
                };
                let height = js::round(f64::from(image.height) * width / f64::from(image.width));
                let len = js::round(width * height * (f64::from(job.quality) / 1000.0));
                Some(Encoded {
                    width: width as u32,
                    height: height as u32,
                    bytes: vec![1; len as usize],
                })
            };
            self.stream.encoded(self.now, job.epoch, result)
        }

        /// `SlowImage.release()`: the shell finishes the encodes it was holding.
        fn release_slow(&mut self) {
            for job in std::mem::take(&mut self.held) {
                let fx = self.finish(job);
                self.run(fx);
            }
        }

        fn paint_image(&mut self, image: Image) {
            self.image = Some(image);
            let fx = self
                .stream
                .on_paint(self.now, image.width, image.height, false);
            self.run(fx);
        }

        fn paint_size(&mut self, width: u32, height: u32) {
            self.paint_image(Image {
                width,
                height,
                slow: false,
            });
        }

        fn paint(&mut self) {
            self.paint_size(780, 1688);
        }

        fn poll(&mut self, ack: Option<u64>, wait: Option<f64>) -> u64 {
            self.next_poll += 1;
            let id = self.next_poll;
            let fx = self.stream.poll(self.now, id, PollRequest { ack, wait });
            self.run(fx);
            id
        }

        fn answered(&self, id: u64) -> bool {
            self.answers.contains_key(&id)
        }

        fn answer(&self, id: u64) -> &Answer {
            self.answers
                .get(&id)
                .unwrap_or_else(|| panic!("poll {id} is still waiting"))
        }

        fn frame(&self, id: u64) -> &Frame {
            self.answer(id)
                .0
                .as_ref()
                .expect("the poll carries a frame")
        }

        fn nothing(&self, id: u64) -> bool {
            *self.answer(id) == (None, Vec::new())
        }

        /// `vi.advanceTimersByTimeAsync`: timers fire in due order (arming order for a tie), the clock at each.
        fn advance(&mut self, ms: f64) {
            let target = self.now + ms;
            loop {
                let next = self
                    .armed
                    .iter()
                    .filter(|armed| armed.0 <= target)
                    .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
                    .copied();
                let Some((due, order, timer, token)) = next else {
                    break;
                };
                self.armed.retain(|armed| armed.1 != order);
                self.now = self.now.max(due);
                let fx = self.stream.timer(self.now, timer, token);
                self.run(fx);
            }
            self.now = target;
        }

        fn refresh(&mut self) {
            let fx = self.stream.refresh();
            self.run(fx);
        }

        fn configure(&mut self, geometry: StreamGeometry) {
            let fx = self.stream.configure(geometry);
            self.run(fx);
        }

        fn set_visible(&mut self, visible: bool) {
            let fx = self.stream.set_visible(visible);
            self.run(fx);
        }

        fn dispose(&mut self) {
            let fx = self.stream.dispose();
            self.run(fx);
        }

        fn open(&mut self, kind: DialogKind, message: &str, initial: Option<&str>) -> Opening {
            let request = DialogRequest {
                kind,
                message: message.into(),
                initial: initial.map(Into::into),
            };
            let (opening, fx) = self.stream.open_dialog(self.now, request);
            self.run(fx);
            opening
        }

        fn alert(&mut self, message: &str) -> Opening {
            self.open(DialogKind::Alert, message, None)
        }

        fn answer_dialog(&mut self, id: u64, accept: bool, text: Option<&str>) {
            let fx = self.stream.answer_dialog(
                id,
                DialogAnswer {
                    accept,
                    text: text.map(Into::into),
                },
            );
            self.run(fx);
        }
    }

    // --- PageStream

    #[test]
    fn sets_the_pages_frame_rate_from_the_profile() {
        assert_eq!(Glue::new().frame_rate, 12.0);
    }

    #[test]
    fn answers_a_poll_with_the_paint_that_arrives_as_a_jpeg_frame_for_the_surface() {
        let mut glue = Glue::new();
        let poll = glue.poll(None, None);
        glue.advance(20.0);
        glue.paint();
        assert!(
            !glue.answered(poll),
            "the paint's own call only arms a timer"
        );
        glue.advance(5.0);
        let (frame, dialogs) = glue.answer(poll);
        assert!(dialogs.is_empty());
        let frame = frame.as_ref().unwrap();
        assert_eq!(
            (frame.seq, frame.tab.as_str(), frame.width, frame.height),
            (1, "tab-1", 780, 1688)
        );
        assert_eq!(frame.rect, geometry().rect);
        assert!(!frame.jpeg.is_empty());
    }

    #[test]
    fn sends_nothing_for_a_still_page_the_poll_is_held_then_answers_empty_after_the_wait() {
        let mut glue = Glue::new();
        let poll = glue.poll(None, Some(5000.0));
        glue.advance(4999.0);
        assert!(!glue.answered(poll));
        glue.advance(2.0);
        assert!(glue.nothing(poll));
        assert_eq!(glue.encodes, 0);
    }

    #[test]
    fn caps_a_hold_at_the_maximum_whatever_the_viewer_asked_for() {
        let mut glue = Glue::new();
        let poll = glue.poll(None, Some(10.0 * 60_000.0));
        glue.advance(POLL_MAX_WAIT_MS - 1.0);
        assert!(!glue.answered(poll));
        glue.advance(2.0);
        assert!(glue.answered(poll));
    }

    #[test]
    fn sends_no_second_frame_before_the_first_is_acknowledged_however_often_the_page_paints() {
        let mut glue = Glue::new();
        glue.paint();
        let first = glue.poll(None, Some(100.0));
        assert_eq!(glue.frame(first).seq, 1);
        // Acknowledging frame 0 acknowledges nothing: frame 1 is still in flight.
        let held = glue.poll(Some(0), Some(1500.0));
        for _ in 0..20 {
            glue.paint();
            glue.advance(50.0);
        }
        glue.advance(600.0);
        assert!(glue.nothing(held));
        assert_eq!(glue.encodes, 1);
    }

    #[test]
    fn drops_a_frame_whose_page_navigated_while_the_shell_was_encoding_it() {
        let mut glue = Glue::new();
        glue.paint_image(Image {
            width: 780,
            height: 1688,
            slow: true,
        });
        let poll = glue.poll(None, Some(5000.0));
        glue.advance(10.0);
        glue.refresh();
        glue.release_slow();
        glue.advance(10.0);
        glue.paint_size(390, 844);
        glue.advance(100.0);
        let frame = glue.frame(poll);
        assert_eq!((frame.seq, frame.width, frame.height), (1, 390, 844));
    }

    #[test]
    fn keeps_a_frame_whose_poll_left_while_it_was_being_encoded_for_the_next_poll() {
        let mut glue = Glue::new();
        glue.paint_image(Image {
            width: 780,
            height: 1688,
            slow: true,
        });
        let first = glue.poll(None, Some(50.0));
        glue.advance(60.0);
        assert!(glue.nothing(first));
        glue.release_slow();
        glue.advance(10.0);
        let next = glue.poll(None, Some(50.0));
        let frame = glue.frame(next);
        assert_eq!((frame.seq, frame.width), (1, 780));
    }

    #[test]
    fn sends_the_next_paint_once_the_poll_names_the_last_frame() {
        let mut glue = Glue::new();
        glue.paint();
        let first = glue.poll(None, None);
        assert_eq!(glue.frame(first).seq, 1);
        glue.paint();
        let next = glue.poll(Some(1), Some(3000.0));
        // Held until a full frame interval has passed since the last send (83 ms at 12 fps).
        glue.advance(50.0);
        glue.advance(0.0);
        assert!(!glue.answered(next));
        glue.advance(50.0);
        assert_eq!(glue.frame(next).seq, 2);
    }

    #[test]
    fn never_sends_more_than_12_frames_in_a_second_of_constant_painting_and_encodes_only_what_it_sends()
     {
        let mut glue = Glue::new();
        glue.next_poll += 1;
        let first = glue.next_poll;
        glue.viewer = Some(Viewer {
            current: first,
            started: glue.now,
            times: Vec::new(),
        });
        let fx = glue.stream.poll(
            glue.now,
            first,
            PollRequest {
                ack: None,
                wait: Some(1000.0),
            },
        );
        glue.run(fx);
        // A page painting every 4 ms (250 paints a second) for 1.3 s.
        for _ in (0..1300).step_by(4) {
            glue.paint();
            glue.advance(4.0);
        }
        glue.dispose();
        let times = &glue.viewer.as_ref().unwrap().times;
        let in_first_second = times.iter().filter(|time| **time < 1000.0).count();
        assert!(
            in_first_second <= 12,
            "{in_first_second} frames in a second"
        );
        assert!(
            in_first_second >= 10,
            "{in_first_second} frames in a second"
        );
        assert_eq!(glue.encodes, times.len());
        let stats = glue.stream.stats();
        assert!(stats.painted > 300);
        assert_eq!(stats.sent, times.len() as u64);
        assert!(stats.dropped > 250);
    }

    #[test]
    fn scales_a_frame_wider_than_the_surface_asks_down_to_its_pixel_width() {
        let mut glue = Glue::new();
        glue.paint_size(1170, 2532);
        let poll = glue.poll(None, None);
        let frame = glue.frame(poll);
        assert_eq!((frame.width, frame.height), (780, 1688));
        assert_eq!(glue.widths, [Some(780.0)]);
    }

    #[test]
    fn refreshing_asks_the_page_for_a_new_paint_and_the_next_frame_skips_the_interval() {
        let mut glue = Glue::new();
        glue.paint();
        let first = glue.poll(None, None);
        assert_eq!(glue.frame(first).seq, 1);
        glue.refresh();
        assert_eq!(glue.invalidations, 1);
        glue.paint();
        let next = glue.poll(Some(1), Some(1000.0));
        glue.advance(5.0);
        // Well inside the 83 ms interval, and still sent.
        assert_eq!(glue.frame(next).seq, 2);
    }

    #[test]
    fn a_size_change_repaints_the_same_size_does_not() {
        let mut glue = Glue::new();
        glue.configure(geometry());
        assert_eq!(glue.invalidations, 0);
        let mut narrower = geometry();
        narrower.pixel_width = 600.0;
        narrower.rect.width = 300.0;
        glue.configure(narrower);
        assert_eq!(glue.invalidations, 1);
    }

    #[test]
    fn stops_painting_while_hidden_and_sends_no_frame_and_resumes_with_a_fresh_one() {
        let mut glue = Glue::new();
        glue.set_visible(false);
        assert_eq!(glue.painting.last(), Some(&false));
        glue.paint();
        let poll = glue.poll(None, Some(2000.0));
        glue.advance(2001.0);
        assert!(glue.answered(poll));
        assert_eq!(glue.stream.stats().sent, 0);
        glue.set_visible(true);
        assert_eq!(glue.painting.last(), Some(&true));
        assert_eq!(glue.invalidations, 1);
    }

    #[test]
    fn pauses_painting_after_a_quiet_spell_and_resumes_on_the_next_poll() {
        let mut glue = Glue::new();
        glue.advance(IDLE_PAUSE_MS + 1.0);
        assert_eq!(glue.painting.last(), Some(&false));
        let poll = glue.poll(None, Some(100.0));
        assert_eq!(glue.painting.last(), Some(&true));
        assert_eq!(glue.invalidations, 1);
        glue.paint();
        glue.advance(5.0);
        assert_eq!(glue.frame(poll).seq, 1);
    }

    #[test]
    fn a_newer_poll_supersedes_an_older_one() {
        let mut glue = Glue::new();
        let old = glue.poll(None, Some(5000.0));
        let current = glue.poll(None, Some(100.0));
        assert!(glue.nothing(old));
        assert!(!glue.answered(current));
        glue.advance(101.0);
        assert!(glue.nothing(current));
    }

    #[test]
    fn a_page_that_is_gone_answers_every_poll_empty() {
        let mut glue = Glue::new();
        let poll = glue.poll(None, Some(5000.0));
        glue.dispose();
        assert!(glue.nothing(poll));
        let later = glue.poll(None, None);
        assert!(glue.nothing(later));
    }

    // --- PageStream dialogs

    #[test]
    fn wakes_the_poll_with_the_dialog_while_the_page_is_blocked_and_hands_the_viewers_answer_back()
    {
        let mut glue = Glue::new();
        let poll = glue.poll(None, Some(10_000.0));
        assert_eq!(
            glue.open(DialogKind::Prompt, "Name?", Some("x")),
            Opening::Open(1)
        );
        let (frame, dialogs) = glue.answer(poll);
        assert!(frame.is_none());
        let want = StreamDialog {
            id: 1,
            kind: DialogKind::Prompt,
            message: "Name?".into(),
            initial: Some("x".into()),
        };
        assert_eq!(dialogs, &[want]);
        glue.answer_dialog(1, true, Some("Ada"));
        assert_eq!(
            glue.dialog_answers,
            [(
                1,
                DialogAnswer {
                    accept: true,
                    text: Some("Ada".into())
                }
            )]
        );
    }

    #[test]
    fn queues_a_dialog_opened_between_polls_for_the_next_one() {
        let mut glue = Glue::new();
        assert_eq!(glue.alert("Hi"), Opening::Open(1));
        let poll = glue.poll(None, None);
        let (_, dialogs) = glue.answer(poll);
        assert_eq!(
            dialogs
                .iter()
                .map(|dialog| dialog.message.as_str())
                .collect::<Vec<_>>(),
            ["Hi"]
        );
        let id = dialogs[0].id;
        glue.answer_dialog(id, true, None);
        assert_eq!(
            glue.dialog_answers,
            [(
                1,
                DialogAnswer {
                    accept: true,
                    text: None
                }
            )]
        );
    }

    #[test]
    fn ignores_an_answer_to_an_unknown_or_answered_dialog() {
        let mut glue = Glue::new();
        assert_eq!(
            glue.open(DialogKind::Confirm, "Sure?", None),
            Opening::Open(1)
        );
        glue.answer_dialog(99, true, None);
        glue.answer_dialog(1, false, None);
        glue.answer_dialog(1, true, None);
        assert_eq!(glue.dialog_answers, [(1, dismissed())]);
    }

    #[test]
    fn dismisses_a_dialog_nobody_answers_so_the_page_is_not_blocked_for_good() {
        let mut glue = Glue::new();
        assert_eq!(
            glue.open(DialogKind::Confirm, "Sure?", None),
            Opening::Open(1)
        );
        glue.advance(DIALOG_TIMEOUT_MS - 1.0);
        assert!(glue.dialog_answers.is_empty());
        glue.advance(2.0);
        assert_eq!(glue.dialog_answers, [(1, dismissed())]);
        // An answer that comes after the timeout does nothing.
        glue.answer_dialog(1, true, None);
        assert_eq!(glue.dialog_answers.len(), 1);
    }

    #[test]
    fn dismisses_every_open_dialog_when_the_stream_ends() {
        let mut glue = Glue::new();
        assert_eq!(glue.alert("Hi"), Opening::Open(1));
        assert_eq!(glue.alert("There"), Opening::Open(2));
        glue.dispose();
        assert_eq!(glue.dialog_answers, [(1, dismissed()), (2, dismissed())]);
        assert!(glue.armed.is_empty(), "no timer outlives the stream");
        assert_eq!(glue.alert("Late"), Opening::Dismissed);
    }

    #[test]
    fn dismisses_the_rest_of_a_flood_unseen() {
        let mut glue = Glue::new();
        let openings: Vec<Opening> = (0..DIALOG_FLOOD_COUNT + 3)
            .map(|index| glue.alert(&format!("#{index}")))
            .collect();
        let opened = openings
            .iter()
            .filter(|opening| matches!(opening, Opening::Open(_)))
            .count();
        assert_eq!((opened, openings.len() - opened), (DIALOG_FLOOD_COUNT, 3));
        let poll = glue.poll(None, None);
        let ids: Vec<u64> = glue.answer(poll).1.iter().map(|dialog| dialog.id).collect();
        assert_eq!(ids.len(), DIALOG_FLOOD_COUNT);
        for id in ids {
            glue.answer_dialog(id, true, None);
        }
        assert_eq!(
            glue.dialog_answers
                .iter()
                .filter(|(_, answer)| answer.accept)
                .count(),
            DIALOG_FLOOD_COUNT
        );
    }

    // --- Beyond the TypeScript's cases: the rules its tests do not reach, and the machine's own seams

    #[test]
    fn the_flood_window_slides_a_refused_dialog_does_not_count() {
        let mut glue = Glue::new();
        for index in 0..DIALOG_FLOOD_COUNT {
            assert_eq!(glue.alert("a"), Opening::Open(index as u64 + 1));
        }
        glue.advance(DIALOG_FLOOD_WINDOW_MS);
        assert_eq!(
            glue.alert("b"),
            Opening::Dismissed,
            "exactly the window old is still inside it"
        );
        glue.advance(1.0);
        assert_eq!(
            glue.alert("c"),
            Opening::Open(6),
            "the refused one took no id"
        );
    }

    #[test]
    fn a_dialog_answered_before_the_poll_is_still_delivered_as_in_the_typescript() {
        let mut glue = Glue::new();
        glue.alert("Hi");
        glue.answer_dialog(1, true, None);
        let poll = glue.poll(None, None);
        assert_eq!(glue.answer(poll).1.len(), 1);
        // The viewer's answer now is to a dialog already gone.
        glue.answer_dialog(1, false, None);
        assert_eq!(glue.dialog_answers.len(), 1);
    }

    #[test]
    fn answering_a_dialog_lets_the_next_frame_skip_the_interval() {
        let mut glue = Glue::new();
        glue.paint();
        let first = glue.poll(None, None);
        assert_eq!(glue.frame(first).seq, 1);
        glue.alert("Hi");
        glue.answer_dialog(1, true, None);
        glue.paint();
        let next = glue.poll(Some(1), Some(1000.0));
        // The dialog is still queued, so it rides with the frame, which is not held to the interval.
        assert_eq!(glue.frame(next).seq, 2);
    }

    #[test]
    fn the_width_cap_applies_only_above_one_point_oh_two_times_the_surface() {
        let mut glue = Glue::new();
        glue.paint_size(795, 1000);
        let at_limit = glue.poll(None, None);
        assert_eq!(glue.frame(at_limit).width, 795);
        let mut glue = Glue::new();
        glue.paint_size(796, 1000);
        let over = glue.poll(None, None);
        assert_eq!(glue.frame(over).width, 780);
        assert_eq!(glue.widths, [Some(780.0)]);
        let mut no_cap = geometry();
        no_cap.pixel_width = 0.0;
        let mut glue = Glue::with(no_cap, None);
        glue.paint_size(5000, 100);
        let uncapped = glue.poll(None, None);
        assert_eq!(glue.frame(uncapped).width, 5000);
    }

    #[test]
    fn an_empty_paint_is_ignored() {
        let mut glue = Glue::new();
        let poll = glue.poll(None, Some(500.0));
        assert!(glue.stream.on_paint(glue.now, 0, 0, true).is_empty());
        assert_eq!(glue.stream.stats().painted, 0);
        assert!(glue.armed.iter().all(|armed| armed.2 != Timer::Schedule));
        glue.advance(501.0);
        assert!(glue.nothing(poll));
    }

    #[test]
    fn a_failed_encode_is_tried_again_on_the_next_look() {
        let mut glue = Glue::new();
        glue.paint();
        glue.fail_next = true;
        let poll = glue.poll(None, Some(1000.0));
        assert!(!glue.answered(poll));
        assert_eq!(
            (glue.stream.stats().sent, glue.stream.stats().encode_ms),
            (0, 0.0)
        );
        glue.advance(0.0);
        assert_eq!(glue.frame(poll).seq, 1);
    }

    #[test]
    fn a_stream_disposed_during_an_encode_drops_its_frame_and_answers_nothing_twice() {
        let mut glue = Glue::new();
        glue.paint_image(Image {
            width: 780,
            height: 1688,
            slow: true,
        });
        let poll = glue.poll(None, Some(5000.0));
        glue.dispose();
        assert!(glue.nothing(poll));
        glue.release_slow();
        assert_eq!(glue.stream.stats().sent, 0);
        let later = glue.poll(None, None);
        assert!(glue.nothing(later));
        assert!(glue.stream.on_paint(glue.now, 780, 1688, false).is_empty());
    }

    #[test]
    fn counts_the_time_a_slow_encode_took_even_when_its_frame_is_dropped() {
        let mut glue = Glue::new();
        glue.paint_image(Image {
            width: 780,
            height: 1688,
            slow: true,
        });
        glue.poll(None, Some(5000.0));
        glue.advance(30.0);
        glue.refresh();
        glue.release_slow();
        let stats = glue.stream.stats();
        assert_eq!((stats.sent, stats.bytes, stats.encode_ms), (0, 0, 30.0));
    }

    #[test]
    fn stats_count_what_was_sent() {
        let mut glue = Glue::new();
        glue.paint();
        let poll = glue.poll(None, None);
        let stats = glue.stream.stats();
        assert_eq!(
            (stats.painted, stats.sent, stats.bytes),
            (1, 1, glue.frame(poll).jpeg.len() as u64)
        );
    }

    #[test]
    fn numbers_frames_from_the_viewers_counter_when_given_one() {
        let mut counter = 41;
        let mut glue = Glue::with(
            geometry(),
            Some(Box::new(move || {
                counter += 1;
                counter
            })),
        );
        glue.paint();
        let first = glue.poll(None, None);
        assert_eq!(glue.frame(first).seq, 42);
        glue.paint();
        glue.advance(100.0);
        let next = glue.poll(Some(42), Some(1000.0));
        assert_eq!(glue.frame(next).seq, 43);
    }

    #[test]
    fn a_timer_with_a_stale_token_does_nothing() {
        let mut glue = Glue::new();
        let poll = glue.poll(None, Some(5000.0));
        let (_, _, timer, token) = *glue
            .armed
            .iter()
            .find(|armed| armed.2 == Timer::PollWait)
            .unwrap();
        assert!(glue.stream.timer(glue.now, timer, token + 100).is_empty());
        assert!(glue.stream.timer(glue.now, Timer::Schedule, 1).is_empty());
        assert!(
            glue.stream
                .timer(glue.now, Timer::DialogTimeout(7), 1)
                .is_empty()
        );
        assert!(!glue.answered(poll));
    }

    #[test]
    fn releasing_answers_the_waiting_poll_empty_and_cancels_its_timer() {
        let mut glue = Glue::new();
        let poll = glue.poll(None, Some(5000.0));
        let fx = glue.stream.release();
        glue.run(fx);
        assert!(glue.nothing(poll));
        assert!(glue.armed.iter().all(|armed| armed.2 != Timer::PollWait));
        assert!(glue.stream.release().is_empty());
    }

    #[test]
    fn a_destroyed_page_is_not_invalidated_or_encoded() {
        let mut glue = Glue::new();
        glue.paint();
        glue.stream.page_destroyed();
        glue.refresh();
        assert_eq!(glue.invalidations, 0);
        glue.paint();
        let poll = glue.poll(None, Some(100.0));
        glue.advance(101.0);
        assert!(glue.nothing(poll));
        assert_eq!(glue.encodes, 0);
    }

    #[test]
    fn a_frame_not_acknowledged_in_time_is_given_up_and_the_next_one_goes() {
        let mut glue = Glue::new();
        glue.paint();
        let first = glue.poll(None, None);
        assert_eq!(glue.frame(first).seq, 1);
        glue.paint();
        let held = glue.poll(Some(0), Some(10_000.0));
        glue.advance(2000.0);
        assert!(!glue.answered(held));
        // The pacer's ack timeout (3 s) frees it: the schedule is re-armed by the page's next paint.
        glue.advance(1100.0);
        glue.paint();
        glue.advance(0.0);
        assert_eq!(glue.frame(held).seq, 2);
        assert_eq!(glue.stream.stats().lost, 1);
    }
}
