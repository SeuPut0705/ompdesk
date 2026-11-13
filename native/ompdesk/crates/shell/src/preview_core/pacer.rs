//! The frame pacer of a viewer's streamed preview page (port of `src/main/web/preview-pacer.ts`, design §7.1, the
//! counterpart of CDP's screencast ack).
//!
//! The page paints whenever it changes; a phone cannot take that. The pacer decides when one frame may be encoded
//! and sent, so a still page costs nothing and a busy one never queues:
//!
//! - nothing is encoded until the viewer acknowledged the frame before it (`ack`), so a slow link or a slow decoder
//!   skips frames instead of buffering them; only the newest paint is ever kept;
//! - frames are at least `1000 / max_fps` apart (12 on a phone), measured from the last send;
//! - a frame whose ack never comes (the page reconnected) is given up after [`ACK_TIMEOUT_MS`];
//! - a navigation or a size change marks the next frame urgent: it skips the interval (never the ack);
//! - the JPEG quality follows the measured ack round trip: a fast link affords detail, a slow one smaller frames.
//!
//! The clock is an argument (`now_ms`, any monotonic millisecond count) so the rules run without one.

use super::js;

/// A frame whose ack has not come this long after it was sent is taken as lost.
pub const ACK_TIMEOUT_MS: f64 = 3000.0;
pub const QUALITY_MIN: u8 = 50;
pub const QUALITY_MAX: u8 = 80;

/// What a viewer's screen gets: frame rate and pixel density.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StreamProfile {
    pub max_fps: f64,
    /// The pixel ratio frames are drawn at, at most.
    pub dpr: f64,
}

/// A phone: at most 12 fps and 2× pixels (a 3× phone is encoded at 2×: 194 KB a frame against 312 KB).
pub const PHONE_PROFILE: StreamProfile = StreamProfile {
    max_fps: 12.0,
    dpr: 2.0,
};
/// A tablet's frame has more pixels, so each gets fewer of them per CSS pixel.
pub const TABLET_PROFILE: StreamProfile = StreamProfile {
    max_fps: 12.0,
    dpr: 1.5,
};
/// CSS width below which a viewer is a phone (the shell's own `PHONE_QUERY` width).
pub const PHONE_MAX_CSS_WIDTH: f64 = 600.0;

/// The profile for a surface `css_width` wide on a screen with `device_ratio` pixels per CSS pixel.
pub fn stream_profile(css_width: f64, device_ratio: f64) -> StreamProfile {
    let base = if css_width < PHONE_MAX_CSS_WIDTH {
        PHONE_PROFILE
    } else {
        TABLET_PROFILE
    };
    let ratio = if device_ratio.is_finite() && device_ratio > 0.0 {
        device_ratio
    } else {
        1.0
    };
    StreamProfile {
        max_fps: base.max_fps,
        dpr: js::min(ratio, base.dpr),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Readiness {
    /// Encode and send now.
    Ready,
    /// Dirty, but sent too recently: look again in `ms` (whole milliseconds, as `Math.ceil` gives).
    Wait { ms: f64 },
    /// The last frame is not acknowledged yet.
    Blocked,
    /// Nothing painted since the last frame.
    Idle,
}

/// Frames replaced by a newer paint before they were sent, and frames whose ack never came.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Skipped {
    pub dropped: u64,
    pub lost: u64,
}

#[derive(Clone, Copy, Debug)]
struct InFlight {
    seq: u64,
    at: f64,
}

#[derive(Debug)]
pub struct FramePacer {
    max_fps: f64,
    dirty: bool,
    urgent: bool,
    seq: u64,
    /// The frame sent and not yet acknowledged, with when.
    in_flight: Option<InFlight>,
    last_sent_at: f64,
    /// Smoothed ack round trip in ms; `None` before the first ack.
    rtt: Option<f64>,
    dropped: u64,
    lost: u64,
}

impl FramePacer {
    pub fn new(max_fps: f64) -> Self {
        Self {
            max_fps,
            dirty: false,
            urgent: false,
            seq: 0,
            in_flight: None,
            last_sent_at: f64::NEG_INFINITY,
            rtt: None,
            dropped: 0,
            lost: 0,
        }
    }

    pub fn set_max_fps(&mut self, fps: f64) {
        self.max_fps = js::max(1.0, fps);
    }

    /// The page painted: a newer picture than the last frame exists. A paint over an unsent one drops that one.
    pub fn mark_dirty(&mut self) {
        if self.dirty {
            self.dropped += 1;
        }
        self.dirty = true;
    }

    /// The next frame must not wait for the interval (a navigation, a resize, a new viewer).
    pub fn mark_urgent(&mut self) {
        self.dirty = true;
        self.urgent = true;
    }

    pub fn skipped(&self) -> Skipped {
        Skipped {
            dropped: self.dropped,
            lost: self.lost,
        }
    }

    pub fn dirty(&self) -> bool {
        self.dirty
    }

    pub fn last_seq(&self) -> u64 {
        self.seq
    }

    /// May a frame go out at `now_ms`? Giving up on an ack that is overdue happens here.
    pub fn readiness(&mut self, now_ms: f64) -> Readiness {
        if !self.dirty {
            return Readiness::Idle;
        }
        if let Some(flight) = self.in_flight {
            if now_ms - flight.at < ACK_TIMEOUT_MS {
                return Readiness::Blocked;
            }
            // The viewer reconnected or died: its ack is not coming.
            self.in_flight = None;
            self.lost += 1;
        }
        if self.urgent {
            return Readiness::Ready;
        }
        let wait = self.last_sent_at + 1000.0 / self.max_fps - now_ms;
        if wait > 0.0 {
            Readiness::Wait { ms: wait.ceil() }
        } else {
            Readiness::Ready
        }
    }

    /// A frame is being sent: its number, and the paint it carries is no longer waiting.
    pub fn sent(&mut self, now_ms: f64) -> u64 {
        self.sent_numbered(now_ms, self.seq + 1)
    }

    /// As [`FramePacer::sent`] with a number the caller chose: several pacers share one viewer (one per tab), and an
    /// ack never names another tab's frame.
    pub fn sent_numbered(&mut self, now_ms: f64, seq: u64) -> u64 {
        self.seq = seq;
        self.in_flight = Some(InFlight { seq, at: now_ms });
        self.last_sent_at = now_ms;
        self.dirty = false;
        self.urgent = false;
        seq
    }

    /// The viewer decoded `seq`. An ack of an older frame (or of none: a fresh poll after a reconnect, `None`) frees
    /// the pacer without a measurement.
    pub fn ack(&mut self, now_ms: f64, seq: Option<u64>) {
        let Some(flight) = self.in_flight else { return };
        if seq.is_none_or(|seq| seq >= flight.seq) {
            if seq == Some(flight.seq) {
                let rtt = now_ms - flight.at;
                self.rtt = Some(self.rtt.map_or(rtt, |smoothed| smoothed * 0.7 + rtt * 0.3));
            }
            self.in_flight = None;
        }
    }

    /// JPEG quality for the next frame: the measured round trip decides how much detail the link affords.
    pub fn quality(&self) -> u8 {
        match self.rtt {
            None => QUALITY_MAX - 5,
            Some(rtt) if rtt < 120.0 => QUALITY_MAX - 5,
            Some(rtt) if rtt < 300.0 => 65,
            Some(rtt) if rtt < 600.0 => 58,
            Some(_) => QUALITY_MIN,
        }
    }

    /// Smoothed ack round trip in ms, for reports.
    pub fn round_trip(&self) -> Option<f64> {
        self.rtt
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::super::captured;
    use super::*;

    /// Whole numbers and fractions compare as numbers (the table writes `84`, `serde_json` builds `84.0`).
    fn same(got: &Value, want: &Value) -> bool {
        match (got, want) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
            }
            _ => got == want,
        }
    }

    fn readiness_json(readiness: Readiness) -> Value {
        match readiness {
            Readiness::Ready => json!({ "state": "ready" }),
            Readiness::Wait { ms } => json!({ "state": "wait", "ms": ms }),
            Readiness::Blocked => json!({ "state": "blocked" }),
            Readiness::Idle => json!({ "state": "idle" }),
        }
    }

    #[test]
    fn replays_the_captured_pacer_rows() {
        let rows = captured("pacer")["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 5);
        let mut steps_run = 0;
        for row in rows {
            let mut pacer = FramePacer::new(row["maxFps"].as_f64().unwrap());
            let steps = row["steps"].as_array().unwrap();
            let results = row["results"].as_array().unwrap();
            assert_eq!(steps.len(), results.len());
            for (step, want) in steps.iter().zip(results) {
                let now = step["at"].as_f64().unwrap();
                let arg = &step["arg"];
                let got = match step["op"].as_str().unwrap() {
                    "readiness" => readiness_json(pacer.readiness(now)),
                    "markDirty" => {
                        pacer.mark_dirty();
                        Value::Null
                    }
                    "markUrgent" => {
                        pacer.mark_urgent();
                        Value::Null
                    }
                    "sent" => json!(pacer.sent(now)),
                    "ack" => {
                        pacer.ack(now, arg.as_u64());
                        Value::Null
                    }
                    "quality" => json!(pacer.quality()),
                    "skipped" => {
                        json!({ "dropped": pacer.skipped().dropped, "lost": pacer.skipped().lost })
                    }
                    "roundTrip" => json!(pacer.round_trip()),
                    "setMaxFps" => {
                        pacer.set_max_fps(arg.as_f64().unwrap());
                        Value::Null
                    }
                    op => panic!("{op}"),
                };
                assert!(same(&got, want), "{step}: got {got}, want {want}");
                steps_run += 1;
            }
        }
        assert_eq!(steps_run, 69);
    }

    #[test]
    fn replays_the_captured_profiles() {
        let rows = captured("pacer")["profiles"].as_array().unwrap();
        assert_eq!(rows.len(), 48);
        for row in rows {
            let dpr = match &row["dpr"] {
                Value::String(text) => text.parse::<f64>().unwrap_or_else(|_| panic!("{text}")),
                number => number.as_f64().unwrap(),
            };
            let profile = stream_profile(row["width"].as_f64().unwrap(), dpr);
            assert!(
                same(
                    &json!({ "maxFps": profile.max_fps, "dpr": profile.dpr }),
                    &row["out"]
                ),
                "{row}"
            );
        }
    }

    /// A pacer on a clock the test moves, starting where the TypeScript's tests start.
    struct Clocked {
        pacer: FramePacer,
        now: f64,
    }

    impl Clocked {
        fn new(max_fps: f64) -> Self {
            Self {
                pacer: FramePacer::new(max_fps),
                now: 10_000.0,
            }
        }

        fn advance(&mut self, ms: f64) {
            self.now += ms;
        }

        fn readiness(&mut self) -> Readiness {
            self.pacer.readiness(self.now)
        }

        fn sent(&mut self) -> u64 {
            self.pacer.sent(self.now)
        }

        fn ack(&mut self, seq: Option<u64>) {
            self.pacer.ack(self.now, seq);
        }
    }

    #[test]
    fn sends_nothing_while_the_page_is_still() {
        let mut p = Clocked::new(12.0);
        assert_eq!(p.readiness(), Readiness::Idle);
        p.advance(60_000.0);
        assert_eq!(p.readiness(), Readiness::Idle);
    }

    #[test]
    fn sends_the_first_paint_at_once_and_then_holds_the_next_until_its_ack() {
        let mut p = Clocked::new(12.0);
        p.pacer.mark_dirty();
        assert_eq!(p.readiness(), Readiness::Ready);
        assert_eq!(p.sent(), 1);
        p.pacer.mark_dirty();
        p.advance(500.0);
        assert_eq!(p.readiness(), Readiness::Blocked);
        p.ack(Some(1));
        assert_eq!(p.readiness(), Readiness::Ready);
    }

    #[test]
    fn keeps_frames_at_least_one_interval_apart_even_when_the_ack_is_instant() {
        let mut p = Clocked::new(12.0);
        p.pacer.mark_dirty();
        p.sent();
        p.ack(Some(1));
        p.pacer.mark_dirty();
        assert_eq!(p.readiness(), Readiness::Wait { ms: 84.0 });
        p.advance(40.0);
        assert_eq!(p.readiness(), Readiness::Wait { ms: 44.0 });
        p.advance(44.0);
        assert_eq!(p.readiness(), Readiness::Ready);
    }

    #[test]
    fn never_exceeds_the_profiles_rate_over_a_second_of_constant_painting() {
        for fps in [12.0, 5.0, 20.0] {
            let mut p = Clocked::new(fps);
            let mut sent = 0.0;
            for _ in 0..1000 {
                p.pacer.mark_dirty();
                if p.readiness() == Readiness::Ready {
                    p.sent();
                    let seq = p.pacer.last_seq();
                    p.ack(Some(seq));
                    sent += 1.0;
                }
                p.advance(1.0);
            }
            assert!(sent <= fps, "{fps}: {sent}");
            assert!(sent >= fps - 1.0, "{fps}: {sent}");
        }
    }

    #[test]
    fn keeps_only_the_newest_paint_painting_over_an_unsent_one_counts_a_dropped_frame() {
        let mut p = Clocked::new(12.0);
        for _ in 0..3 {
            p.pacer.mark_dirty();
        }
        assert_eq!(p.pacer.skipped().dropped, 2);
        p.sent();
        assert!(!p.pacer.dirty());
    }

    #[test]
    fn gives_up_on_an_ack_that_never_comes_so_a_reconnected_viewer_is_fed_again() {
        let mut p = Clocked::new(12.0);
        p.pacer.mark_dirty();
        p.sent();
        p.pacer.mark_dirty();
        p.advance(ACK_TIMEOUT_MS - 1.0);
        assert_eq!(p.readiness(), Readiness::Blocked);
        p.advance(2.0);
        assert_eq!(p.readiness(), Readiness::Ready);
        assert_eq!(p.pacer.skipped().lost, 1);
    }

    #[test]
    fn a_poll_with_no_ack_frees_the_frame_in_flight() {
        let mut p = Clocked::new(12.0);
        p.pacer.mark_dirty();
        p.sent();
        p.pacer.mark_dirty();
        p.ack(None);
        assert_ne!(p.readiness(), Readiness::Blocked);
        assert_eq!(p.pacer.round_trip(), None);
    }

    #[test]
    fn ignores_an_ack_of_an_older_frame() {
        let mut p = Clocked::new(12.0);
        p.pacer.mark_dirty();
        p.sent();
        p.ack(Some(1));
        p.advance(100.0);
        p.pacer.mark_dirty();
        p.sent();
        p.pacer.mark_dirty();
        p.ack(Some(1));
        assert_eq!(p.readiness(), Readiness::Blocked);
    }

    #[test]
    fn an_urgent_frame_skips_the_interval_but_never_the_ack() {
        let mut p = Clocked::new(12.0);
        p.pacer.mark_dirty();
        p.sent();
        p.pacer.mark_urgent();
        assert_eq!(p.readiness(), Readiness::Blocked);
        p.ack(Some(1));
        assert_eq!(p.readiness(), Readiness::Ready);
    }

    #[test]
    fn lowers_the_jpeg_quality_as_the_viewers_round_trip_grows_and_recovers_when_it_shrinks() {
        let mut p = Clocked::new(12.0);
        let round_trip = |p: &mut Clocked, ms: f64| {
            p.pacer.mark_urgent();
            let seq = p.sent();
            p.advance(ms);
            p.ack(Some(seq));
        };
        assert_eq!(p.pacer.quality(), QUALITY_MAX - 5);
        for _ in 0..12 {
            round_trip(&mut p, 900.0);
        }
        assert_eq!(p.pacer.quality(), QUALITY_MIN);
        for _ in 0..24 {
            round_trip(&mut p, 40.0);
        }
        assert_eq!(p.pacer.quality(), QUALITY_MAX - 5);
    }

    #[test]
    fn numbers_frames_as_the_caller_says_when_pacers_share_a_viewer() {
        let mut p = Clocked::new(12.0);
        p.pacer.mark_dirty();
        assert_eq!(p.pacer.sent_numbered(p.now, 41), 41);
        assert_eq!(p.pacer.last_seq(), 41);
        p.ack(Some(40));
        assert_eq!(p.readiness(), Readiness::Idle);
        p.pacer.mark_dirty();
        assert_eq!(p.readiness(), Readiness::Blocked);
        p.ack(Some(41));
        assert_eq!(p.pacer.round_trip(), Some(0.0));
    }

    #[test]
    fn caps_a_phone_at_12_fps_and_2x_pixels_whatever_its_density() {
        assert_eq!(
            stream_profile(390.0, 3.0),
            StreamProfile {
                max_fps: PHONE_PROFILE.max_fps,
                dpr: 2.0
            }
        );
        assert_eq!(
            stream_profile(390.0, 1.0),
            StreamProfile {
                max_fps: 12.0,
                dpr: 1.0
            }
        );
        assert_eq!(stream_profile(599.0, 2.0).max_fps, 12.0);
    }

    #[test]
    fn gives_a_tablet_fewer_pixels_per_css_pixel_and_never_more_than_12_fps() {
        assert_eq!(
            stream_profile(820.0, 2.0),
            StreamProfile {
                max_fps: TABLET_PROFILE.max_fps,
                dpr: 1.5
            }
        );
        assert_eq!(
            stream_profile(1024.0, 1.0),
            StreamProfile {
                max_fps: 12.0,
                dpr: 1.0
            }
        );
    }

    #[test]
    fn ignores_a_density_that_is_not_a_number() {
        assert_eq!(stream_profile(390.0, f64::NAN).dpr, 1.0);
        assert_eq!(stream_profile(390.0, 0.0).dpr, 1.0);
    }
}
