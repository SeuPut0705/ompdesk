use serde::Serialize;

use super::run::Git;
use crate::fs::order::js_trim;
use crate::run::Opts;
use crate::server::Fault;

#[derive(Serialize, Debug, PartialEq)]
pub struct Counts {
    ahead: f64,
    behind: f64,
}

fn counts(text: &str) -> Counts {
    let mut values = js_trim(text).split_whitespace();
    let mut next = || {
        values
            .next()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    Counts {
        behind: next(),
        ahead: next(),
    }
}

pub async fn branch_status(
    git: &Git,
    root: &str,
    base: &str,
    branch: &str,
) -> Result<Counts, Fault> {
    let range = format!("{base}...{branch}");
    let result = git
        .run(
            root,
            &["rev-list", "--left-right", "--count", &range, "--"],
            Opts {
                timeout_ms: Some(30_000),
                ..Opts::default()
            },
        )
        .await;
    match result {
        Ok(output) if output.code == 0 => Ok(counts(&output.text())),
        output => {
            let stderr = output
                .as_ref()
                .ok()
                .map(|o| js_trim(&o.stderr))
                .filter(|s| !s.is_empty())
                .unwrap_or("git failed");
            Err(Fault::new(
                "git_failed",
                format!("Could not compare {branch} with {base}: {stderr}"),
            ))
        }
    }
}

pub async fn routine_head(git: &Git, repo: &str, branch: &str) -> Result<Option<String>, Fault> {
    let reference = format!("refs/heads/{branch}");
    let output = git
        .raw(repo, &["rev-parse", "--verify", "--quiet", &reference])
        .await?;
    match output.code {
        0 => Ok(Some(js_trim(&output.text()).to_owned())),
        1 => Ok(None),
        code => {
            let stderr = js_trim(&output.stderr);
            Err(Fault::new(
                "git_exit",
                if stderr.is_empty() {
                    format!("git rev-parse exited with code {code}")
                } else {
                    stderr.to_owned()
                },
            ))
        }
    }
}

#[derive(Serialize)]
pub struct Commits {
    total: f64,
    lines: Vec<String>,
}

pub async fn routine_commits(
    git: &Git,
    repo: &str,
    from: &str,
    to: &str,
) -> Result<Commits, Fault> {
    let range = format!("{from}..{to}");
    let total = git
        .text(repo, &["rev-list", "--count", &range, "--"])
        .await?;
    let total = js_trim(&total)
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .unwrap_or(0.0);
    let log = git
        .text(
            repo,
            &[
                "log",
                "--oneline",
                "--no-decorate",
                "-n",
                "10",
                &range,
                "--",
            ],
        )
        .await?;
    Ok(Commits {
        total,
        lines: log
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_captured_from_typescript() {
        for (text, behind, ahead) in [
            ("", 0.0, 0.0),
            ("0\t0\n", 0.0, 0.0),
            ("1\t2\n", 1.0, 2.0),
            (" 12  3\r\n", 12.0, 3.0),
            ("4\n", 4.0, 0.0),
            ("0005\t0009", 5.0, 9.0),
            ("9007199254740993\t2", 9007199254740992.0, 2.0),
        ] {
            assert_eq!(counts(text), Counts { ahead, behind }, "{text:?}");
        }
    }
}
