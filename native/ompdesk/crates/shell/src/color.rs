//! CSS colour strings as `win.create` / `setBackgroundColor` / `titleBarOverlay` carry them (PROTOCOL.md §0).

/// Red, green, blue, alpha (0–255 each).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Rgba(pub u8, pub u8, pub u8, pub u8);

impl Rgba {
    /// `0xAARRGGBB`, CEF's `cef_color_t`.
    pub fn argb(self) -> u32 {
        u32::from(self.3) << 24
            | u32::from(self.0) << 16
            | u32::from(self.1) << 8
            | u32::from(self.2)
    }

    /// `0x00BBGGRR`, Win32's `COLORREF` (alpha dropped).
    pub fn colorref(self) -> u32 {
        u32::from(self.2) << 16 | u32::from(self.1) << 8 | u32::from(self.0)
    }

    /// `self` with `over` blended on top at `alpha` (0.0–1.0).
    pub fn blend(self, over: Rgba, alpha: f32) -> Rgba {
        let mix =
            |a: u8, b: u8| (f32::from(a) * (1.0 - alpha) + f32::from(b) * alpha).round() as u8;
        Rgba(
            mix(self.0, over.0),
            mix(self.1, over.1),
            mix(self.2, over.2),
            self.3,
        )
    }
}

/// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)`, `rgba(r, g, b, a)`, `transparent`, `black`, `white`.
pub fn parse_css(text: &str) -> Option<Rgba> {
    let text = text.trim().to_ascii_lowercase();
    if let Some(hex) = text.strip_prefix('#') {
        let digit = |i: usize| {
            u8::from_str_radix(hex.get(i..i + 1)?, 16)
                .ok()
                .map(|d| d * 17)
        };
        let pair = |i: usize| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok();
        return match hex.len() {
            3 => Some(Rgba(digit(0)?, digit(1)?, digit(2)?, 255)),
            4 => Some(Rgba(digit(0)?, digit(1)?, digit(2)?, digit(3)?)),
            6 => Some(Rgba(pair(0)?, pair(2)?, pair(4)?, 255)),
            8 => Some(Rgba(pair(0)?, pair(2)?, pair(4)?, pair(6)?)),
            _ => None,
        };
    }
    match text.as_str() {
        "transparent" => return Some(Rgba(0, 0, 0, 0)),
        "black" => return Some(Rgba(0, 0, 0, 255)),
        "white" => return Some(Rgba(255, 255, 255, 255)),
        _ => {}
    }
    let inner = text
        .strip_prefix("rgba(")
        .or_else(|| text.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts: Vec<&str> = inner
        .split([',', '/', ' '])
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 3 || parts.len() > 4 {
        return None;
    }
    let channel = |p: &str| -> Option<u8> {
        p.parse::<f32>()
            .ok()
            .map(|v| v.round().clamp(0.0, 255.0) as u8)
    };
    let alpha = match parts.get(3) {
        Some(a) => {
            let a: f32 = if let Some(percent) = a.strip_suffix('%') {
                percent.parse::<f32>().ok()? / 100.0
            } else {
                a.parse().ok()?
            };
            (a.clamp(0.0, 1.0) * 255.0).round() as u8
        }
        None => 255,
    };
    Some(Rgba(
        channel(parts[0])?,
        channel(parts[1])?,
        channel(parts[2])?,
        alpha,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_forms() {
        assert_eq!(parse_css("#1a2b3c"), Some(Rgba(0x1a, 0x2b, 0x3c, 255)));
        assert_eq!(parse_css("#fff"), Some(Rgba(255, 255, 255, 255)));
        assert_eq!(parse_css("#0008"), Some(Rgba(0, 0, 0, 0x88)));
        assert_eq!(parse_css("#11223344"), Some(Rgba(0x11, 0x22, 0x33, 0x44)));
        assert_eq!(parse_css("#12345"), None);
        assert_eq!(parse_css("#ggg"), None);
    }

    #[test]
    fn functional_forms_and_keywords() {
        assert_eq!(parse_css("rgb(10, 20, 30)"), Some(Rgba(10, 20, 30, 255)));
        assert_eq!(parse_css("rgba(10,20,30,0.5)"), Some(Rgba(10, 20, 30, 128)));
        assert_eq!(parse_css("rgb(300 0 0 / 50%)"), Some(Rgba(255, 0, 0, 128)));
        assert_eq!(parse_css("transparent"), Some(Rgba(0, 0, 0, 0)));
        assert_eq!(parse_css("nope"), None);
        assert_eq!(parse_css("rgb(1,2)"), None);
    }

    #[test]
    fn the_two_native_encodings() {
        let c = Rgba(0x11, 0x22, 0x33, 0x80);
        assert_eq!(c.argb(), 0x8011_2233);
        assert_eq!(c.colorref(), 0x0033_2211);
        assert_eq!(
            Rgba(0, 0, 0, 255).blend(Rgba(255, 255, 255, 255), 0.5),
            Rgba(128, 128, 128, 255)
        );
    }
}
