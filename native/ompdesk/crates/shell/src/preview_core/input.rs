//! A viewer's gestures and keys as what the offscreen page accepts (port of `src/main/web/preview-input.ts`):
//! mouse, wheel and key events for the browser-process input path, committed text, and the page's zoom for a pinch.
//! The page has no touch type, so a touch becomes the mouse event it means: a tap is a click, a one-finger drag a
//! wheel scroll, a long press a right click, a long press and drag a left-button drag.
//!
//! Everything here is pure: the wire value is parsed with exactly the acceptance of the zod schema it replaces,
//! [`InputMapper`] turns one parsed input into ops, and [`InputSequence`] plans the order the glue performs them in.

use serde_json::{Map, Number, Value, json};

use super::js;

/// The most events one `input` call carries, the longest text (UTF-16 units), and the largest wheel step.
pub const INPUT_BATCH_MAX: usize = 64;
pub const INPUT_TEXT_MAX: usize = 10_000;
const KEY_MAX: usize = 32;
const MODS_MAX: usize = 4;
const WHEEL_MAX: f64 = 5000.0;
const PINCH_MIN: f64 = 0.5;
const PINCH_MAX: f64 = 2.0;

/// Why a value is not an input the schema accepts; the first thing found wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal(pub &'static str);

/// A key held while another is pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modifier {
    Shift,
    Control,
    Alt,
    Meta,
}

impl Modifier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shift => "shift",
            Self::Control => "control",
            Self::Alt => "alt",
            Self::Meta => "meta",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "shift" => Self::Shift,
            "control" => Self::Control,
            "alt" => Self::Alt,
            "meta" => Self::Meta,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DragPhase {
    Start,
    Move,
    End,
}

/// One input of a viewer (`PreviewStreamInput`). Points are fractions of the frame, wheel deltas CSS px with the
/// DOM's sign.
#[derive(Clone, Debug, PartialEq)]
pub enum StreamInput {
    /// `count` is 1, 2 or 3 (absent on the wire means 1).
    Tap {
        x: f64,
        y: f64,
        count: u8,
    },
    Context {
        x: f64,
        y: f64,
    },
    Drag {
        phase: DragPhase,
        x: f64,
        y: f64,
    },
    Hover {
        x: f64,
        y: f64,
    },
    Wheel {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    Pinch {
        scale: f64,
    },
    /// A DOM `KeyboardEvent.key`, 1 to 32 UTF-16 units; `mods` as sent (an empty list is no modifiers).
    Key {
        key: String,
        mods: Vec<Modifier>,
    },
    Text(String),
}

/// What zod's `string().min(min).max(max)` counts: UTF-16 code units.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn object(value: &Value) -> Result<&Map<String, Value>, Refusal> {
    value.as_object().ok_or(Refusal("not an object"))
}

/// A finite number (a JSON number is never NaN or infinite, so a present number is enough).
fn number(object: &Map<String, Value>, key: &'static str) -> Result<f64, Refusal> {
    match object.get(key) {
        Some(Value::Number(n)) => n.as_f64().ok_or(Refusal("not a finite number")),
        _ => Err(Refusal("not a number")),
    }
}

fn string<'a>(object: &'a Map<String, Value>, key: &'static str) -> Result<&'a str, Refusal> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Refusal("not a string"))
}

fn point(object: &Map<String, Value>) -> Result<(f64, f64), Refusal> {
    Ok((number(object, "x")?, number(object, "y")?))
}

/// `previewStreamInputSchema.safeParse`: the object's `t` picks the shape; unknown keys are ignored, as zod's object does.
pub fn parse_input(value: &Value) -> Result<StreamInput, Refusal> {
    let object = object(value)?;
    match object.get("t").and_then(Value::as_str) {
        Some("tap") => {
            let (x, y) = point(object)?;
            let count = match object.get("count") {
                None => 1,
                Some(count) => match count.as_f64() {
                    Some(1.0) => 1,
                    Some(2.0) => 2,
                    Some(3.0) => 3,
                    _ => return Err(Refusal("count is not 1, 2 or 3")),
                },
            };
            Ok(StreamInput::Tap { x, y, count })
        }
        Some("context") => {
            let (x, y) = point(object)?;
            Ok(StreamInput::Context { x, y })
        }
        Some("drag") => {
            let phase = match string(object, "phase")? {
                "start" => DragPhase::Start,
                "move" => DragPhase::Move,
                "end" => DragPhase::End,
                _ => return Err(Refusal("unknown drag phase")),
            };
            let (x, y) = point(object)?;
            Ok(StreamInput::Drag { phase, x, y })
        }
        Some("hover") => {
            let (x, y) = point(object)?;
            Ok(StreamInput::Hover { x, y })
        }
        Some("wheel") => {
            let (x, y) = point(object)?;
            Ok(StreamInput::Wheel {
                x,
                y,
                dx: number(object, "dx")?,
                dy: number(object, "dy")?,
            })
        }
        Some("pinch") => {
            let scale = number(object, "scale")?;
            if scale > 0.0 {
                Ok(StreamInput::Pinch { scale })
            } else {
                Err(Refusal("scale is not positive"))
            }
        }
        Some("key") => {
            let key = string(object, "key")?;
            if !(1..=KEY_MAX).contains(&utf16_len(key)) {
                return Err(Refusal("key length"));
            }
            let mods = match object.get("mods") {
                None => Vec::new(),
                Some(Value::Array(names)) if names.len() <= MODS_MAX => names
                    .iter()
                    .map(|name| {
                        name.as_str()
                            .and_then(Modifier::parse)
                            .ok_or(Refusal("unknown modifier"))
                    })
                    .collect::<Result<_, _>>()?,
                Some(_) => return Err(Refusal("mods")),
            };
            Ok(StreamInput::Key {
                key: key.to_owned(),
                mods,
            })
        }
        Some("text") => {
            let text = string(object, "text")?;
            if (1..=INPUT_TEXT_MAX).contains(&utf16_len(text)) {
                Ok(StreamInput::Text(text.to_owned()))
            } else {
                Err(Refusal("text length"))
            }
        }
        _ => Err(Refusal("unknown input")),
    }
}

/// `previewStreamBatchSchema.safeParse`: an array of at most [`INPUT_BATCH_MAX`] inputs, each accepted.
pub fn parse_batch(value: &Value) -> Result<Vec<StreamInput>, Refusal> {
    let items = value.as_array().ok_or(Refusal("not an array"))?;
    if items.len() > INPUT_BATCH_MAX {
        return Err(Refusal("too many inputs"));
    }
    items.iter().map(parse_input).collect()
}

/// The size of the page's window in the units the page takes (DIPs); gestures arrive as fractions of it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Surface {
    pub width: f64,
    pub height: f64,
    /// Window DIPs per CSS px of the frame the viewer shows: a wheel delta arrives in the frame's CSS px and the
    /// page's zoom divides by the same.
    pub scale: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
}

impl MouseButton {
    fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

/// One event for the page's input path. Points are whole DIPs inside the window.
#[derive(Clone, Debug, PartialEq)]
pub enum InputEvent {
    /// `dragging`: the left button is down (Electron's `leftbuttondown` modifier).
    MouseMove { x: i32, y: i32, dragging: bool },
    MouseDown {
        x: i32,
        y: i32,
        button: MouseButton,
        click_count: u8,
    },
    MouseUp {
        x: i32,
        y: i32,
        button: MouseButton,
        click_count: u8,
    },
    /// Electron's sign (positive scrolls the content down). `precise` is `hasPreciseScrollingDeltas`; the mapper
    /// always sets it and `canScroll`, which [`InputEvent::to_electron_json`] writes as `true`.
    MouseWheel {
        x: i32,
        y: i32,
        delta_x: f64,
        delta_y: f64,
        precise: bool,
    },
    /// `key_code` is Electron's key code name ("Left", "a", "F5").
    KeyDown {
        key_code: String,
        modifiers: Vec<Modifier>,
    },
    /// The character a key types; its `key_code` is the character itself.
    Char {
        key_code: String,
        modifiers: Vec<Modifier>,
    },
    KeyUp {
        key_code: String,
        modifiers: Vec<Modifier>,
    },
}

/// A whole number as a JSON integer (as `JSON.stringify` writes it), anything else as the float.
fn json_number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        Value::from(x as i64)
    } else {
        Number::from_f64(x).map_or(Value::Null, Value::Number)
    }
}

fn modifier_names(modifiers: &[Modifier]) -> Vec<&'static str> {
    modifiers.iter().map(|modifier| modifier.as_str()).collect()
}

impl InputEvent {
    /// The object Electron's `sendInputEvent` takes, field for field as the TypeScript builds it (the glue maps the
    /// typed event to CEF; this shape is what the captured table holds).
    pub fn to_electron_json(&self) -> Value {
        match self {
            Self::MouseMove { x, y, dragging } => {
                let mut event = json!({ "type": "mouseMove", "x": x, "y": y });
                if *dragging {
                    event["modifiers"] = json!(["leftbuttondown"]);
                }
                event
            }
            Self::MouseDown {
                x,
                y,
                button,
                click_count,
            } => {
                json!({ "type": "mouseDown", "x": x, "y": y, "button": button.as_str(), "clickCount": click_count })
            }
            Self::MouseUp {
                x,
                y,
                button,
                click_count,
            } => {
                json!({ "type": "mouseUp", "x": x, "y": y, "button": button.as_str(), "clickCount": click_count })
            }
            Self::MouseWheel {
                x,
                y,
                delta_x,
                delta_y,
                precise,
            } => json!({
                "type": "mouseWheel",
                "x": x,
                "y": y,
                "deltaX": json_number(*delta_x),
                "deltaY": json_number(*delta_y),
                "hasPreciseScrollingDeltas": precise,
                "canScroll": true,
            }),
            Self::KeyDown {
                key_code,
                modifiers,
            } => key_json("keyDown", key_code, modifiers),
            Self::Char {
                key_code,
                modifiers,
            } => key_json("char", key_code, modifiers),
            Self::KeyUp {
                key_code,
                modifiers,
            } => key_json("keyUp", key_code, modifiers),
        }
    }
}

fn key_json(kind: &str, key_code: &str, modifiers: &[Modifier]) -> Value {
    let mut event = json!({ "type": kind, "keyCode": key_code });
    if !modifiers.is_empty() {
        event["modifiers"] = json!(modifier_names(modifiers));
    }
    event
}

#[derive(Clone, Debug, PartialEq)]
pub enum InputOp {
    Event(InputEvent),
    Text(String),
    /// Multiply the page's zoom by this factor.
    Pinch(f64),
}

/// The key code and the character a DOM key name types.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ElectronKey {
    pub key_code: String,
    pub char: Option<String>,
}

/// DOM `KeyboardEvent.key` names → the key codes the page's input path knows.
fn named_key(key: &str) -> Option<&'static str> {
    Some(match key {
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "Enter" => "Enter",
        "Backspace" => "Backspace",
        "Delete" => "Delete",
        "Tab" => "Tab",
        "Escape" => "Escape",
        "Home" => "Home",
        "End" => "End",
        "PageUp" => "PageUp",
        "PageDown" => "PageDown",
        "Insert" => "Insert",
        " " => "Space",
        _ => return None,
    })
}

/// Keys that also type something: the page's text fields only change on the `char` event that follows.
fn char_key(key: &str) -> Option<&'static str> {
    match key {
        "Enter" => Some("\r"),
        " " => Some(" "),
        _ => None,
    }
}

/// `^F([1-9]|1[0-9]|2[0-4])$`.
fn is_function_key(key: &str) -> bool {
    let Some(digits) = key.strip_prefix('F') else {
        return false;
    };
    matches!(
        digits.as_bytes(),
        [b'1'..=b'9'] | [b'1', b'0'..=b'9'] | [b'2', b'0'..=b'4']
    )
}

/// The key code and the character `key` types, or `None` for a key the page cannot be given.
pub fn electron_key(key: &str) -> Option<ElectronKey> {
    if let Some(named) = named_key(key) {
        return Some(ElectronKey {
            key_code: named.to_owned(),
            char: char_key(key).map(str::to_owned),
        });
    }
    if is_function_key(key) {
        return Some(ElectronKey {
            key_code: key.to_owned(),
            char: None,
        });
    }
    // A single typed character (one code point, so an emoji or a surrogate pair is still one key).
    if key.chars().count() == 1 {
        return Some(ElectronKey {
            key_code: key.to_owned(),
            char: Some(key.to_owned()),
        });
    }
    None
}

/// A DOM wheel delta as the page's: opposite sign, capped, and a zero stays a plain zero.
fn flip_wheel(delta: f64) -> f64 {
    if delta == 0.0 {
        0.0
    } else {
        -js::clamp(delta, -WHEEL_MAX, WHEEL_MAX)
    }
}

/// Turns inputs into ops. The one thing it remembers is whether a left-button drag is in progress.
#[derive(Debug, Default)]
pub struct InputMapper {
    /// Moves carry the button, and a stray move or end without a start is dropped.
    dragging: bool,
}

impl InputMapper {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn dragging(&self) -> bool {
        self.dragging
    }

    pub fn map(&mut self, input: &StreamInput, surface: Surface) -> Vec<InputOp> {
        let at = |x: f64, y: f64| {
            (
                js::round(js::clamp(x, 0.0, 1.0) * js::max(0.0, surface.width - 1.0)) as i32,
                js::round(js::clamp(y, 0.0, 1.0) * js::max(0.0, surface.height - 1.0)) as i32,
            )
        };
        let click = |x: i32, y: i32, button: MouseButton, click_count: u8| {
            [
                InputOp::Event(InputEvent::MouseMove {
                    x,
                    y,
                    dragging: false,
                }),
                InputOp::Event(InputEvent::MouseDown {
                    x,
                    y,
                    button,
                    click_count,
                }),
                InputOp::Event(InputEvent::MouseUp {
                    x,
                    y,
                    button,
                    click_count,
                }),
            ]
            .to_vec()
        };
        match input {
            StreamInput::Tap { x, y, count } => {
                let (x, y) = at(*x, *y);
                click(x, y, MouseButton::Left, *count)
            }
            StreamInput::Context { x, y } => {
                let (x, y) = at(*x, *y);
                click(x, y, MouseButton::Right, 1)
            }
            StreamInput::Drag { phase, x, y } => {
                let (x, y) = at(*x, *y);
                match phase {
                    DragPhase::Start => {
                        self.dragging = true;
                        vec![
                            InputOp::Event(InputEvent::MouseMove {
                                x,
                                y,
                                dragging: false,
                            }),
                            InputOp::Event(InputEvent::MouseDown {
                                x,
                                y,
                                button: MouseButton::Left,
                                click_count: 1,
                            }),
                        ]
                    }
                    _ if !self.dragging => Vec::new(),
                    DragPhase::Move => vec![InputOp::Event(InputEvent::MouseMove {
                        x,
                        y,
                        dragging: true,
                    })],
                    DragPhase::End => {
                        self.dragging = false;
                        vec![InputOp::Event(InputEvent::MouseUp {
                            x,
                            y,
                            button: MouseButton::Left,
                            click_count: 1,
                        })]
                    }
                }
            }
            StreamInput::Hover { x, y } => {
                if self.dragging {
                    return Vec::new();
                }
                let (x, y) = at(*x, *y);
                vec![InputOp::Event(InputEvent::MouseMove {
                    x,
                    y,
                    dragging: false,
                })]
            }
            StreamInput::Wheel { x, y, dx, dy } => {
                let (x, y) = at(*x, *y);
                // The page's wheel delta has the opposite sign of the DOM's: positive scrolls the content down.
                vec![InputOp::Event(InputEvent::MouseWheel {
                    x,
                    y,
                    delta_x: flip_wheel(dx * surface.scale),
                    delta_y: flip_wheel(dy * surface.scale),
                    precise: true,
                })]
            }
            StreamInput::Pinch { scale } => {
                vec![InputOp::Pinch(js::clamp(*scale, PINCH_MIN, PINCH_MAX))]
            }
            StreamInput::Text(text) => vec![InputOp::Text(text.clone())],
            StreamInput::Key { key, mods } => {
                let Some(electron) = electron_key(key) else {
                    return Vec::new();
                };
                let down = InputEvent::KeyDown {
                    key_code: electron.key_code.clone(),
                    modifiers: mods.clone(),
                };
                let up = InputEvent::KeyUp {
                    key_code: electron.key_code,
                    modifiers: mods.clone(),
                };
                let mut ops = vec![InputOp::Event(down)];
                // A shortcut (Ctrl or Meta held) is a command, never a typed character.
                let command = mods
                    .iter()
                    .any(|m| matches!(m, Modifier::Control | Modifier::Meta));
                if let (Some(char), false) = (electron.char, command) {
                    ops.push(InputOp::Event(InputEvent::Char {
                        key_code: char,
                        modifiers: mods.clone(),
                    }));
                }
                ops.push(InputOp::Event(up));
                ops
            }
        }
    }

    /// The page lost its viewer or navigated: no drag is in progress any more.
    pub fn reset(&mut self) {
        self.dragging = false;
    }
}

/// One thing the glue does to the page, in the order given.
#[derive(Clone, Debug, PartialEq)]
pub enum SequenceStep {
    Event(InputEvent),
    /// A call that returns once the page's main thread answers; the glue waits for it before the next step.
    RoundTrip,
    /// Insert committed text; the glue waits for the insert to finish before the next step.
    Text(String),
    Pinch(f64),
}

/// The order one page takes a viewer's ops in. Events and committed text reach the page by different routes, and
/// while its main thread is busy text lands before the keys sent ahead of it (a "한글" typed after "a", "b",
/// Backspace came out "한글a"). So text waits for a round trip after any events before it, and what follows text
/// waits for the insert: the glue runs the steps one at a time, awaiting each `RoundTrip` and `Text`.
#[derive(Debug, Default)]
pub struct InputSequence {
    /// Events went out since the last round trip: text must not overtake them.
    events_in_flight: bool,
}

impl InputSequence {
    pub fn new(events_in_flight: bool) -> Self {
        Self { events_in_flight }
    }

    pub fn events_in_flight(&self) -> bool {
        self.events_in_flight
    }

    /// The steps for `ops`, after every earlier call's steps. The flag is set as the plan is made, not as the steps
    /// run (the TypeScript sets it when the event is sent; the two differ only when sending throws, and then the
    /// page is gone and the round trip fails as well).
    pub fn plan(&mut self, ops: &[InputOp]) -> Vec<SequenceStep> {
        let mut steps = Vec::with_capacity(ops.len());
        for op in ops {
            match op {
                InputOp::Event(event) => {
                    steps.push(SequenceStep::Event(event.clone()));
                    self.events_in_flight = true;
                }
                InputOp::Text(text) => {
                    if self.events_in_flight {
                        self.events_in_flight = false;
                        steps.push(SequenceStep::RoundTrip);
                    }
                    steps.push(SequenceStep::Text(text.clone()));
                }
                InputOp::Pinch(scale) => steps.push(SequenceStep::Pinch(*scale)),
            }
        }
        steps
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::captured;
    use super::*;

    const SURFACE: Surface = Surface {
        width: 400.0,
        height: 800.0,
        scale: 1.0,
    };

    impl InputOp {
        fn to_json(&self) -> Value {
            match self {
                Self::Event(event) => json!({ "op": "event", "event": event.to_electron_json() }),
                Self::Text(text) => json!({ "op": "text", "text": text }),
                Self::Pinch(scale) => json!({ "op": "pinch", "scale": json_number(*scale) }),
            }
        }
    }

    fn input(value: Value) -> StreamInput {
        parse_input(&value).unwrap_or_else(|refusal| panic!("{value}: {refusal:?}"))
    }

    fn map(mapper: &mut InputMapper, value: Value, surface: Surface) -> Vec<Value> {
        mapper
            .map(&input(value), surface)
            .iter()
            .map(InputOp::to_json)
            .collect()
    }

    fn events(mapper: &mut InputMapper, value: Value) -> Vec<Value> {
        mapper
            .map(&input(value), SURFACE)
            .into_iter()
            .map(|op| match op {
                InputOp::Event(event) => event.to_electron_json(),
                other => other.to_json(),
            })
            .collect()
    }

    #[test]
    fn replays_the_captured_map_table() {
        let rows = captured("input")["map"].as_array().unwrap();
        assert_eq!(rows.len(), 744);
        for row in rows {
            let surface = Surface {
                width: row["surface"]["width"].as_f64().unwrap(),
                height: row["surface"]["height"].as_f64().unwrap(),
                scale: row["surface"]["scale"].as_f64().unwrap(),
            };
            let inputs = row["inputs"].as_array().unwrap();
            let ops = row["ops"].as_array().unwrap();
            let mut mapper = InputMapper::new();
            if ops.first().is_some_and(Value::is_array) {
                assert_eq!(inputs.len(), ops.len());
                for (one, want) in inputs.iter().zip(ops) {
                    let got = map(&mut mapper, one.clone(), surface);
                    assert_eq!(&Value::Array(got), want, "{one} on {}", row["surface"]);
                }
            } else {
                assert_eq!(inputs.len(), 1);
                let got = map(&mut mapper, inputs[0].clone(), surface);
                assert_eq!(
                    &Value::Array(got),
                    &row["ops"],
                    "{} on {}",
                    inputs[0],
                    row["surface"]
                );
            }
        }
    }

    #[test]
    fn replays_the_captured_schema_table() {
        let rows = captured("input")["schema"].as_array().unwrap();
        assert_eq!(rows.len(), 22);
        for row in rows {
            let ok = row["ok"].as_bool().unwrap();
            assert_eq!(parse_input(&row["value"]).is_ok(), ok, "{}", row["value"]);
        }
    }

    #[test]
    fn replays_the_captured_batch_table() {
        let rows = captured("input")["batch"].as_array().unwrap();
        assert_eq!(rows.len(), 4);
        for row in rows {
            let n = row["n"].as_u64().unwrap() as usize;
            let batch = Value::Array(vec![json!({ "t": "hover", "x": 0, "y": 0 }); n]);
            assert_eq!(
                parse_batch(&batch).is_ok(),
                row["ok"].as_bool().unwrap(),
                "n = {n}"
            );
        }
    }

    #[test]
    fn maps_a_tap_to_a_move_a_press_and_a_release_at_the_frames_fraction() {
        let mut mapper = InputMapper::new();
        assert_eq!(
            events(&mut mapper, json!({ "t": "tap", "x": 0.5, "y": 0.25 })),
            [
                json!({ "type": "mouseMove", "x": 200, "y": 200 }),
                json!({ "type": "mouseDown", "x": 200, "y": 200, "button": "left", "clickCount": 1 }),
                json!({ "type": "mouseUp", "x": 200, "y": 200, "button": "left", "clickCount": 1 }),
            ]
        );
    }

    #[test]
    fn keeps_the_click_count_of_a_double_tap_and_clamps_a_point_outside_the_frame() {
        let mut mapper = InputMapper::new();
        let down = &events(
            &mut mapper,
            json!({ "t": "tap", "x": 2, "y": -1, "count": 2 }),
        )[1];
        assert_eq!(
            down,
            &json!({ "type": "mouseDown", "x": 399, "y": 0, "button": "left", "clickCount": 2 })
        );
    }

    #[test]
    fn maps_a_long_press_to_a_right_click_and_a_long_press_with_movement_to_a_left_button_drag() {
        let mut mapper = InputMapper::new();
        let buttons: Vec<Option<String>> =
            events(&mut mapper, json!({ "t": "context", "x": 0, "y": 0 }))
                .iter()
                .map(|event| event["button"].as_str().map(str::to_owned))
                .collect();
        assert_eq!(buttons, [None, Some("right".into()), Some("right".into())]);
        let start = events(
            &mut mapper,
            json!({ "t": "drag", "phase": "start", "x": 0.1, "y": 0.1 }),
        );
        assert_eq!(start.last().unwrap()["type"], "mouseDown");
        assert_eq!(start.last().unwrap()["button"], "left");
        assert!(mapper.dragging());
        assert_eq!(
            events(
                &mut mapper,
                json!({ "t": "drag", "phase": "move", "x": 0.2, "y": 0.1 })
            ),
            [json!({ "type": "mouseMove", "x": 80, "y": 80, "modifiers": ["leftbuttondown"] })]
        );
        assert_eq!(
            events(
                &mut mapper,
                json!({ "t": "drag", "phase": "end", "x": 0.2, "y": 0.1 })
            ),
            [json!({ "type": "mouseUp", "x": 80, "y": 80, "button": "left", "clickCount": 1 })]
        );
        assert!(!mapper.dragging());
    }

    #[test]
    fn drops_a_drag_move_or_end_with_no_start_and_a_hover_during_a_drag() {
        let mut mapper = InputMapper::new();
        for phase in ["move", "end"] {
            assert!(
                events(
                    &mut mapper,
                    json!({ "t": "drag", "phase": phase, "x": 0.5, "y": 0.5 })
                )
                .is_empty()
            );
        }
        events(
            &mut mapper,
            json!({ "t": "drag", "phase": "start", "x": 0.5, "y": 0.5 }),
        );
        assert!(events(&mut mapper, json!({ "t": "hover", "x": 0.5, "y": 0.5 })).is_empty());
        mapper.reset();
        assert_eq!(
            events(&mut mapper, json!({ "t": "hover", "x": 0.5, "y": 0.5 })).len(),
            1
        );
    }

    #[test]
    fn flips_the_doms_wheel_sign_into_the_pages_as_precise_scrolling_deltas() {
        let mut mapper = InputMapper::new();
        assert_eq!(
            events(
                &mut mapper,
                json!({ "t": "wheel", "x": 0.5, "y": 0.5, "dx": 0, "dy": 120 })
            ),
            [json!({
                "type": "mouseWheel",
                "x": 200,
                "y": 400,
                "deltaX": 0,
                "deltaY": -120,
                "hasPreciseScrollingDeltas": true,
                "canScroll": true,
            })]
        );
        let huge = &events(
            &mut mapper,
            json!({ "t": "wheel", "x": 0, "y": 0, "dx": 0, "dy": -1e9 }),
        )[0];
        assert_eq!(huge["deltaY"], 5000);
    }

    #[test]
    fn scales_a_wheel_delta_from_the_frames_css_px_to_the_windows_dips() {
        let mut mapper = InputMapper::new();
        let surface = Surface {
            scale: 2.0,
            ..SURFACE
        };
        let event = &map(
            &mut mapper,
            json!({ "t": "wheel", "x": 0, "y": 0, "dx": 30, "dy": 120 }),
            surface,
        )[0];
        assert_eq!(event["event"]["deltaX"], -60);
        assert_eq!(event["event"]["deltaY"], -240);
    }

    #[test]
    fn turns_a_pinch_into_a_zoom_factor_within_a_sane_range() {
        let mut mapper = InputMapper::new();
        for (scale, want) in [(1.25, 1.25), (40.0, 2.0), (0.001, 0.5)] {
            assert_eq!(
                mapper.map(&StreamInput::Pinch { scale }, SURFACE),
                [InputOp::Pinch(want)]
            );
        }
    }

    #[test]
    fn hands_committed_text_over_whole() {
        let mut mapper = InputMapper::new();
        let text = StreamInput::Text("한글 text".into());
        assert_eq!(
            mapper.map(&text, SURFACE),
            [InputOp::Text("한글 text".into())]
        );
    }

    #[test]
    fn sends_a_typed_character_as_down_char_and_up_and_a_special_key_without_a_char() {
        let mut mapper = InputMapper::new();
        assert_eq!(
            events(&mut mapper, json!({ "t": "key", "key": "a" })),
            [
                json!({ "type": "keyDown", "keyCode": "a" }),
                json!({ "type": "char", "keyCode": "a" }),
                json!({ "type": "keyUp", "keyCode": "a" }),
            ]
        );
        assert_eq!(
            events(&mut mapper, json!({ "t": "key", "key": "ArrowLeft" })),
            [
                json!({ "type": "keyDown", "keyCode": "Left" }),
                json!({ "type": "keyUp", "keyCode": "Left" })
            ]
        );
        // Enter and Space type something, so a text field changes.
        assert_eq!(
            events(&mut mapper, json!({ "t": "key", "key": "Enter" }))[1],
            json!({ "type": "char", "keyCode": "\r" })
        );
        assert_eq!(
            events(&mut mapper, json!({ "t": "key", "key": " " }))[0],
            json!({ "type": "keyDown", "keyCode": "Space" })
        );
    }

    #[test]
    fn a_shortcut_is_a_command_ctrl_or_meta_suppresses_the_char_and_the_modifiers_ride_every_event()
    {
        let mut mapper = InputMapper::new();
        assert_eq!(
            events(
                &mut mapper,
                json!({ "t": "key", "key": "a", "mods": ["control"] })
            ),
            [
                json!({ "type": "keyDown", "keyCode": "a", "modifiers": ["control"] }),
                json!({ "type": "keyUp", "keyCode": "a", "modifiers": ["control"] }),
            ]
        );
        assert_eq!(
            events(
                &mut mapper,
                json!({ "t": "key", "key": "A", "mods": ["shift"] })
            )[1],
            json!({ "type": "char", "keyCode": "A", "modifiers": ["shift"] })
        );
    }

    #[test]
    fn gives_the_page_nothing_for_a_key_it_has_no_name_for() {
        assert_eq!(electron_key("Unidentified"), None);
        assert_eq!(
            electron_key("F13"),
            Some(ElectronKey {
                key_code: "F13".into(),
                char: None
            })
        );
        assert_eq!(
            electron_key("😀"),
            Some(ElectronKey {
                key_code: "😀".into(),
                char: Some("😀".into())
            })
        );
        for key in ["F0", "F25", "F01", "F1\n"] {
            assert_eq!(electron_key(key), None, "{key:?}");
        }
        assert!(
            InputMapper::new()
                .map(&input(json!({ "t": "key", "key": "Dead" })), SURFACE)
                .is_empty()
        );
    }

    #[test]
    fn the_batch_schema_accepts_each_input_kind_and_refuses_a_malformed_or_oversized_one() {
        let ok = json!([
            { "t": "tap", "x": 0.1, "y": 0.2 },
            { "t": "wheel", "x": 0.1, "y": 0.2, "dx": 0, "dy": 4 },
            { "t": "key", "key": "a", "mods": ["shift"] },
            { "t": "text", "text": "hi" },
        ]);
        assert_eq!(parse_batch(&ok).map(|inputs| inputs.len()), Ok(4));
        for bad in [
            json!([{ "t": "tap", "x": "0.1", "y": 0.2 }]),
            json!([{ "t": "eval", "code": "1" }]),
            json!([{ "t": "key", "key": "a", "mods": ["super"] }]),
            json!([{ "t": "text", "text": "" }]),
            json!({ "t": "hover", "x": 0, "y": 0 }),
        ] {
            assert!(parse_batch(&bad).is_err(), "{bad}");
        }
        let many = Value::Array(vec![
            json!({ "t": "hover", "x": 0, "y": 0 });
            INPUT_BATCH_MAX + 1
        ]);
        assert!(parse_batch(&many).is_err());
    }

    #[test]
    fn the_schema_counts_utf16_units_and_takes_each_optional_field_only_when_absent() {
        // "😀" is two UTF-16 units: sixteen of them fill the key's 32.
        assert!(parse_input(&json!({ "t": "key", "key": "😀".repeat(16) })).is_ok());
        assert!(parse_input(&json!({ "t": "key", "key": "😀".repeat(17) })).is_err());
        assert!(parse_input(&json!({ "t": "text", "text": "😀".repeat(5000) })).is_ok());
        assert!(parse_input(&json!({ "t": "text", "text": "😀".repeat(5001) })).is_err());
        assert!(parse_input(&json!({ "t": "tap", "x": 0, "y": 0, "count": null })).is_err());
        assert!(parse_input(&json!({ "t": "tap", "x": 0, "y": 0, "count": 2.0 })).is_ok());
        assert!(parse_input(&json!({ "t": "key", "key": "a", "mods": null })).is_err());
        assert!(parse_input(&json!({ "t": 1 })).is_err());
    }

    fn keys(name: &str) -> Vec<InputOp> {
        InputMapper::new().map(
            &StreamInput::Key {
                key: name.into(),
                mods: Vec::new(),
            },
            SURFACE,
        )
    }

    fn event_steps(name: &str) -> Vec<SequenceStep> {
        keys(name)
            .into_iter()
            .map(|op| match op {
                InputOp::Event(event) => SequenceStep::Event(event),
                other => panic!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn holds_committed_text_until_the_page_has_answered_after_the_keys_sent_before_it() {
        let mut ops = keys("Backspace");
        ops.push(InputOp::Text("한글".into()));
        let mut want = event_steps("Backspace");
        want.extend([SequenceStep::RoundTrip, SequenceStep::Text("한글".into())]);
        assert_eq!(InputSequence::default().plan(&ops), want);
    }

    #[test]
    fn puts_what_follows_committed_text_after_it_and_asks_nothing_when_no_event_came_before() {
        let mut ops = vec![InputOp::Text("a".into())];
        ops.extend(keys("Backspace"));
        let mut want = vec![SequenceStep::Text("a".into())];
        want.extend(event_steps("Backspace"));
        assert_eq!(InputSequence::default().plan(&ops), want);
    }

    #[test]
    fn a_pinch_neither_needs_nor_clears_the_flag_and_the_flag_outlives_a_call() {
        let mut sequence = InputSequence::default();
        assert_eq!(
            sequence.plan(&[InputOp::Pinch(1.5)]),
            [SequenceStep::Pinch(1.5)]
        );
        assert!(!sequence.events_in_flight());
        assert_eq!(sequence.plan(&keys("Backspace")).len(), 2);
        assert!(sequence.events_in_flight());
        assert_eq!(
            sequence.plan(&[InputOp::Text("x".into()), InputOp::Text("y".into())]),
            [
                SequenceStep::RoundTrip,
                SequenceStep::Text("x".into()),
                SequenceStep::Text("y".into())
            ]
        );
        assert!(!sequence.events_in_flight());
        let mut busy = InputSequence::new(true);
        assert_eq!(
            busy.plan(&[InputOp::Text("z".into())]),
            [SequenceStep::RoundTrip, SequenceStep::Text("z".into())]
        );
    }
}
