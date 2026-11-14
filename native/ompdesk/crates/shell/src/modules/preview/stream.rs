//! A paired viewer's streamed page (multi-viewer-web › Phone preview): the offscreen page's paints become paced JPEG
//! frames, the viewer's polls are the acknowledgements, its gestures and keys reach the page as trusted browser input,
//! and the page's JS dialogs wait for the viewer. The rules are `preview_core::stream::PageStream`'s (a state machine
//! with no clock, timer or encoder); this file owns the real timers (`ui::post_delayed`), the JPEG encode on a worker
//! thread, and the mapping of the viewer's input to CEF's `send_*_event` on the offscreen browser host.

use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use base64::Engine;
use cef::*;
use serde_json::{Value, json};
use shell_core::frame::{Format, encode};
use shell_core::preview_core::dialog::{self, DIALOG_CHANNEL};
use shell_core::preview_core::input::{
    self, InputEvent, InputMapper, InputSequence, Modifier, MouseButton as Button, SequenceStep,
    Surface,
};
use shell_core::preview_core::js;
use shell_core::preview_core::layout::Bounds;
use shell_core::preview_core::pacer::stream_profile;
use shell_core::preview_core::page_tools::PAGE_WORLD;
use shell_core::preview_core::stream::{
    self as machine, DialogAnswer, DialogRequest, Effect, Encoded, Frame, Opening, PageStream,
    PollRequest, StreamDialog, StreamGeometry, Timer,
};

use super::host;
use super::page;
use crate::host::Call;
use crate::state;
use crate::wc as pages;

/// A viewer's poll for a page that does not exist yet (the panel asks before its first layout) is answered after this.
const NO_PAGE_RETRY_MS: i64 = 500;
/// The most selected text a viewer is sent (UTF-16 units).
const SELECTION_MAX_CHARS: usize = 100_000;

const SHIFT: u32 = 1 << 1;
const CONTROL: u32 = 1 << 2;
const ALT: u32 = 1 << 3;
const LEFT_BUTTON: u32 = 1 << 4;
const RIGHT_BUTTON: u32 = 1 << 6;
const COMMAND: u32 = 1 << 7;

/// A dialog the page opened and the answer it waits for.
struct Waiter {
    request: dialog::DialogRequest,
    answer: Box<dyn FnOnce(Value)>,
}

/// One viewer page's stream: the machine, the polls and dialogs it numbered, and the viewer's input in progress.
pub(super) struct Stream {
    machine: PageStream,
    polls: HashMap<u64, Call>,
    next_poll: u64,
    dialogs: HashMap<u64, Waiter>,
    mapper: InputMapper,
    sequence: InputSequence,
    steps: VecDeque<SequenceStep>,
    /// A round trip or an insert is running: the steps behind it wait.
    busy: bool,
    focused: bool,
    /// Window DIPs per frame CSS px (`place`): a wheel delta in frame px is scaled by it.
    pub(super) scale: f64,
}

/// The surface a stream has before its panel's first layout: a phone-sized frame.
fn default_geometry() -> StreamGeometry {
    StreamGeometry {
        rect: Bounds {
            x: 0.0,
            y: 0.0,
            width: 390.0,
            height: 844.0,
        },
        pixel_width: 780.0,
        profile: stream_profile(390.0, 2.0),
    }
}

/// The stream of tab `tab`; the viewer's frames share the one counter `frames`. Run the effects once the page exists.
pub(super) fn create(tab: &str, frames: &Rc<Cell<u64>>) -> (Stream, Vec<Effect>) {
    let counter = frames.clone();
    let next = Box::new(move || {
        counter.set(counter.get() + 1);
        counter.get()
    });
    let (machine, effects) = PageStream::new(tab, default_geometry(), Some(next));
    let stream = Stream {
        machine,
        polls: HashMap::new(),
        next_poll: 0,
        dialogs: HashMap::new(),
        mapper: InputMapper::new(),
        sequence: InputSequence::default(),
        steps: VecDeque::new(),
        busy: false,
        focused: false,
        scale: 1.0,
    };
    (stream, effects)
}

/// Feeds the machine and carries out what it asks.
fn drive(wc_id: u64, f: impl FnOnce(&mut PageStream, f64) -> Vec<Effect>) {
    let now = host::clock_ms();
    let effects = host::with_stream(wc_id, |s| f(&mut s.machine, now)).unwrap_or_default();
    run(wc_id, effects);
}

pub(super) fn configure(wc_id: u64, geometry: StreamGeometry) {
    drive(wc_id, move |m, _| m.configure(geometry));
}

pub(super) fn set_visible(wc_id: u64, visible: bool) {
    drive(wc_id, move |m, _| m.set_visible(visible));
}

pub(super) fn refresh(wc_id: u64) {
    drive(wc_id, |m, _| m.refresh());
}

/// The viewer moved to another page: its poll held on this one is answered empty.
pub(super) fn release(wc_id: u64) {
    drive(wc_id, |m, _| m.release());
}

pub(super) fn dispose(wc_id: u64) {
    drive(wc_id, |m, _| m.dispose());
}

pub(super) fn page_destroyed(wc_id: u64) {
    host::with_stream(wc_id, |s| s.machine.page_destroyed());
}

/// The page painted (its pixels are in its entry).
pub(super) fn painted(wc_id: u64) {
    let size =
        state::wc(wc_id).and_then(|e| e.borrow().painted.as_ref().map(|p| (p.width, p.height)));
    let Some((width, height)) = size else { return };
    drive(wc_id, move |m, now| {
        m.on_paint(now, width as u32, height as u32, false)
    });
}

/// Carries out the machine's effects in order.
pub(super) fn run(wc_id: u64, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::SetFrameRate(fps) => {
                page::set_frame_rate(wc_id, fps.round().clamp(1.0, 60.0) as i32)
            }
            Effect::Invalidate => page::invalidate(wc_id),
            Effect::SetPainting(on) => page::set_painting(wc_id, on),
            Effect::StartEncode {
                quality,
                max_width,
                epoch,
            } => start_encode(wc_id, quality, max_width, epoch),
            Effect::AnswerPoll { id, frame, dialogs } => answer_poll(wc_id, id, frame, &dialogs),
            Effect::AnswerDialog { id, answer } => answer_page_dialog(wc_id, id, answer),
            Effect::ArmTimer {
                timer,
                token,
                after_ms,
            } => arm(wc_id, timer, token, after_ms),
            // A firing whose token is no longer the armed one is ignored by the machine.
            Effect::CancelTimer { .. } => {}
        }
    }
}

fn arm(wc_id: u64, timer: Timer, token: u64, after_ms: f64) {
    crate::ui::post_delayed(after_ms.max(0.0).ceil() as i64, move || {
        drive(wc_id, move |m, now| m.timer(now, timer, token));
    });
}

// ------------------------------------------------------------------ frames

fn start_encode(wc_id: u64, quality: u8, max_width: Option<f64>, epoch: u64) {
    let painted = state::wc(wc_id).and_then(|e| {
        e.borrow()
            .painted
            .as_ref()
            .map(|p| (p.bgra.clone(), p.width, p.height))
    });
    let Some((bgra, width, height)) = painted else {
        return crate::ui::post(move || finished(wc_id, epoch, None));
    };
    let target = max_width.map(|w| js::round(w).max(1.0) as u32);
    // Encoding is work for a thread of its own: the UI thread keeps painting.
    let spawned = std::thread::Builder::new()
        .name("preview-encode".into())
        .spawn(move || {
            let result = encode(
                &bgra,
                width as u32,
                height as u32,
                Format::Jpeg,
                quality,
                target,
            )
            .ok()
            .map(|(bytes, width, height)| Encoded {
                width,
                height,
                bytes,
            });
            crate::ui::post(move || finished(wc_id, epoch, result));
        });
    if spawned.is_err() {
        crate::ui::post(move || finished(wc_id, epoch, None));
    }
}

fn finished(wc_id: u64, epoch: u64, result: Option<Encoded>) {
    drive(wc_id, move |m, now| m.encoded(now, epoch, result));
}

fn kind_name(kind: machine::DialogKind) -> &'static str {
    match kind {
        machine::DialogKind::Alert => "alert",
        machine::DialogKind::Confirm => "confirm",
        machine::DialogKind::Prompt => "prompt",
    }
}

fn dialog_json(dialog: &StreamDialog) -> Value {
    json!({ "id": dialog.id, "kind": kind_name(dialog.kind), "message": dialog.message, "initial": dialog.initial })
}

fn frame_json(frame: &Frame) -> Value {
    json!({
        "seq": frame.seq,
        "tab": frame.tab,
        "width": frame.width,
        "height": frame.height,
        "rect": { "x": frame.rect.x, "y": frame.rect.y, "width": frame.rect.width, "height": frame.rect.height },
        "jpeg": base64::engine::general_purpose::STANDARD.encode(&frame.jpeg),
    })
}

fn answer_poll(wc_id: u64, id: u64, frame: Option<Frame>, dialogs: &[StreamDialog]) {
    let Some(call) = host::with_stream(wc_id, |s| s.polls.remove(&id)).flatten() else {
        return;
    };
    call.ok(json!({
        "frame": frame.as_ref().map(frame_json),
        "dialogs": dialogs.iter().map(dialog_json).collect::<Vec<_>>(),
    }));
}

/// `preview.poll`: the viewer acknowledges the last frame and waits for the next frame or dialog.
pub(super) fn poll(call: Call) {
    let Some(owner) = host::owner_of(&call.params) else {
        return call.err("invalid", "Invalid preview owner");
    };
    let request = PollRequest {
        ack: call.params.get("ack").and_then(Value::as_u64),
        wait: call.params.get("wait").and_then(Value::as_f64),
    };
    let Some(page) = host::streamed_page(owner.key) else {
        // The panel polls before its first layout made the page: say nothing happened, a moment from now.
        if owner.win_id.is_none() {
            crate::ui::post_delayed(NO_PAGE_RETRY_MS, move || {
                call.ok(json!({ "frame": null, "dialogs": [] }));
            });
        } else {
            call.err("failed", "No streamed preview page");
        }
        return;
    };
    let wc_id = page.borrow().wc_id;
    let id = host::with_stream(wc_id, |s| {
        s.next_poll += 1;
        s.polls.insert(s.next_poll, call);
        s.next_poll
    });
    let Some(id) = id else { return };
    drive(wc_id, move |m, now| m.poll(now, id, request));
}

// ------------------------------------------------------------------ dialogs

fn machine_request(request: &dialog::DialogRequest) -> DialogRequest {
    DialogRequest {
        kind: match request.kind {
            dialog::DialogKind::Alert => machine::DialogKind::Alert,
            dialog::DialogKind::Confirm => machine::DialogKind::Confirm,
            dialog::DialogKind::Prompt => machine::DialogKind::Prompt,
        },
        message: request.message.clone(),
        initial: request.initial.clone(),
    }
}

fn return_value(request: &dialog::DialogRequest, answer: &DialogAnswer) -> Value {
    let answer = dialog::DialogAnswer {
        accept: answer.accept,
        text: answer.text.clone(),
    };
    dialog::dialog_return_value(request, &answer).to_json()
}

/// The dialog preload's `__ompdeskSendSync`: a streamed page's `alert`, `confirm` or `prompt`, which blocks the page
/// until the viewer answers (or dismisses it). Any other page, channel or payload gets `null`, at once.
pub(super) fn sync_call(wc_id: u64, channel: &str, payload: Value, answer: Box<dyn FnOnce(Value)>) {
    let request = (channel == DIALOG_CHANNEL)
        .then(|| dialog::parse_request(&payload).ok())
        .flatten();
    let now = host::clock_ms();
    let opened = request.as_ref().and_then(|request| {
        host::with_stream(wc_id, |s| {
            s.machine.open_dialog(now, machine_request(request))
        })
    });
    let (Some(request), Some((opening, effects))) = (request, opened) else {
        return answer(Value::Null);
    };
    match opening {
        Opening::Open(id) => {
            host::with_stream(wc_id, |s| s.dialogs.insert(id, Waiter { request, answer }));
            run(wc_id, effects);
        }
        Opening::Dismissed => {
            run(wc_id, effects);
            answer(return_value(&request, &machine::dismissed()));
        }
    }
}

fn answer_page_dialog(wc_id: u64, id: u64, answer: DialogAnswer) {
    let Some(waiter) = host::with_stream(wc_id, |s| s.dialogs.remove(&id)).flatten() else {
        return;
    };
    (waiter.answer)(return_value(&waiter.request, &answer));
}

/// `preview.dialogAnswer`.
pub(super) fn answer_dialog(call: Call) {
    let Some(owner) = host::owner_of(&call.params) else {
        return call.err("invalid", "Invalid preview owner");
    };
    let Some(page) = host::streamed_page(owner.key) else {
        return call.err("failed", "No streamed preview page");
    };
    let id = call.params.get("id").and_then(Value::as_u64).unwrap_or(0);
    let answer = DialogAnswer {
        accept: call
            .params
            .get("accept")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        text: call
            .params
            .get("text")
            .and_then(Value::as_str)
            .map(String::from),
    };
    let wc_id = page.borrow().wc_id;
    drive(wc_id, move |m, _| m.answer_dialog(id, answer));
    call.ok(json!({}));
}

/// `preview.copy`: the selection of the viewer's page.
pub(super) fn copy(call: Call) {
    let Some(owner) = host::owner_of(&call.params) else {
        return call.err("invalid", "Invalid preview owner");
    };
    let Some(page) = host::streamed_page(owner.key) else {
        return call.err("failed", "No streamed preview page");
    };
    let wc_id = page.borrow().wc_id;
    page::run_in_world(
        wc_id,
        PAGE_WORLD,
        "String(window.getSelection?.() ?? '')",
        move |value| {
            let text = value
                .as_str()
                .map(|t| js::slice_utf16(t, SELECTION_MAX_CHARS))
                .unwrap_or_default();
            call.ok(json!({ "text": text }));
        },
    );
}

// ------------------------------------------------------------------ input

/// `preview.input`: a batch of the viewer's gestures and keys, in order.
pub(super) fn input(owner_key: i64, events: &Value) {
    let Ok(batch) = input::parse_batch(events) else {
        return;
    };
    let Some(page) = host::streamed_page(owner_key) else {
        return;
    };
    let (wc_id, crashed) = {
        let p = page.borrow();
        (p.wc_id, p.state.crashed)
    };
    if crashed || !page::exists(wc_id) {
        return;
    }
    let (width, height) = page::offscreen_size(wc_id);
    let first = host::with_stream(wc_id, |s| {
        let surface = Surface {
            width: f64::from(width),
            height: f64::from(height),
            scale: s.scale,
        };
        for input in &batch {
            let ops = s.mapper.map(input, surface);
            let steps = s.sequence.plan(&ops);
            s.steps.extend(steps);
        }
        !std::mem::replace(&mut s.focused, true)
    });
    // Keys reach an offscreen browser only while it holds the focus.
    if first == Some(true) {
        page::focus(wc_id);
    }
    run_steps(wc_id);
}

/// Performs the queued steps in order; a round trip or an insert holds the ones behind it until it is done.
fn run_steps(wc_id: u64) {
    loop {
        let step =
            host::with_stream(wc_id, |s| if s.busy { None } else { s.steps.pop_front() }).flatten();
        let Some(step) = step else { return };
        match step {
            SequenceStep::Event(event) => send_event(wc_id, event),
            SequenceStep::RoundTrip => return barrier(wc_id),
            SequenceStep::Text(text) => {
                commit_text(wc_id, text);
                return barrier(wc_id);
            }
            SequenceStep::Pinch(scale) => host::pinch(wc_id, scale),
        }
    }
}

/// A call into the page's main thread (the isolated world answers `0`): what was sent before it has been taken.
fn barrier(wc_id: u64) {
    host::with_stream(wc_id, |s| s.busy = true);
    page::run_in_world(wc_id, PAGE_WORLD, "0", move |_| {
        host::with_stream(wc_id, |s| s.busy = false);
        run_steps(wc_id);
    });
}

fn modifier_flags(modifiers: &[Modifier]) -> u32 {
    modifiers.iter().fold(0, |flags, modifier| {
        flags
            | match modifier {
                Modifier::Shift => SHIFT,
                Modifier::Control => CONTROL,
                Modifier::Alt => ALT,
                Modifier::Meta => COMMAND,
            }
    })
}

fn key_event(kind: KeyEventType, key_code: &str, modifiers: &[Modifier]) -> KeyEvent {
    let typed = kind.get_raw() == KeyEventType::CHAR.get_raw();
    let character = if typed {
        key_code.encode_utf16().next().unwrap_or(0)
    } else {
        0
    };
    let mut event = KeyEvent {
        type_: kind,
        modifiers: modifier_flags(modifiers),
        windows_key_code: if typed {
            i32::from(character)
        } else {
            input::virtual_key(key_code)
        },
        character,
        unmodified_character: character,
        ..Default::default()
    };
    if cfg!(target_os = "macos") {
        let native = input::mac_key(key_code, modifiers);
        event.native_key_code = native.native_code;
        event.character = native.character;
        event.unmodified_character = native.unmodified_character;
    }
    event
}

/// One event of the viewer's input as the page's browser host takes it. The events are trusted: browser-process input,
/// never a debugger's (so `input-event` sees them and the `choose` gate holds).
fn send_event(wc_id: u64, event: InputEvent) {
    pages::with_browser(wc_id, move |browser| {
        let Some(host) = browser.host() else { return };
        match event {
            InputEvent::MouseMove { x, y, dragging } => {
                let modifiers = if dragging { LEFT_BUTTON } else { 0 };
                host.send_mouse_move_event(Some(&MouseEvent { x, y, modifiers }), 0);
            }
            InputEvent::MouseDown {
                x,
                y,
                button,
                click_count,
            } => {
                let (kind, modifiers) = button_of(button);
                host.send_mouse_click_event(
                    Some(&MouseEvent { x, y, modifiers }),
                    kind,
                    0,
                    i32::from(click_count),
                );
            }
            InputEvent::MouseUp {
                x,
                y,
                button,
                click_count,
            } => {
                let (kind, _) = button_of(button);
                host.send_mouse_click_event(
                    Some(&MouseEvent { x, y, modifiers: 0 }),
                    kind,
                    1,
                    i32::from(click_count),
                );
            }
            InputEvent::MouseWheel {
                x,
                y,
                delta_x,
                delta_y,
                ..
            } => {
                let at = MouseEvent { x, y, modifiers: 0 };
                host.send_mouse_wheel_event(
                    Some(&at),
                    delta_x.round() as i32,
                    delta_y.round() as i32,
                );
            }
            InputEvent::KeyDown {
                key_code,
                modifiers,
            } => {
                host.send_key_event(Some(&key_event(
                    KeyEventType::RAWKEYDOWN,
                    &key_code,
                    &modifiers,
                )));
            }
            InputEvent::Char {
                key_code,
                modifiers,
            } => {
                host.send_key_event(Some(&key_event(KeyEventType::CHAR, &key_code, &modifiers)));
            }
            InputEvent::KeyUp {
                key_code,
                modifiers,
            } => {
                host.send_key_event(Some(&key_event(KeyEventType::KEYUP, &key_code, &modifiers)));
            }
        }
    });
}

fn button_of(button: Button) -> (MouseButtonType, u32) {
    match button {
        Button::Left => (MouseButtonType::LEFT, LEFT_BUTTON),
        Button::Right => (MouseButtonType::RIGHT, RIGHT_BUTTON),
    }
}

/// Text the viewer committed (soft keyboard, IME result, paste), inserted at the caret.
fn commit_text(wc_id: u64, text: String) {
    pages::with_browser(wc_id, move |browser| {
        if let Some(host) = browser.host() {
            let whole = Range {
                from: u32::MAX,
                to: u32::MAX,
            };
            host.ime_commit_text(Some(&CefString::from(text.as_str())), Some(&whole), 0);
        }
    });
}
