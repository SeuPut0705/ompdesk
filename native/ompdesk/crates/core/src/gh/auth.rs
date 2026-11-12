//! GitHub sign-in's gh and git runs (was `src/main/github-auth/cli.ts` and the sequences `service.ts` ran over it):
//! the status check (`gh.authCheck`: gh's version, `gh auth status` with the active account and the other signed-in
//! ones, git's global identity), the commit identity filled from the account (`gh.authIdentity`), the sign-out
//! (`gh.authLogout`), the switch to another signed-in account (`gh.authSwitch`) and the star on a repository
//! (`gh.star`). Main keeps the sign-in itself (`service.ts`): its state, `gh auth login` in stock's PTY, the reading of
//! that transcript and the check's reuse, all rules over state its commands change within one tick.
//!
//! Main hands over gh's and git's runners (`ghRunner`: gh's non-interactive environment for both, as `ghText` ran
//! them), `null` for a tool it did not find; every run here is `ghText`'s (30 s, every exit code answered). gh quirks:
//! plain `gh auth status` exits 1 when any stored github.com account has a stale token, so signed-in is read with
//! `--active`; gh < 2.40 has no `--active` ("unknown flag") and falls back to the plain call; gh ≥ 2.40 prints
//! "Logged in to github.com account <login>", older builds "Logged in to github.com as <login>"; either may land on
//! stdout or stderr.
//!
//! A fault carries no token: the values of gh's token variables in either runner's environment read `***` in it,
//! whether gh printed them on stderr or stdout.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Gh, TextOutput, json};
use crate::fs::order::{is_js_space, js_trim};
use crate::run::Runner;
use crate::server::{Fault, Registry, Reply};

/// The service's words for a missing gh (the PR Center's carry a link).
const NO_GH: &str = "GitHub CLI (gh) is not installed";
const NO_GIT: &str = "git is not installed";
const STATUS_ACTIVE: [&str; 5] = ["auth", "status", "--hostname", "github.com", "--active"];
const LOGOUT: [&str; 4] = ["auth", "logout", "--hostname", "github.com"];
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// One gh or git run as `ghText` runs it. Tests answer from a script.
pub(crate) trait Text {
    fn text(&self, args: &[&str]) -> impl Future<Output = Result<TextOutput, Fault>> + Send;
}

/// A tool main found, run in the request's folder.
struct Tool<'a> {
    gh: &'a Gh,
    cwd: &'a str,
}

impl Text for Tool<'_> {
    async fn text(&self, args: &[&str]) -> Result<TextOutput, Fault> {
        self.gh.text(self.cwd, args).await
    }
}

/// git's global `user.name` and `user.email`, none when unset.
#[derive(Serialize, Debug, PartialEq)]
struct Identity {
    name: Option<String>,
    email: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    installed: bool,
    version: Option<String>,
    authenticated: bool,
    login: Option<String>,
    other_accounts: Vec<String>,
}

#[derive(Serialize)]
struct Check {
    identity: Option<Identity>,
    status: Status,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Filled {
    identity_filled: Vec<&'static str>,
    identity: Identity,
}

/// The signed-in account as a commit identity.
struct Account {
    name: String,
    email: String,
}

/// What `gh auth status` says of github.com.
#[derive(Default)]
struct Auth {
    authenticated: bool,
    login: Option<String>,
    other_accounts: Vec<String>,
}

/// The text after a leading run of characters that are not JavaScript's `\s`, with that run; none when it is empty.
fn word(text: &str) -> Option<(&str, &str)> {
    let end = text.find(is_js_space).unwrap_or(text.len());
    (end > 0).then(|| text.split_at(end))
}

/// What `rest` takes from the text after the first `lead` it accepts, as a regular expression's leftmost match is.
fn after<'a>(
    text: &'a str,
    lead: &str,
    rest: impl Fn(&'a str) -> Option<&'a str>,
) -> Option<&'a str> {
    text.match_indices(lead)
        .find_map(|(at, _)| rest(&text[at + lead.len()..]))
}

/// `Logged in to \S+ account\s+(\S+)` after `lead` (which ends in "Logged in to ").
fn account_login<'a>(text: &'a str, lead: &str) -> Option<&'a str> {
    after(text, lead, |rest| {
        let (_, rest) = word(rest)?;
        let rest = rest.strip_prefix(" account")?;
        let spaces = rest.len() - rest.trim_start_matches(is_js_space).len();
        if spaces == 0 {
            return None;
        }
        word(&rest[spaces..]).map(|(login, _)| login)
    })
}

/// The active account's login: `Logged in to \S+ account\s+(\S+)`, else gh < 2.40's `Logged in to \S+ as (\S+)`.
fn active_login(output: &str) -> Option<&str> {
    account_login(output, "Logged in to ").or_else(|| {
        after(output, "Logged in to ", |rest| {
            let (_, rest) = word(rest)?;
            word(rest.strip_prefix(" as ")?).map(|(login, _)| login)
        })
    })
}

/// Whether `text` holds `pattern` with ASCII letters in any case (a JavaScript `/…/i` without `u`).
fn contains_folded(text: &str, pattern: &str) -> bool {
    text.as_bytes()
        .windows(pattern.len())
        .any(|window| window.eq_ignore_ascii_case(pattern.as_bytes()))
}

/// `/Active account:\s*true/i`.
fn says_active(line: &str) -> bool {
    const LABEL: &str = "active account:";
    line.char_indices().any(|(at, _)| {
        let rest = line.as_bytes()[at..].get(..LABEL.len());
        rest.is_some_and(|rest| rest.eq_ignore_ascii_case(LABEL.as_bytes()))
            && line[at + LABEL.len()..]
                .trim_start_matches(is_js_space)
                .as_bytes()
                .get(..4)
                .is_some_and(|value| value.eq_ignore_ascii_case(b"true"))
    })
}

/// Every signed-in github.com account in plain `gh auth status` output (gh ≥ 2.40 lists each with "- Active account:
/// true|false"), with whether it is the active one; an account whose token failed ("X Failed to log in …") is left
/// out, `gh auth switch` could not use it.
fn accounts(output: &str) -> Vec<(String, bool)> {
    let mut accounts: Vec<(String, bool)> = Vec::new();
    let mut current = false;
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(login) = account_login(line, "✓ Logged in to ") {
            accounts.push((login.to_owned(), false));
            current = true;
        } else if line.contains("Failed to log in") {
            current = false;
        } else if current
            && says_active(line)
            && let Some(account) = accounts.last_mut()
        {
            account.1 = true;
        }
    }
    accounts
}

/// `stdout` and `stderr` as one text: gh prints its status on either.
fn both(output: &TextOutput) -> String {
    format!("{}\n{}", output.stdout, output.stderr)
}

/// A failed run's own words: its stderr, else its stdout, else `fallback`.
fn said(code: &'static str, output: &TextOutput, fallback: &str) -> Fault {
    let stderr = js_trim(&output.stderr);
    let stdout = js_trim(&output.stdout);
    let message = [stderr, stdout, fallback]
        .into_iter()
        .find(|text| !text.is_empty())
        .unwrap_or(fallback);
    Fault::new(code, message)
}

async fn version(gh: &impl Text) -> Result<Option<String>, Fault> {
    let probe = gh.text(&["--version"]).await?;
    Ok((probe.code == 0)
        .then(|| {
            after(&probe.stdout, "gh version ", |rest| {
                word(rest).map(|(version, _)| version)
            })
        })
        .flatten()
        .map(str::to_owned))
}

async fn status(gh: &impl Text) -> Result<Auth, Fault> {
    let plain = &STATUS_ACTIVE[..4];
    let mut auth = gh.text(&STATUS_ACTIVE).await?;
    if auth.code != 0 {
        let text = both(&auth);
        if contains_folded(&text, "unknown flag: --active")
            || contains_folded(&text, "unknown flag --active")
        {
            auth = gh.text(plain).await?;
        }
    }
    if auth.code != 0 {
        return Ok(Auth::default());
    }
    let login = active_login(&both(&auth)).map(str::to_owned);
    let all = gh.text(plain).await?;
    let mut other_accounts: Vec<String> = Vec::new();
    for (account, _) in accounts(&both(&all)) {
        if login.as_ref() != Some(&account) && !other_accounts.contains(&account) {
            other_accounts.push(account);
        }
    }
    Ok(Auth {
        authenticated: true,
        login,
        other_accounts,
    })
}

async fn git_value(git: &impl Text, key: &str) -> Result<Option<String>, Fault> {
    // Exit 1 = unset.
    let result = git.text(&["config", "--global", "--get", key]).await?;
    let value = js_trim(&result.stdout);
    Ok((result.code == 0 && !value.is_empty()).then(|| value.to_owned()))
}

async fn git_identity(git: &impl Text) -> Result<Identity, Fault> {
    let (name, email) = tokio::join!(git_value(git, "user.name"), git_value(git, "user.email"));
    Ok(Identity {
        name: name?,
        email: email?,
    })
}

/// The check: git's identity (none without git), gh's version and its sign-in (signed out without gh). Every run
/// goes to its end before a failure answers, as the TypeScript's `Promise.all` left its siblings running.
async fn check<T: Text>(gh: Option<&T>, git: Option<&T>) -> Result<Check, Fault> {
    let (identity, version, auth) = tokio::join!(
        async {
            match git {
                Some(git) => git_identity(git).await.map(Some),
                None => Ok(None),
            }
        },
        async {
            match gh {
                Some(gh) => version(gh).await,
                None => Ok(None),
            }
        },
        async {
            match gh {
                Some(gh) => status(gh).await,
                None => Ok(Auth::default()),
            }
        },
    );
    let (identity, version, auth) = (identity?, version?, auth?);
    Ok(Check {
        identity,
        status: Status {
            installed: gh.is_some(),
            version,
            authenticated: auth.authenticated,
            login: auth.login,
            other_accounts: auth.other_accounts,
        },
    })
}

/// `id` as a JavaScript safe integer.
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    // `as` is exact here: a whole number within ±2^53.
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number as i64)
}

/// A string field with JavaScript's `trim`, none when that leaves nothing.
fn trimmed<'a>(user: &'a Value, key: &str) -> Option<&'a str> {
    json::text(user, key)
        .map(js_trim)
        .filter(|text| !text.is_empty())
}

/// The signed-in account as a commit identity: its display name (or login) and its public email, or GitHub's noreply
/// address when it has none (the address GitHub itself suggests for commits).
async fn account(gh: &impl Text) -> Result<Account, Fault> {
    let result = gh.text(&["api", "user"]).await?;
    if result.code != 0 {
        return Err(said("gh_exit", &result, "gh api user failed"));
    }
    let user = json::parse(&result.stdout)?;
    if !user.is_object() && !user.is_array() {
        return Err(Fault::new("gh_json", "gh api user returned no account"));
    }
    let login = json::text(&user, "login")
        .filter(|login| !login.is_empty())
        .ok_or_else(|| Fault::new("gh_json", "gh api user returned no login"))?;
    let id = safe_integer(user.get("id")).map_or_else(String::new, |id| format!("{id}+"));
    Ok(Account {
        name: trimmed(&user, "name").unwrap_or(login).to_owned(),
        email: trimmed(&user, "email").map_or_else(
            || format!("{id}{login}@users.noreply.github.com"),
            str::to_owned,
        ),
    })
}

/// Sets git's `user.name` / `user.email` from the account, each only while it is empty; answers the keys it set and
/// the identity after.
async fn fill_identity<T: Text>(gh: Option<&T>, git: Option<&T>) -> Result<Filled, Fault> {
    let gh = gh.ok_or_else(|| Fault::new("gh_missing", NO_GH))?;
    let git = git.ok_or_else(|| Fault::new("git_missing", NO_GIT))?;
    let account = account(gh).await?;
    let current = git_identity(git).await?;
    let mut identity_filled = Vec::new();
    for (field, value, set) in [
        ("name", &account.name, &current.name),
        ("email", &account.email, &current.email),
    ] {
        if set.is_some() {
            continue;
        }
        let key = format!("user.{field}");
        let result = git.text(&["config", "--global", &key, value]).await?;
        if result.code != 0 {
            let stderr = js_trim(&result.stderr);
            let message = if stderr.is_empty() {
                format!("git config user.{field} failed")
            } else {
                stderr.to_owned()
            };
            return Err(Fault::new("git_exit", message));
        }
        identity_filled.push(field);
    }
    Ok(Filled {
        identity_filled,
        identity: git_identity(git).await?,
    })
}

/// Signs the active account out; gh ≥ 2.40 needs `--user` when several are signed in.
async fn logout(gh: &impl Text, login: Option<&str>) -> Result<(), Fault> {
    let mut result = gh.text(&LOGOUT).await?;
    if result.code != 0
        && let Some(login) = login.filter(|login| !login.is_empty())
    {
        let [auth, verb, host, name] = LOGOUT;
        result = gh.text(&[auth, verb, host, name, "--user", login]).await?;
    }
    if result.code != 0 {
        return Err(said("gh_exit", &result, "gh auth logout failed"));
    }
    Ok(())
}

async fn switch(gh: &impl Text, login: &str) -> Result<(), Fault> {
    let result = gh
        .text(&[
            "auth",
            "switch",
            "--hostname",
            "github.com",
            "--user",
            login,
        ])
        .await?;
    if result.code != 0 {
        return Err(said("gh_exit", &result, "gh auth switch failed"));
    }
    Ok(())
}

/// Sets (`set`) the account's star on `repo` (`owner/name`, `PUT /user/starred/{repo}`, answered 204), or reads it:
/// GitHub answers `GET /user/starred/{repo}` with 204 when it is starred and 404 when not, and gh exits non-zero on
/// the 404.
async fn star(gh: &impl Text, repo: &str, set: bool) -> Result<bool, Fault> {
    let path = format!("user/starred/{repo}");
    if set {
        let result = gh
            .text(&["api", "--method", "PUT", &path, "--silent"])
            .await?;
        if result.code != 0 {
            return Err(said("gh_exit", &result, "gh api star failed"));
        }
        return Ok(true);
    }
    let result = gh.text(&["api", &path, "--silent"]).await?;
    if result.code == 0 {
        return Ok(true);
    }
    let text = both(&result);
    if contains_folded(&text, "HTTP 404") || contains_folded(&text, "Not Found") {
        return Ok(false);
    }
    Err(said("gh_exit", &result, "gh api user/starred failed"))
}

/// gh and git as main found them (none when missing), and the folder they run in (the home folder).
#[derive(Deserialize)]
struct Tools {
    gh: Option<Runner>,
    #[serde(default)]
    git: Option<Runner>,
    cwd: String,
}

#[derive(Deserialize)]
struct LoginParams {
    #[serde(flatten)]
    tools: Tools,
    login: Option<String>,
}

#[derive(Deserialize)]
struct StarParams {
    #[serde(flatten)]
    tools: Tools,
    repo: String,
    star: bool,
}

/// One request's gh and git, held to its scope.
struct Runs {
    gh: Gh,
    git: Gh,
    cwd: String,
}

impl Runs {
    fn new(tools: Tools, scope: crate::server::Scope) -> Runs {
        Runs {
            gh: Gh::new(tools.gh, scope.clone()),
            git: Gh::new(tools.git, scope),
            cwd: tools.cwd,
        }
    }

    fn tool<'a>(&'a self, gh: &'a Gh) -> Option<Tool<'a>> {
        gh.exec.is_some().then_some(Tool { gh, cwd: &self.cwd })
    }

    fn gh(&self) -> Result<Tool<'_>, Fault> {
        self.tool(&self.gh)
            .ok_or_else(|| Fault::new("gh_missing", NO_GH))
    }

    /// The answer with every token of either environment cut out of its fault.
    fn answer<T: Serialize>(&self, outcome: Result<T, Fault>) -> Result<Reply, Fault> {
        self.gh.answer(
            self.git
                .answer(outcome.and_then(|value| Reply::json(&value))),
        )
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("gh.authCheck", |call| {
        Box::pin(async move {
            let runs = Runs::new(call.params()?, call.scope);
            let outcome = check(runs.tool(&runs.gh).as_ref(), runs.tool(&runs.git).as_ref()).await;
            runs.answer(outcome)
        })
    });
    registry.add("gh.authIdentity", |call| {
        Box::pin(async move {
            let runs = Runs::new(call.params()?, call.scope);
            let outcome =
                fill_identity(runs.tool(&runs.gh).as_ref(), runs.tool(&runs.git).as_ref()).await;
            runs.answer(outcome)
        })
    });
    registry.add("gh.authLogout", |call| {
        Box::pin(async move {
            let LoginParams { tools, login } = call.params()?;
            let runs = Runs::new(tools, call.scope);
            let outcome = match runs.gh() {
                Ok(gh) => logout(&gh, login.as_deref()).await,
                Err(fault) => Err(fault),
            };
            runs.answer(outcome)
        })
    });
    registry.add("gh.authSwitch", |call| {
        Box::pin(async move {
            let LoginParams { tools, login } = call.params()?;
            let runs = Runs::new(tools, call.scope);
            let outcome = match runs.gh() {
                Ok(gh) => switch(&gh, login.as_deref().unwrap_or_default()).await,
                Err(fault) => Err(fault),
            };
            runs.answer(outcome)
        })
    });
    registry.add("gh.star", |call| {
        Box::pin(async move {
            let StarParams {
                tools,
                repo,
                star: set,
            } = call.params()?;
            let runs = Runs::new(tools, call.scope);
            let outcome = match runs.gh() {
                Ok(gh) => star(&gh, &repo, set).await,
                Err(fault) => Err(fault),
            };
            runs.answer(outcome)
        })
    });
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::server::Scope;

    /// Rows captured from `src/main/github-auth/cli.ts` at the commit the file names (`capture-auth.ts`, run once and
    /// deleted): its parsers' answers and the service's sequences over a scripted gh and git.
    fn captured() -> Value {
        serde_json::from_str(include_str!("auth-captured.json")).unwrap()
    }

    /// A gh or git answering from a captured script: per argv a list of answers, the last one repeating; every call
    /// recorded, both tools into one list.
    struct Fake {
        name: &'static str,
        script: BTreeMap<String, Vec<Value>>,
        used: Mutex<HashMap<String, usize>>,
        calls: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl Fake {
        fn new(name: &'static str, script: &Value, calls: &Arc<Mutex<Vec<Vec<String>>>>) -> Fake {
            let script = script
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, answers)| {
                    let answers = match answers {
                        Value::Array(list) => list.clone(),
                        one => vec![one.clone()],
                    };
                    (key.clone(), answers)
                })
                .collect();
            Fake {
                name,
                script,
                used: Mutex::default(),
                calls: Arc::clone(calls),
            }
        }
    }

    impl Text for Fake {
        async fn text(&self, args: &[&str]) -> Result<TextOutput, Fault> {
            let mut call = vec![self.name.to_owned()];
            call.extend(args.iter().map(|arg| (*arg).to_owned()));
            let key = call.join(" ");
            self.calls.lock().unwrap().push(call);
            let Some(answers) = self.script.get(&key) else {
                return Ok(TextOutput {
                    code: 127,
                    stdout: String::new(),
                    stderr: format!("unscripted {key}"),
                });
            };
            let n = {
                let mut used = self.used.lock().unwrap();
                let n = used.entry(key).or_default();
                *n += 1;
                *n - 1
            };
            let answer = &answers[n.min(answers.len() - 1)];
            if let Some(reason) = answer.get("reject") {
                return Err(Fault::new("spawn_failed", reason.as_str().unwrap()));
            }
            Ok(TextOutput {
                code: answer["code"].as_i64().unwrap() as i32,
                stdout: answer["stdout"].as_str().unwrap().to_owned(),
                stderr: answer["stderr"].as_str().unwrap().to_owned(),
            })
        }
    }

    #[test]
    fn reads_the_active_login_as_the_typescript_did() {
        let rows = captured();
        let rows = rows["logins"].as_array().unwrap();
        assert_eq!(rows.len(), 34);
        for row in rows {
            let output = row["output"].as_str().unwrap();
            assert_eq!(active_login(output), row["login"].as_str(), "{output:?}");
        }
    }

    #[test]
    fn lists_the_signed_in_accounts_as_the_typescript_did() {
        let rows = captured();
        let rows = rows["accounts"].as_array().unwrap();
        assert_eq!(rows.len(), 23);
        for row in rows {
            let output = row["output"].as_str().unwrap();
            let want: Vec<(String, bool)> = row["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|account| {
                    (
                        account["login"].as_str().unwrap().to_owned(),
                        account["active"].as_bool().unwrap(),
                    )
                })
                .collect();
            assert_eq!(accounts(output), want, "{output:?}");
        }
    }

    /// `JSON.parse` reads `1e400` as Infinity. serde_json does too when the CLI's `arbitrary_precision` is unified into
    /// the build (`--workspace`, as `build-native.ts` builds the shipped core); the core crate built alone refuses it.
    const NUMBER_OUT_OF_RANGE: &str = "1e400";

    #[tokio::test]
    async fn runs_the_service_s_sequences_as_the_typescript_did() {
        let rows = captured();
        let rows = rows["flows"].as_array().unwrap();
        assert_eq!(rows.len(), 93);
        for row in rows {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let gh = Fake::new("gh", &row["script"], &calls);
            let git = Fake::new("git", &row["script"], &calls);
            let gh = row["gh"].as_bool().unwrap_or(true).then_some(&gh);
            let git = row["git"].as_bool().unwrap_or(true).then_some(&git);
            let missing = || Fault::new("gh_missing", NO_GH);
            let outcome: Result<Value, Fault> = match row["op"].as_str().unwrap() {
                "check" => check(gh, git).await.map(|value| json!(value)),
                "identity" => fill_identity(gh, git).await.map(|value| json!(value)),
                "logout" => match gh {
                    Some(gh) => logout(gh, row["login"].as_str())
                        .await
                        .map(|()| Value::Null),
                    None => Err(missing()),
                },
                "switch" => match gh {
                    Some(gh) => switch(gh, row["login"].as_str().unwrap())
                        .await
                        .map(|()| Value::Null),
                    None => Err(missing()),
                },
                "star" => match gh {
                    Some(gh) => star(
                        gh,
                        row["repo"].as_str().unwrap(),
                        row["star"].as_bool().unwrap(),
                    )
                    .await
                    .map(Value::Bool),
                    None => Err(missing()),
                },
                op => panic!("{op}"),
            };
            let context = serde_json::to_string(&row["script"]).unwrap();
            if row["jsonError"] == json!(true) {
                assert_eq!(outcome.unwrap_err().code, "gh_json", "{context}");
                continue;
            }
            if context.contains(NUMBER_OUT_OF_RANGE)
                && let Err(fault) = &outcome
            {
                assert_eq!(fault.code, "gh_json", "{context}");
                continue;
            }
            match row.get("error") {
                Some(error) => {
                    assert_eq!(
                        outcome.unwrap_err().message,
                        error.as_str().unwrap(),
                        "{context}"
                    )
                }
                None => assert_eq!(outcome.unwrap(), row["result"], "{context}"),
            }
            let want: Vec<Vec<String>> = serde_json::from_value(row["calls"].clone()).unwrap();
            assert_eq!(*calls.lock().unwrap(), want, "{context}");
        }
    }

    /// gh's failure text can quote a token from its environment, on stderr or stdout; the answered fault never does,
    /// whichever runner's environment held it.
    #[test]
    fn a_fault_carries_no_token_of_either_environment() {
        const TOKEN: &str = "ghp_Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8";
        let runner = |name: &str| Runner {
            bin: "gh".into(),
            args: Vec::new(),
            env: BTreeMap::from([(name.to_owned(), TOKEN.to_owned())]),
            timeout_ms: 1_000,
            max_bytes: 1_024,
        };
        for (gh, git) in [
            (Some(runner("GH_TOKEN")), None),
            (None, Some(runner("github_token"))),
        ] {
            let runs = Runs::new(
                Tools {
                    gh,
                    git,
                    cwd: "/".into(),
                },
                Scope::detached(),
            );
            let stdout = TextOutput {
                code: 1,
                stdout: format!("token {TOKEN}"),
                stderr: String::new(),
            };
            let fault = runs
                .answer::<()>(Err(said("gh_exit", &stdout, "gh auth logout failed")))
                .err()
                .unwrap();
            assert_eq!(fault.message, "token ***");
        }
    }
}
