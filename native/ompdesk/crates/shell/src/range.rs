//! `Range` request headers against a body of known size, the scheme handlers' (`app://`, `omp-media://`) one rule.

#[derive(Debug, PartialEq, Eq)]
pub enum ParsedRange {
    /// No usable `bytes=` range: the whole body, status 200.
    None,
    /// 416: the range starts past the end (or the body is empty).
    Unsatisfiable,
    /// First and last byte, inclusive, both inside the body.
    Range(u64, u64),
}

/// `bytes=a-b`, `bytes=a-`, `bytes=-n` against `size`. Only the first range of a list is served.
pub fn parse_range(header: &str, size: u64) -> ParsedRange {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return ParsedRange::None;
    };
    let spec = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = spec.split_once('-') else {
        return ParsedRange::None;
    };
    let (a, b) = (a.trim(), b.trim());
    if size == 0 {
        return ParsedRange::Unsatisfiable;
    }
    if a.is_empty() {
        return match b.parse::<u64>() {
            Ok(n) if n > 0 => {
                let n = n.min(size);
                ParsedRange::Range(size - n, size - 1)
            }
            Ok(_) => ParsedRange::Unsatisfiable,
            Err(_) => ParsedRange::None,
        };
    }
    let Ok(start) = a.parse::<u64>() else {
        return ParsedRange::None;
    };
    let end = if b.is_empty() {
        size - 1
    } else {
        match b.parse::<u64>() {
            Ok(end) => end.min(size - 1),
            Err(_) => return ParsedRange::None,
        }
    };
    if start >= size || start > end {
        return ParsedRange::Unsatisfiable;
    }
    ParsedRange::Range(start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_open_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), ParsedRange::Range(0, 99));
        assert_eq!(
            parse_range("bytes=500-", 1000),
            ParsedRange::Range(500, 999)
        );
        assert_eq!(
            parse_range("bytes=-200", 1000),
            ParsedRange::Range(800, 999)
        );
        assert_eq!(parse_range("bytes=-5000", 1000), ParsedRange::Range(0, 999));
        assert_eq!(
            parse_range("bytes=900-5000", 1000),
            ParsedRange::Range(900, 999)
        );
        assert_eq!(parse_range(" bytes = 1-2 ", 10), ParsedRange::None);
    }

    #[test]
    fn a_range_past_the_end_or_on_an_empty_body_is_unsatisfiable() {
        assert_eq!(parse_range("bytes=1000-", 1000), ParsedRange::Unsatisfiable);
        assert_eq!(parse_range("bytes=7-3", 1000), ParsedRange::Unsatisfiable);
        assert_eq!(parse_range("bytes=-0", 1000), ParsedRange::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-0", 0), ParsedRange::Unsatisfiable);
    }

    #[test]
    fn what_is_not_a_byte_range_is_the_whole_body() {
        assert_eq!(parse_range("items=0-5", 10), ParsedRange::None);
        assert_eq!(parse_range("bytes=abc", 10), ParsedRange::None);
        assert_eq!(parse_range("bytes=x-5", 10), ParsedRange::None);
        assert_eq!(parse_range("bytes=2-y", 10), ParsedRange::None);
    }

    #[test]
    fn only_the_first_range_of_a_list_is_served() {
        assert_eq!(parse_range("bytes=0-1, 5-6", 10), ParsedRange::Range(0, 1));
    }
}
