//! The one-line texts a routine trigger fires with (was `src/main/routines/source.ts`' `clip` and `describeCommits`).
//! `clip` stays in main too, for the triggers still there (sessions, files, email); both copies are held to the same
//! captured rows (`captured.json` `clip`, read by `source.test.ts` as well).

use crate::control::js::number;
use crate::fs::order::{is_js_space, js_trim};

const COMMAND_LINES_MAX: usize = 10;
const COMMAND_LINE_CHARS: usize = 100;

/// One line of at most `max` characters (code points), `…` marking a cut: runs of JavaScript's white space are one
/// space, the ends trimmed.
pub fn clip(text: &str, max: usize) -> String {
    let mut line = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if is_js_space(c) {
            space = true;
            continue;
        }
        if space {
            line.push(' ');
            space = false;
        }
        line.push(c);
    }
    if space {
        line.push(' ');
    }
    let line = js_trim(&line);
    if line.chars().count() <= max {
        return line.to_owned();
    }
    let mut cut: String = line.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// `3 new commits on main: abc1234 Fix …; def5678 …`: the newest lines (at most ten) of `total` new commits.
pub fn describe_commits(place: &str, total: f64, lines: &[String]) -> String {
    let shown: Vec<String> = lines
        .iter()
        .take(COMMAND_LINES_MAX)
        .map(|line| clip(line, COMMAND_LINE_CHARS))
        .collect();
    let more = total - shown.len() as f64;
    let plural = if total == 1.0 { "" } else { "s" };
    let tail = if more > 0.0 {
        format!("; and {} more", number(more))
    } else {
        String::new()
    };
    format!(
        "{} new commit{plural} on {place}: {}{tail}",
        number(total),
        shown.join("; ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routines::captured;

    #[test]
    fn clips_as_the_typescript_did() {
        let rows = captured("clip");
        assert_eq!(rows.len(), 150);
        for row in rows {
            let text = row[0].as_str().unwrap();
            let max = row[1].as_u64().unwrap() as usize;
            assert_eq!(clip(text, max), row[2].as_str().unwrap(), "{text:?} {max}");
        }
    }

    #[test]
    fn describes_commits_as_the_typescript_did() {
        let rows = captured("describeCommits");
        assert_eq!(rows.len(), 11);
        for row in rows {
            let lines: Vec<String> = row[2]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| line.as_str().unwrap().to_owned())
                .collect();
            assert_eq!(
                describe_commits(row[0].as_str().unwrap(), row[1].as_f64().unwrap(), &lines),
                row[3].as_str().unwrap()
            );
        }
    }
}
