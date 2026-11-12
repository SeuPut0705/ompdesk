//! What each spawn of a tab opens, and the crash-restart ladder (was `sessionOpen` of `src/main/omp-launch.ts` and
//! the ladder of `src/main/restart-policy.ts`; `formal/tab-session` covers both). How a spawn is assembled from main's
//! settings (`ompArgs`, `sessionEnv`) stays main's: it answers the lane's launch ask with the result.

use std::time::Duration;

use serde::Serialize;

/// Restarts in a row before a crash cycle gives up.
pub const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_DELAYS_MS: [u64; 3] = [1000, 2000, 4000];

/// The wait before restart `attempt` (1-based, up to `MAX_RESTART_ATTEMPTS`) of a crash cycle.
pub fn restart_delay(attempt: u32) -> Duration {
    let at = usize::try_from(attempt).ok().and_then(|n| n.checked_sub(1));
    Duration::from_millis(
        at.and_then(|at| RESTART_DELAYS_MS.get(at))
            .copied()
            .unwrap_or(4000),
    )
}

/// Windows ends every process of a logoff or shutdown with DBG_TERMINATE_PROCESS (0x40010004) while main
/// itself lives a few seconds longer. That is the session ending, not a crash: a respawn then dies with
/// STATUS_DLL_INIT_FAILED (0xC0000142) or hangs in startup until the machine is gone. `taskkill /f`, which
/// `terminate` uses, ends a process with exit code 1, and a POSIX exit code never exceeds 255.
pub const WINDOWS_SESSION_END_EXIT_CODE: i64 = 0x4001_0004;

/// `{ session }`: `--session <file>`; `new`: a new session in the folder (`autoResume` pinned off); `default`: omp's own.
#[derive(Clone, Debug, PartialEq)]
pub enum Open {
    Session(String),
    New,
    Default,
}

#[derive(Serialize)]
#[serde(untagged)]
enum OpenWire<'a> {
    Session { session: &'a str },
    Word(&'static str),
}

impl Serialize for Open {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Open::Session(session) => OpenWire::Session { session }.serialize(serializer),
            Open::New => OpenWire::Word("new").serialize(serializer),
            Open::Default => OpenWire::Word("default").serialize(serializer),
        }
    }
}

/// A written session is reopened. A session stock never wrote (it writes a new session's file at the first answer:
/// a tab restored or restarted before its first turn ended) opens nothing, and `--session` on it only fails ("Session
/// not found"), so the tab starts a new session in its folder, as a new tab does. Only a tab with no session at all (it
/// moved to another folder) leaves the choice to omp.
// formal/tab-session `OpenOf`: the one rule.
pub fn session_open(path: Option<&str>, is_new: bool, written: impl Fn(&str) -> bool) -> Open {
    if let Some(path) = path
        && written(path)
    {
        return Open::Session(path.to_owned());
    }
    if is_new || path.is_some() {
        Open::New
    } else {
        Open::Default
    }
}

/// Whether a session file exists (`existsSync`).
pub fn file_exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `restartDelay`'s test.
    #[test]
    fn waits_1_s_2_s_then_4_s_across_one_crash_cycle_of_three_restarts() {
        assert_eq!(MAX_RESTART_ATTEMPTS, 3);
        let delays: Vec<u128> = (1..=3).map(|n| restart_delay(n).as_millis()).collect();
        assert_eq!(delays, [1000, 2000, 4000]);
        // Past the ladder, and before it, the last rung.
        assert_eq!(restart_delay(4).as_millis(), 4000);
        assert_eq!(restart_delay(0).as_millis(), 4000);
    }

    #[test]
    fn a_windows_session_end_is_the_code_stock_exits_with() {
        assert_eq!(WINDOWS_SESSION_END_EXIT_CODE, 1_073_807_364);
    }

    /// `omp-launch.test.ts`: "opens a tab's session by the one rule, for every combination of what the tab knows".
    #[test]
    fn opens_a_tab_s_session_by_the_one_rule_for_every_combination_of_what_the_tab_knows() {
        let written = |file: &str| file == "/s/written.jsonl";
        for path in [None, Some("/s/written.jsonl"), Some("/s/unwritten.jsonl")] {
            for is_new in [false, true] {
                let open = session_open(path, is_new, written);
                match path {
                    // A written session is always reopened.
                    Some(path) if written(path) => assert_eq!(open, Open::Session(path.to_owned())),
                    // `--session` never names a file stock never wrote ("Session not found").
                    _ => assert!(!matches!(open, Open::Session(_)), "{path:?} {is_new}"),
                }
                // A new tab, or one whose session stock has not written yet, never lets autoResume pick another.
                if is_new || path.is_some() {
                    assert_ne!(open, Open::Default, "{path:?} {is_new}");
                }
            }
        }
        // The two rows of the model's `OpenOf`.
        assert_eq!(session_open(None, false, written), Open::Default);
        assert_eq!(session_open(None, true, written), Open::New);
        assert_eq!(
            session_open(Some("/s/unwritten.jsonl"), false, written),
            Open::New
        );
    }

    #[test]
    fn writes_the_open_as_main_reads_it() {
        assert_eq!(
            serde_json::to_string(&Open::Session("/s/a.jsonl".into())).unwrap(),
            "{\"session\":\"/s/a.jsonl\"}"
        );
        assert_eq!(serde_json::to_string(&Open::New).unwrap(), "\"new\"");
        assert_eq!(
            serde_json::to_string(&Open::Default).unwrap(),
            "\"default\""
        );
    }

    #[test]
    fn a_file_exists_as_exists_sync_says() {
        assert!(file_exists(
            &std::env::current_exe().unwrap().to_string_lossy()
        ));
        assert!(!file_exists("/no/such/session.jsonl"));
    }
}
