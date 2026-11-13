//! Where the shown Preview page sits: inside the app window, under shell overlays, and inside a responsive frame.

use super::js;

/// Chromium's smallest zoom factor; a frame scaled further would render wider than its box.
pub const MIN_FRAME_SCALE: f64 = 0.25;

/// A box in the panel's DIPs as the page reports it (may be fractional, negative or not finite).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A native view's whole-DIP rectangle inside its window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// What a native child view is told: hidden only (bounds not finite), or placed and shown or hidden.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    Hidden,
    Placed { rect: Rect, visible: bool },
}

/// Native child views must stay inside the window and disappear beneath shell overlays.
pub fn place_view(bounds: Bounds, visible: bool, window_width: f64, window_height: f64) -> Placement {
    if ![bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|v| v.is_finite()) {
        return Placement::Hidden;
    }
    let x = js::max(0.0, js::min(window_width, js::round(bounds.x)));
    let y = js::max(0.0, js::min(window_height, js::round(bounds.y)));
    let width = js::max(0.0, js::min(js::round(bounds.width), window_width - x));
    let height = js::max(0.0, js::min(js::round(bounds.height), window_height - y));
    Placement::Placed {
        rect: Rect { x: x as i32, y: y as i32, width: width as i32, height: height as i32 },
        visible: visible && width > 0.0 && height > 0.0,
    }
}

/// A responsive frame of `frame` CSS px inside the panel's `bounds`: centred horizontally, top-aligned and scaled down
/// (never up) to fit, so the page still lays out at the frame's width. The scale multiplies the page zoom.
pub fn fit_frame(bounds: Bounds, frame: Option<(f64, f64)>) -> (Bounds, f64) {
    let Some((frame_width, frame_height)) = frame else { return (bounds, 1.0) };
    if !(bounds.width > 0.0 && bounds.height > 0.0) {
        return (bounds, 1.0);
    }
    let fit = js::max(
        MIN_FRAME_SCALE,
        js::min(1.0, js::min(bounds.width / frame_width, bounds.height / frame_height)),
    );
    // Whole pixels first, then the exact scale they imply, so the page lays out at the frame's full width.
    let width = js::min(js::round(bounds.width), js::round(frame_width * fit));
    let height = js::min(js::round(bounds.height), js::round(frame_height * fit));
    (
        Bounds { x: js::round(bounds.x + (bounds.width - width) / 2.0), y: bounds.y, width, height },
        js::max(MIN_FRAME_SCALE, width / frame_width),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn n(v: &Value) -> f64 {
        match v {
            Value::String(s) => s.parse().unwrap(),
            other => other.as_f64().unwrap(),
        }
    }

    fn same(a: f64, b: f64) -> bool {
        a == b || (a.is_nan() && b.is_nan())
    }

    fn bounds(v: &Value) -> Bounds {
        Bounds { x: n(&v[0]), y: n(&v[1]), width: n(&v[2]), height: n(&v[3]) }
    }

    #[test]
    fn matches_the_typescript_tables() {
        let table = super::super::captured("layout");
        for row in table["fit"].as_array().unwrap() {
            let frame = row["frame"].as_array().map(|f| (n(&f[0]), n(&f[1])));
            let (out, scale) = fit_frame(bounds(&row["bounds"]), frame);
            let want = bounds(&row["out"]);
            assert!(
                same(out.x, want.x) && same(out.y, want.y) && same(out.width, want.width) && same(out.height, want.height),
                "{row}: {out:?}"
            );
            assert!(same(scale, n(&row["scale"])), "{row}: {scale}");
        }
        for row in table["apply"].as_array().unwrap() {
            let window = &row["window"];
            let got = place_view(bounds(&row["bounds"]), row["visible"].as_bool().unwrap(), n(&window[0]), n(&window[1]));
            let want = match row["calls"].as_array().unwrap().as_slice() {
                [hide] if hide["setVisible"] == false => Placement::Hidden,
                [set, shown] => {
                    let r = &set["setBounds"];
                    Placement::Placed {
                        rect: Rect { x: n(&r[0]) as i32, y: n(&r[1]) as i32, width: n(&r[2]) as i32, height: n(&r[3]) as i32 },
                        visible: shown["setVisible"].as_bool().unwrap(),
                    }
                }
                other => panic!("{other:?}"),
            };
            assert_eq!(got, want, "{row}");
        }
    }
}
