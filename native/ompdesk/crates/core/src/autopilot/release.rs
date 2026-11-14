//! Release procedure lookup formerly owned by `src/main/release-detect.ts`.
//! The bridge keeps its guide parser because it executes inside stock omp; captured parser cases pin this host copy.

use std::io::Read;
use std::path::Path;

use serde::Serialize;

const MAX_FILE_UNITS: usize = 2 * 1024 * 1024;
const RULES_FILES: [&str; 3] = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Procedure {
    pub file: String,
    pub anchors: Vec<String>,
}

struct Section<'a> {
    title: &'a str,
    level: usize,
    start: usize,
    end: usize,
}

fn sections<'a>(lines: &[&'a str]) -> Vec<Section<'a>> {
    let mut heads: Vec<Section<'a>> = Vec::new();
    let mut fence = None;
    for (at, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start_matches(crate::fs::order::is_js_space);
        let indent = line[..line.len() - trimmed.len()].chars().count();
        let mark = trimmed
            .chars()
            .next()
            .filter(|mark| *mark == '`' || *mark == '~');
        if let Some(mark) = mark
            .filter(|mark| indent <= 3 && trimmed.chars().take_while(|c| c == mark).count() >= 3)
        {
            match fence {
                None => fence = Some(mark),
                Some(open) if open == mark => fence = None,
                Some(_) => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let level = line.bytes().take_while(|byte| *byte == b'#').count();
        if !(1..=6).contains(&level) {
            continue;
        }
        let rest = &line[level..];
        if !rest.starts_with(crate::fs::order::is_js_space) {
            continue;
        }
        let title = rest
            .trim_matches(crate::fs::order::is_js_space)
            .trim_end_matches('#')
            .trim_end_matches(crate::fs::order::is_js_space);
        if title.is_empty() {
            continue;
        }
        for previous in heads.iter_mut().rev() {
            if previous.end == lines.len() && previous.level >= level {
                previous.end = at;
            }
        }
        heads.push(Section {
            title,
            level,
            start: at,
            end: lines.len(),
        });
    }
    heads
}

fn release_words(text: &str) -> bool {
    ["release", "releasing", "publish"].iter().any(|word| {
        text.as_bytes()
            .windows(word.len())
            .any(|part| part.eq_ignore_ascii_case(word.as_bytes()))
    }) || ["릴리스", "릴리즈", "배포"]
        .iter()
        .any(|word| text.contains(word))
}

fn lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

pub fn find_release_anchors(text: &str) -> Vec<String> {
    let lines = lines(text);
    let sections = sections(&lines);
    let mut anchored = vec![false; sections.len()];
    for (index, section) in sections.iter().enumerate() {
        if !release_words(section.title) {
            continue;
        }
        anchored[index] = true;
        for before in (0..index).rev() {
            let previous = &sections[before];
            if previous.level < section.level {
                break;
            }
            if previous.level != section.level {
                continue;
            }
            if !release_words(previous.title)
                && lines[previous.start + 1..previous.end]
                    .iter()
                    .any(|line| release_words(line))
            {
                anchored[before] = true;
            }
            break;
        }
    }
    sections
        .iter()
        .zip(anchored)
        .filter(|(_, yes)| *yes)
        .map(|(section, _)| section.title.to_owned())
        .collect()
}

fn guide_release(text: &str) -> Option<String> {
    let lines = lines(text);
    let sections = sections(&lines);
    let section = sections.iter().find(|section| {
        section.level <= 3
            && matches!(
                section.title.to_lowercase().as_str(),
                "release"
                    | "releases"
                    | "releasing"
                    | "release procedure"
                    | "release process"
                    | "릴리스"
                    | "릴리즈"
                    | "배포"
            )
    })?;
    let first = lines[section.start + 1..section.end]
        .iter()
        .find(|line| !line.trim_matches(crate::fs::order::is_js_space).is_empty());
    if first.is_some_and(|line| marker_no(line)) {
        return None;
    }
    Some(section.title.to_owned())
}

fn marker_no(line: &str) -> bool {
    let line = line.trim_start_matches(crate::fs::order::is_js_space);
    let line = if let Some(rest) = line.strip_prefix(['-', '*']) {
        if !rest.starts_with(crate::fs::order::is_js_space) {
            line
        } else {
            rest.trim_start_matches(crate::fs::order::is_js_space)
        }
    } else {
        line
    };
    let line = line.strip_prefix("**").unwrap_or(line);
    let lower = line.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("releases") else {
        return false;
    };
    let rest = rest.strip_prefix(':').unwrap_or(rest);
    let rest = rest.strip_prefix("**").unwrap_or(rest);
    let rest = rest
        .strip_prefix(':')
        .unwrap_or(rest)
        .trim_start_matches(crate::fs::order::is_js_space);
    rest.strip_prefix("no")
        .is_some_and(|tail| !tail.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
}

fn read_text(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    // A UTF-16 unit takes at most three UTF-8 bytes. The extra bytes keep a character cut by the read whole.
    std::fs::File::open(path)
        .ok()?
        .take((MAX_FILE_UNITS * 3 + 3) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    let text = String::from_utf8_lossy(&bytes);
    if text.encode_utf16().count() <= MAX_FILE_UNITS {
        return Some(text.into_owned());
    }
    Some(crate::json::utf16_prefix(&text, MAX_FILE_UNITS))
}

/// Reads files only. Missing/unreadable rules are skipped in the same priority order as the old host.
pub fn detect(root: &Path) -> Option<Procedure> {
    for file in RULES_FILES {
        let Some(text) = read_text(&root.join(file)) else {
            continue;
        };
        let anchors = find_release_anchors(&text);
        if !anchors.is_empty() {
            return Some(Procedure {
                file: file.to_owned(),
                anchors,
            });
        }
    }
    let mut whole = vec!["RELEASING.md".to_owned()];
    if let Ok(entries) = std::fs::read_dir(root.join("docs")) {
        let mut docs: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| {
                let lower = name.to_ascii_lowercase();
                lower.starts_with("release")
                    && (lower.ends_with(".md") || lower.ends_with(".markdown"))
            })
            .collect();
        docs.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        whole.extend(docs.into_iter().map(|name| format!("docs/{name}")));
    }
    for file in whole {
        let Some(text) = read_text(&root.join(&file)) else {
            continue;
        };
        let lines = lines(&text);
        let anchor = sections(&lines)
            .first()
            .map(|section| section.title.to_owned())
            .unwrap_or_else(|| {
                let base = file.rsplit('/').next().unwrap_or(&file);
                base.rsplit_once('.')
                    .map_or(base, |(stem, _)| stem)
                    .to_owned()
            });
        return Some(Procedure {
            file,
            anchors: vec![anchor],
        });
    }
    let text = read_text(&root.join("AUTOPILOT.md"))?;
    Some(Procedure {
        file: "AUTOPILOT.md".to_owned(),
        anchors: vec![guide_release(&text)?],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_anchors_follow_markdown_hierarchy_and_fences() {
        let cases = [
            (
                "# Title\n\n## Release\nbump and tag\n\n## Style\nx\n",
                vec!["Release"],
            ),
            ("# 제목\n\n## 릴리스 절차\n1. 태그\n", vec!["릴리스 절차"]),
            ("# T\n\n### 배포\n1. 푸시\n", vec!["배포"]),
            (
                "# T\n\n## Publishing to npm\nnpm publish\n",
                vec!["Publishing to npm"],
            ),
            (
                "## Change workflow\nWhen asked to release, run the gate.\n## Release\nbump\n## Style\nx",
                vec!["Change workflow", "Release"],
            ),
            ("## Style\nuse tabs\n## Release\nbump\n", vec!["Release"]),
            (
                "# T\n\n```md\n## Release\n```\n\nWe release often.\n\n## Testing\nrun it\n",
                vec![],
            ),
            (
                "## Change\nrelease\n# Other\n## Release\nx",
                vec!["Release"],
            ),
            (
                "## Change\nrelease\n### Nested\nx\n## Release ###\nx",
                vec!["Change", "Release"],
            ),
        ];
        for (text, expected) in cases {
            assert_eq!(find_release_anchors(text), expected, "{text}");
        }
    }

    #[test]
    fn guide_marker_never_confuses_cadence_or_a_deeper_heading_with_a_procedure() {
        for marker in [
            "Releases: no",
            "- Releases: no",
            "* **Releases:** no",
            "**Releases**: NO",
        ] {
            assert_eq!(guide_release(&format!("## Release\n\n{marker}\n")), None);
        }
        assert_eq!(guide_release("## Release cadence\nOften\n"), None);
        assert_eq!(guide_release("#### Release\nReleases: yes\n"), None);
        assert_eq!(
            guide_release("## Release\nThe maintainer's procedure"),
            Some("Release".into())
        );
        assert_eq!(
            guide_release("## Release\nReleases: nobody\n"),
            Some("Release".into())
        );
    }

    #[test]
    fn procedure_lookup_obeys_file_priority_and_whole_file_fallback() {
        let root = crate::fs::disk::make_temp_dir("autopilot-release-").unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let put = |file: &str, text: &str| std::fs::write(root.join(file), text).unwrap();
        put("AUTOPILOT.md", "## Release\nReleases: yes\n");
        assert_eq!(detect(&root).unwrap().file, "AUTOPILOT.md");
        put("AUTOPILOT.md", "## Release\nReleases: no\n");
        assert_eq!(detect(&root), None);
        std::fs::create_dir(root.join("docs")).unwrap();
        put("docs/release-z.md", "# Last\n");
        put("docs/release-a.markdown", "No heading, just steps.\n");
        assert_eq!(
            detect(&root),
            Some(Procedure {
                file: "docs/release-a.markdown".into(),
                anchors: vec!["release-a".into()]
            })
        );
        put("RELEASING.md", "# How we ship\n");
        assert_eq!(detect(&root).unwrap().anchors, ["How we ship"]);
        put("CONTRIBUTING.md", "## Release\nx\n");
        put("CLAUDE.md", "## Releasing\nx\n");
        put("AGENTS.md", "## Style\nx\n");
        assert_eq!(detect(&root).unwrap().file, "CLAUDE.md");
        put("AGENTS.md", "## Release\nx\n");
        assert_eq!(detect(&root).unwrap().file, "AGENTS.md");
    }
}
