//! The server's JSON read as the TypeScript read it: nothing is required, a member of the wrong type counts as
//! absent (`str`, `num`, `strings`, `record`, `rows` of `client.ts`). And the JavaScript spellings its requests used.

use std::cmp::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Number, Value};

use crate::fs::order::is_js_space;
pub(crate) use crate::routines::github::encode_uri_component;

static NULL: Value = Value::Null;

/// `value[key]`: a member of an object, null for a missing one and for anything that is no object.
pub fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .as_object()
        .and_then(|members| members.get(key))
        .unwrap_or(&NULL)
}

/// `str(value)`: a string, else empty.
pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// `str(value) || null`.
pub fn filled(value: &Value) -> Option<String> {
    Some(text(value))
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `num(value)`: a number as the server wrote it, else 0.
pub fn number(value: &Value) -> Number {
    match value {
        Value::Number(number) => number.clone(),
        _ => Number::from(0),
    }
}

/// `strings(value)`: the strings of a list.
pub fn texts(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

/// `rows(value)`: the objects of a list (JavaScript counts a nested list as one; it has none of the members read).
pub fn rows(value: &Value) -> impl Iterator<Item = &Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row.is_object() || row.is_array())
}

/// How JavaScript orders two strings: by UTF-16 unit.
pub fn js_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// A string's `length`.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.trimEnd()`.
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// `text.replaceAll(/\s+/g, " ").trim()`.
pub fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for word in text.split(is_js_space).filter(|word| !word.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// One name or value as `URLSearchParams` serializes it (`application/x-www-form-urlencoded`).
pub fn form(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b' ' => out.push('+'),
            _ if byte.is_ascii_alphanumeric() || b"*-._".contains(&byte) => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A page path with each segment encoded and the slashes kept: `path.split("/").map(encodeURIComponent).join("/")`.
pub fn encode_path(path: &str) -> String {
    path.split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

/// `new Date(ms).toISOString()` for a time since 1970.
pub fn iso(ms: u64) -> String {
    let (days, in_day) = (ms / 86_400_000, ms % 86_400_000);
    // Days to a civil date (Howard Hinnant's `civil_from_days`), for dates from 1970 on.
    let shifted = days + 719_468;
    let (era, day_of_era) = (shifted / 146_097, shifted % 146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1_000 % 60,
        in_day % 1_000
    )
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    iso(u64::try_from(ms).unwrap_or(u64::MAX))
}

/// `Math.log` as V8 computes it: fdlibm's `__ieee754_log`, operation for operation.
pub fn js_log(x: f64) -> f64 {
    // The constants as fdlibm gives them, by their bits.
    const LN2_HI: f64 = f64::from_bits(0x3fe6_2e42_fee0_0000);
    const LN2_LO: f64 = f64::from_bits(0x3dea_39ef_3579_3c76);
    const TWO54: f64 = f64::from_bits(0x4350_0000_0000_0000);
    const ONE_THIRD: f64 = f64::from_bits(0x3fd5_5555_5555_5555);
    const LG1: f64 = f64::from_bits(0x3fe5_5555_5555_5593);
    const LG2: f64 = f64::from_bits(0x3fd9_9999_9997_fa04);
    const LG3: f64 = f64::from_bits(0x3fd2_4924_9422_9359);
    const LG4: f64 = f64::from_bits(0x3fcc_71c5_1d8e_78af);
    const LG5: f64 = f64::from_bits(0x3fc7_4664_96cb_03de);
    const LG6: f64 = f64::from_bits(0x3fc3_9a09_d078_c69f);
    const LG7: f64 = f64::from_bits(0x3fc2_f112_df3e_5244);

    let high = |value: f64| (value.to_bits() >> 32) as u32 as i32;
    let mut x = x;
    let mut hx = high(x);
    let lx = x.to_bits() as u32;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x0010_0000;
    x = f64::from_bits(
        u64::from((hx | (i ^ 0x3ff0_0000)) as u32) << 32 | (x.to_bits() & 0xffff_ffff),
    );
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - ONE_THIRD * f);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_members_leniently() {
        let body = json!({"a": "x", "n": 4, "list": ["s", 1, null, {"k": 1}, ["nested"]], "o": {"k": "v"}});
        assert_eq!(text(get(&body, "a")), "x");
        assert_eq!(text(get(&body, "n")), "");
        assert_eq!(text(get(get(&body, "o"), "k")), "v");
        assert_eq!(text(get(get(&body, "a"), "k")), "");
        assert_eq!(text(get(get(&body, "list"), "length")), "");
        assert_eq!(number(get(&body, "n")), Number::from(4));
        assert_eq!(number(get(&body, "a")), Number::from(0));
        assert_eq!(texts(get(&body, "list")), ["s"]);
        assert_eq!(texts(get(&body, "a")), Vec::<String>::new());
        assert_eq!(rows(get(&body, "list")).count(), 2);
        assert_eq!(rows(&body).count(), 0);
        assert_eq!(filled(get(&body, "a")), Some("x".to_owned()));
        assert_eq!(filled(&json!("")), None);
    }

    #[test]
    fn spells_requests_as_javascript_did() {
        assert_eq!(
            form("a/b&c=d+e~f*g'h(i)!한 j"),
            "a%2Fb%26c%3Dd%2Be%7Ef*g%27h%28i%29%21%ED%95%9C+j"
        );
        assert_eq!(encode_path("sessions/a b#c.md"), "sessions/a%20b%23c.md");
        assert_eq!(encode_path("/a//b/"), "/a//b/");
        assert_eq!(
            one_line("  names files \u{a0}\n that\tare gone "),
            "names files that are gone"
        );
        assert_eq!(one_line(" \u{feff} "), "");
        assert_eq!(js_trim_end("a \u{a0}\n\u{feff}"), "a");
        assert_eq!(js_trim_end("a\u{85}"), "a\u{85}");
        assert_eq!(js_length("😀x"), 3);
        // U+FF5E sorts before U+1F600 by code point and after it by UTF-16 unit.
        assert_eq!(js_order("\u{ff5e}", "😀"), Ordering::Greater);
        assert_eq!(js_order("a", "b"), Ordering::Less);
    }

    #[test]
    fn writes_a_time_as_to_iso_string_did() {
        // `new Date(ms).toISOString()` in node 24 for each.
        for (ms, text) in [
            (0, "1970-01-01T00:00:00.000Z"),
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            (951_868_799_999, "2000-02-29T23:59:59.999Z"),
            (1_709_251_199_999, "2024-02-29T23:59:59.999Z"),
            (1_709_251_200_000, "2024-03-01T00:00:00.000Z"),
            (1_794_469_130_598, "2026-11-12T07:38:50.598Z"),
            (4_102_444_800_000, "2100-01-01T00:00:00.000Z"),
            (4_107_542_400_000, "2100-03-01T00:00:00.000Z"),
            (253_402_300_799_999, "9999-12-31T23:59:59.999Z"),
        ] {
            assert_eq!(iso(ms), text);
        }
    }
}
