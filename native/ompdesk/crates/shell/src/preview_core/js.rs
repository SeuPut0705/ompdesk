//! JavaScript's arithmetic where the Preview's rules depend on it, so a port computes the same pixels.

/// `Math.round`: the nearest integer, a half rounding up (towards +∞), NaN and ±∞ unchanged.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Math.min(Math.max(value, low), high)` as JavaScript computes it: a NaN anywhere is NaN.
pub fn clamp(value: f64, low: f64, high: f64) -> f64 {
    min(max(value, low), high)
}

/// `Math.max(a, b)`: NaN when either is NaN.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)`: NaN when either is NaN.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// A character `\s` matches in a JavaScript regular expression.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// A line terminator, where `^` matches under the `m` flag.
pub fn is_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `text.slice(0, max)`: at most `max` UTF-16 units, never half a character.
pub fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_as_math_round() {
        for (x, want) in [
            (0.5, 1.0),
            (-0.5, 0.0),
            (2.5, 3.0),
            (-2.5, -2.0),
            (0.499_999_999_999_999_94, 0.0),
            (1.4999, 1.0),
            (-1.5000001, -2.0),
        ] {
            assert_eq!(round(x), want, "{x}");
        }
        assert!(round(f64::NAN).is_nan());
        assert_eq!(round(f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn slices_in_utf16_units_without_splitting_a_character() {
        assert_eq!(slice_utf16("abc", 2), "ab");
        assert_eq!(slice_utf16("abc", 10), "abc");
        assert_eq!(slice_utf16("a😀b", 2), "a");
        assert_eq!(slice_utf16("a😀b", 3), "a😀");
        assert_eq!(slice_utf16("한글", 1), "한");
    }
}
