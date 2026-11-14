//! The English of an answer's notes and of a failed test's record: the one place it is written.
//!
//! The core builds the structured value (`Note`, `TestRecord`, in the contract) and derives the English an agent and
//! the logs read from it, so `Answer.notes` and `FailedTest.history` can never say what `said` and `record` do not.
//! A screen shows the structured value through its own keys and never reads the English.

use super::contract::{Answer, Note, NoteCode, TestRecord, TestState};
use crate::aimemory::value::iso;

/// The letters of a commit an English sentence names.
const SHORT_SHA: usize = 9;

impl Note {
    pub fn english(&self) -> String {
        let text = |field: &Option<String>| field.clone().unwrap_or_default();
        let number = |field: Option<u32>| field.unwrap_or_default();
        let short = |field: &Option<String>| {
            let sha = text(field);
            sha[..sha.len().min(SHORT_SHA)].to_owned()
        };
        match self.code {
            NoteCode::ReportExpired => {
                format!("the test report of job {} expired", text(&self.job))
            }
            NoteCode::ReportUnreadable => format!(
                "the test report of job {}: {}",
                text(&self.job),
                text(&self.error)
            ),
            NoteCode::RunCancelled => {
                "the run was cancelled: start it again, or wait for the run that replaced it"
                    .to_owned()
            }
            NoteCode::QuarantineEntered => format!(
                "quarantined as flaky: {} (it passed and failed on the same inputs)",
                text(&self.test)
            ),
            NoteCode::QuarantineLeft => {
                format!("left quarantine after clean runs: {}", text(&self.test))
            }
            NoteCode::QuarantinedPass => format!(
                "{} quarantined flaky test(s) failed; they do not fail this run",
                number(self.count)
            ),
            NoteCode::ReleaseBlocked => {
                "release gate: a quarantined test failed in this run, so it does not pass"
                    .to_owned()
            }
            NoteCode::JobOutsideTests => format!(
                "job \"{}\" failed outside its tests or uploaded no test report",
                text(&self.job)
            ),
            NoteCode::RerunsUsed => format!(
                "reruns of the failed jobs: {} of {} used",
                number(self.used),
                number(self.cap)
            ),
            NoteCode::Reused => format!(
                "the same commit, workflow and inputs were green in {}: nothing ran",
                text(&self.run)
            ),
            NoteCode::ReuseLost => format!("{} was green", text(&self.run)),
            NoteCode::Landed => format!("landed on {} in {}", text(&self.base), short(&self.commit)),
            NoteCode::NotLanded => {
                format!("not landed on {}: {}", text(&self.base), text(&self.error))
            }
            NoteCode::LeaseLapsed => {
                "it waited in OMPdesk's queue past its lease, with no wait renewing it: start it again"
                    .to_owned()
            }
            NoteCode::RunUnknown => {
                format!("GitHub's run for {} is not known yet", text(&self.run))
            }
            NoteCode::FactsStale => format!(
                "GitHub's facts are stale (last read at {}): {}; never green from old data",
                iso(self.at.unwrap_or_default()),
                self.error
                    .as_deref()
                    .unwrap_or("not read again in time")
            ),
            NoteCode::ResultsUnreadable => {
                format!("its results could not be read: {}", text(&self.error))
            }
            NoteCode::NoAnswerKept => "no answer kept".to_owned(),
            NoteCode::JudgedBeforeRestart => {
                "this attempt was judged before OMPdesk restarted; its answer was not kept"
                    .to_owned()
            }
            NoteCode::DispatchFailed => match &self.error {
                Some(error) => format!("its dispatch failed: {error}"),
                None => "its dispatch failed".to_owned(),
            },
            NoteCode::DispatchUnconfirmed => format!(
                "dispatch acceptance is unknown; its reserved capacity stays blocked and is not retried: {}",
                self.error.as_deref().unwrap_or("no authoritative outcome")
            ),
            NoteCode::Refused => match &self.error {
                Some(error) => format!("the check could not run: {error}"),
                None => "it was refused".to_owned(),
            },
            NoteCode::Replaced => {
                "a newer start of the same branch and workflow replaced it before it ran"
                    .to_owned()
            }
            NoteCode::WaitTimedOut => {
                format!("no result within {} s: wait again", number(self.seconds))
            }
            NoteCode::RunChanged => {
                "the run changed, or the time ran out: status shows it, wait again for the result"
                    .to_owned()
            }
            NoteCode::BranchMoved => format!(
                "GitHub ran {} ({}), not {}: the branch moved before the run started",
                short(&self.commit),
                text(&self.branch),
                short(&self.asked)
            ),
            NoteCode::RanOn => format!(
                "ran `{}` on {} with ompdesk check",
                text(&self.job),
                text(&self.device)
            ),
        }
    }
}

impl TestRecord {
    pub fn english(&self) -> String {
        let mut line = format!(
            "on {}: failed {} of {} runs in 7 days",
            self.os.word(),
            self.fails_7d,
            self.runs_7d
        );
        match self.state {
            TestState::Quarantined => line.push_str(&format!(
                "; quarantined as flaky (passed and failed on the same inputs), {} of {} clean runs",
                self.clean_runs, self.clear_after
            )),
            TestState::Cleared => line.push_str("; was flaky, cleared after clean runs"),
            TestState::Active => {}
        }
        line
    }
}

/// `Answer.notes` for a list of `said`.
pub fn english_of(said: &[Note]) -> Vec<String> {
    said.iter().map(Note::english).collect()
}

impl Answer {
    /// Adds a note to what the answer says, in both its forms.
    pub fn say(&mut self, note: Note) {
        self.notes.push(note.english());
        self.said.push(note);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::contract::samples;

    #[test]
    fn every_code_has_english_with_its_fields_filled_in() {
        let said = samples::note_samples();
        for code in NoteCode::ALL {
            assert!(
                said.iter().any(|note| note.code == *code),
                "{code:?} has no sample"
            );
        }
        for note in &said {
            let english = note.english();
            assert!(!english.is_empty(), "{:?}", note.code);
            assert!(!english.contains("{}"), "{english}");
        }
    }

    #[test]
    fn a_note_said_is_in_the_answer_twice_in_step() {
        let answer = samples::answer();
        assert_eq!(answer.said.len(), 1);
        assert_eq!(answer.notes, english_of(&answer.said));
        assert_eq!(
            answer.notes,
            ["reruns of the failed jobs: 1 of 2 used".to_owned()]
        );
        assert_eq!(
            answer.failed[0].history,
            answer.failed[0].record.as_ref().unwrap().english()
        );
    }

    #[test]
    fn a_stale_note_names_the_trouble_or_says_it_was_not_read_in_time() {
        let at = 1_794_000_100_000;
        let quiet = Note {
            at: Some(at),
            ..Note::new(NoteCode::FactsStale)
        };
        assert!(quiet.english().contains("not read again in time"));
        let with_trouble = Note {
            error: Some("gh is offline".into()),
            ..quiet
        };
        assert!(with_trouble.english().contains(": gh is offline;"));
        assert!(with_trouble.english().contains("2026-"));
    }
}
