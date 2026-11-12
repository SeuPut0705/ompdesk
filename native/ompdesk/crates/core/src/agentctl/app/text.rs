//! The small JavaScript behaviours the action texts lean on: UTF-16 lengths, number and value spelling, `String(x)`,
//! and `Date#toISOString`.

use serde_json::{Map, Value};

/// `string.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)`, stopping before a character that would cross `max` units.
pub fn slice_units(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max {
            return &text[..at];
        }
    }
    text
}

/// `value.length > max ? `${value.slice(0, max)}…` : value`.
pub fn clip(text: &str, max: usize) -> String {
    if utf16_len(text) > max {
        format!("{}…", slice_units(text, max))
    } else {
        text.to_string()
    }
}

/// A number as JavaScript writes it (`String(n)`) for the ranges an action meets: whole numbers without a point,
/// others by their shortest round-trip digits.
pub fn js_number(number: f64) -> String {
    if number == 0.0 {
        return "0".into();
    }
    if number.fract() == 0.0 && number.abs() < 1e21 {
        return format!("{number:.0}");
    }
    format!("{number}")
}

pub fn number_text(number: &serde_json::Number) -> String {
    if let Some(whole) = number.as_i64() {
        return whole.to_string();
    }
    if let Some(whole) = number.as_u64() {
        return whole.to_string();
    }
    js_number(number.as_f64().unwrap_or(0.0))
}

/// `String(value)`; `None` is `undefined`.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number_text(number),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `JSON.stringify(value)`.
pub fn json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// The `shown` of the catalog: a string as it is, a boolean as on or off, anything else as JSON.
pub fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => (if *flag { "on" } else { "off" }).into(),
        other => json(other),
    }
}

/// `String(args.key)` over an action's arguments.
pub fn arg(args: &Map<String, Value>, key: &str) -> String {
    js_string(args.get(key))
}

/// A string argument, when it is one.
pub fn str_arg<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// The objects of a list answer; anything else in it is dropped.
pub fn records(value: Option<&Value>) -> Vec<&Map<String, Value>> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

/// The object itself, or an empty one for anything else (a wire answer read field by field).
pub fn fields(value: Option<&Value>) -> &Map<String, Value> {
    static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
    match value {
        Some(Value::Object(map)) => map,
        _ => &EMPTY,
    }
}

pub fn text_of(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

pub fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// Days since 1970-01-01 to a civil date (proleptic Gregorian).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_part + 2) / 5 + 1) as u32;
    let month = if month_part < 10 {
        month_part + 3
    } else {
        month_part - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `new Date(ms).toISOString()`.
pub fn iso_ms(ms: f64) -> String {
    let ms = ms.floor() as i64;
    let (year, month, day) = civil(ms.div_euclid(86_400_000));
    let of_day = ms.rem_euclid(86_400_000);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1_000 % 60,
        of_day % 1_000
    )
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_numbers_read_as_javascript_writes_them() {
        assert_eq!(iso_ms(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_ms(1_794_471_000_123.0), "2026-11-12T08:10:00.123Z");
        assert_eq!(iso_ms(1_709_164_800_000.0), "2024-02-29T00:00:00.000Z");
        assert_eq!(js_number(1_000_000.0), "1000000");
        assert_eq!(js_number(1.5), "1.5");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(utf16_len("😀a"), 3);
        assert_eq!(slice_units("😀😀", 3), "😀");
        assert_eq!(clip("abcdef", 3), "abc…");
    }
}
