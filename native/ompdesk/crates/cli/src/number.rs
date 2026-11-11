//! JavaScript's `Number(string)` and `Number.prototype.toString`, so flags parse and serialize as the TS CLI did.

use serde_json::Value;

/// ECMAScript WhiteSpace and LineTerminator, which `trim` and `Number` strip and `\s` matches.
pub fn is_js_space(c: char) -> bool {
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

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `Number(text)`: NaN where JavaScript gives NaN.
pub fn js_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = match t.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => 0,
    };
    if radix != 0 {
        let digits = &t[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0f64;
        for c in digits.chars() {
            match c.to_digit(radix) {
                Some(d) => value = value * f64::from(radix) + f64::from(d),
                None => return f64::NAN,
            }
        }
        return value;
    }
    let (negative, unsigned) = match t.as_bytes()[0] {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    let magnitude = if unsigned == "Infinity" {
        f64::INFINITY
    } else {
        decimal(unsigned).unwrap_or(f64::NAN)
    };
    if negative { -magnitude } else { magnitude }
}

/// StrUnsignedDecimalLiteral without `Infinity`: `int[.frac][e[+-]exp]` or `.frac[e...]`.
fn decimal(text: &str) -> Option<f64> {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], Some(&text[at + 1..])),
        None => (text, None),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if int.is_empty() && frac.is_empty() || !digits(int) || !digits(frac) {
        return None;
    }
    let exponent = match exponent {
        None => "0",
        Some(e) => {
            let unsigned = e.strip_prefix(['+', '-']).unwrap_or(e);
            if unsigned.is_empty() || !digits(unsigned) {
                return None;
            }
            e
        }
    };
    let int = if int.is_empty() { "0" } else { int };
    let frac = if frac.is_empty() { "0" } else { frac };
    format!("{int}.{frac}e{exponent}").parse().ok()
}

/// `String(n)` for a finite number.
pub fn js_string(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    if n < 0.0 {
        return format!("-{}", js_string(-n));
    }
    let sci = format!("{n:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let e = exp.parse::<i32>().unwrap_or(0) + 1;
    if k <= e && e <= 21 {
        format!("{digits}{}", "0".repeat((e - k) as usize))
    } else if 0 < e && e <= 21 {
        format!("{}.{}", &digits[..e as usize], &digits[e as usize..])
    } else if -6 < e && e <= 0 {
        format!("0.{}{digits}", "0".repeat((-e) as usize))
    } else {
        let head = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{head}e{}{}", if e > 0 { '+' } else { '-' }, (e - 1).abs())
    }
}

/// The number as `JSON.stringify` writes it: integral numbers without a fraction, non-finite as null.
pub fn to_json(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    js_string(n)
        .parse()
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_javascript() {
        let cases: &[(&str, f64)] = &[
            ("5", 5.0),
            (" 5\n", 5.0),
            ("\u{a0}7\u{feff}", 7.0),
            ("", 0.0),
            ("   ", 0.0),
            ("0x1F", 31.0),
            ("0o17", 15.0),
            ("0b101", 5.0),
            ("1.5", 1.5),
            (".5", 0.5),
            ("5.", 5.0),
            ("1e3", 1000.0),
            ("1.5E-1", 0.15),
            ("+2", 2.0),
            ("-2", -2.0),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
        ];
        for (text, want) in cases {
            assert_eq!(js_number(text), *want, "{text:?}");
        }
        for text in [
            "NaN", "nan", "inf", "infinity", "INF", "1e", "e5", ".", "-", "1.2.3", "0x", "-0x5",
            "0xg", "1_000", "5x", "1e+", "\u{85}5",
        ] {
            assert!(js_number(text).is_nan(), "{text:?}");
        }
    }

    #[test]
    fn serializes_like_javascript() {
        let cases: &[(f64, &str)] = &[
            (5.0, "5"),
            (30_000.0, "30000"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.25e22, "1.25e+22"),
        ];
        for (n, want) in cases {
            assert_eq!(js_string(*n), *want);
        }
        assert_eq!(to_json(f64::INFINITY), Value::Null);
        assert_eq!(serde_json::to_string(&to_json(9000.0)).unwrap(), "9000");
    }
}
