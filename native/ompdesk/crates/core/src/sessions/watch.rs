//! The watch of one sessions tree: raw changes from the system's one recursive watch (`source.rs`), reported once
//! they settle. An agent appends to its journal in bursts, and one report per burst is enough; every path that is due
//! at the same moment goes out in one report.
//!
//! Nothing is lost between two watches: a watch that had to wait for its root, or that started again after its source
//! ended (the root was deleted, the system refused the watch), says so (`missed`), and whoever lists the sessions then
//! reads them again.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tokio::sync::mpsc;
use tokio::time::Instant;

use super::rules;
use super::source::{self, Raw};

/// A path is reported once it has had no change for this long.
const SETTLE: Duration = Duration::from_millis(300);
/// While the root cannot be watched (omp has saved no session yet, so there is none), how often to try. A look every
/// second, not a watch of the parent, whose own FSEvents stream could start after the root was made and never report it.
const ROOT_POLL: Duration = Duration::from_secs(1);

/// What a watch says, in order.
pub enum Report {
    /// The tree is watched from now on. `missed`: it was not before (the root was not there yet, or an earlier watch
    /// of it ended), so anything may have changed meanwhile.
    Watching { missed: bool },
    /// The watch ended by itself; it is tried again every second.
    Unwatched,
    /// These entries settled: a session file, or a project or session folder, that appeared, changed or went.
    Changed(Vec<Settled>),
    /// The system dropped changes: anything may have changed.
    Anything,
}

pub struct Settled {
    /// Relative to the root, the system's separator between segments.
    pub name: String,
    /// Whether nothing is at that path any more (deleted, or renamed away with the sessions in it).
    pub gone: bool,
}

/// A running watch; dropping it stops it.
pub struct Watch(tokio::task::JoinHandle<()>);

impl Drop for Watch {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Watches `root` until the returned value is dropped, waiting for the root while it is not there.
pub fn spawn(root: PathBuf, report: impl Fn(Report) + Send + Sync + 'static) -> Watch {
    Watch(tokio::spawn(run(root, report)))
}

async fn run(root: PathBuf, report: impl Fn(Report) + Send + Sync + 'static) {
    let mut missed = false;
    let mut refused = false;
    loop {
        let (changes, mut raw) = mpsc::unbounded_channel();
        let started = source::start(&root, move |change| {
            let _ = changes.send(change);
        });
        match started {
            Ok(source) => {
                refused = false;
                report(Report::Watching { missed });
                let why = settle(&root, &mut raw, &report).await;
                drop(source);
                eprintln!("ompdesk-core: the watch of {} ended: {why}", root.display());
                report(Report::Unwatched);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                if !refused {
                    eprintln!("ompdesk-core: not watching {}: {error}", root.display());
                }
                refused = true;
            }
        }
        missed = true;
        tokio::time::sleep(ROOT_POLL).await;
    }
}

/// A file's or folder's modification time and size.
type Signature = (Option<SystemTime>, u64);

/// Reports what settles until the source ends; returns why it ended.
async fn settle(
    root: &Path,
    raw: &mut mpsc::UnboundedReceiver<Raw>,
    report: &(impl Fn(Report) + Sync),
) -> String {
    // Every change of a name, oldest first, and the latest of each name: the one that counts.
    let mut waiting: VecDeque<(Instant, String)> = VecDeque::new();
    let mut due: HashMap<String, Instant> = HashMap::new();
    // What each path looked like when it was last reported: a change that moved neither its time nor its size (its
    // access time) reports nothing.
    let mut reported: HashMap<String, Signature> = HashMap::new();
    loop {
        let next = waiting.front().map(|(at, _)| *at);
        tokio::select! {
            change = raw.recv() => match change {
                None => return "its source stopped".into(),
                Some(Raw::Ended(why)) => return why,
                Some(Raw::Anything) => report(Report::Anything),
                Some(Raw::Names(names)) => {
                    let at = Instant::now() + SETTLE;
                    for name in names {
                        if name.is_empty() {
                            // The root itself changed: when it went, so did this watch of it.
                            if !root.is_dir() {
                                return "its folder is gone".into();
                            }
                        } else if rules::watched(&name) {
                            due.insert(name.clone(), at);
                            waiting.push_back((at, name));
                        }
                    }
                }
            },
            () = tokio::time::sleep_until(next.unwrap_or_else(Instant::now)), if next.is_some() => {
                let now = Instant::now();
                let mut names = Vec::new();
                while waiting.front().is_some_and(|(at, _)| *at <= now) {
                    let Some((at, name)) = waiting.pop_front() else { break };
                    // Not the latest change of that name: the latest is further back, or already taken.
                    if due.get(&name) == Some(&at) {
                        due.remove(&name);
                        names.push(name);
                    }
                }
                let Ok((looked, root_gone)) = look(root.to_path_buf(), names).await else {
                    return "its reader panicked".into();
                };
                let mut settled = Vec::new();
                for (name, now) in looked {
                    match now {
                        None => {
                            reported.remove(&name);
                            settled.push(Settled { name, gone: true });
                        }
                        Some((folder, signature)) => {
                            // Beside the session files only folders move sessions; any other file there is not one.
                            if !folder && !name.ends_with(".jsonl") {
                                continue;
                            }
                            if reported.get(&name) == Some(&signature) {
                                continue;
                            }
                            reported.insert(name.clone(), signature);
                            settled.push(Settled { name, gone: false });
                        }
                    }
                }
                if !settled.is_empty() {
                    report(Report::Changed(settled));
                }
                if root_gone {
                    return "its folder is gone".into();
                }
            }
        }
    }
}

/// What is at each name now (`None`: nothing), and whether the root itself is gone, which is only looked at when a
/// name is: each change names its path, so nothing else is read and an agent streaming into one file never walks
/// the tree.
async fn look(
    root: PathBuf,
    names: Vec<String>,
) -> Result<(Vec<(String, Option<(bool, Signature)>)>, bool), tokio::task::JoinError> {
    tokio::task::spawn_blocking(move || {
        let looked: Vec<_> = names
            .into_iter()
            .map(|name| {
                let now = std::fs::symlink_metadata(root.join(&name))
                    .ok()
                    .map(|meta| (meta.is_dir(), (meta.modified().ok(), meta.len())));
                (name, now)
            })
            .collect();
        let root_gone = looked.iter().any(|(_, now)| now.is_none()) && !root.is_dir();
        (looked, root_gone)
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    /// As long as a report may take on a busy machine; a test that passes never waits this long.
    const PATIENCE: Duration = Duration::from_secs(30);

    /// A watched temp root and what its watch reported.
    struct Rig {
        root: PathBuf,
        reports: mpsc::UnboundedReceiver<Report>,
        watch: Option<Watch>,
        /// Names reported so far (the system's separator turned into `/`), and how many times anything may have changed.
        named: Vec<String>,
        gone: Vec<String>,
        anything: usize,
    }

    impl Rig {
        /// `made`: whether the root exists before the watch starts.
        fn new(made: bool) -> Rig {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let root = std::env::temp_dir().join(format!(
                "ompdesk-core-watch-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            if made {
                fs::create_dir_all(&root).unwrap();
            }
            let (sender, reports) = mpsc::unbounded_channel();
            let watch = spawn(root.clone(), move |report| {
                let _ = sender.send(report);
            });
            Rig {
                root,
                reports,
                watch: Some(watch),
                named: Vec::new(),
                gone: Vec::new(),
                anything: 0,
            }
        }

        fn path(&self, name: &str) -> PathBuf {
            name.split('/')
                .fold(self.root.clone(), |path, part| path.join(part))
        }

        fn write(&self, name: &str, text: &str) {
            fs::write(self.path(name), text).unwrap();
        }

        /// The next report; `Changed` and `Anything` are also added to what was seen.
        async fn next(&mut self) -> Report {
            let report = tokio::time::timeout(PATIENCE, self.reports.recv())
                .await
                .expect("a report in time")
                .expect("the watch still runs");
            match &report {
                Report::Changed(settled) => {
                    for entry in settled {
                        let name = entry.name.replace('\\', "/");
                        if entry.gone {
                            self.gone.push(name.clone());
                        }
                        self.named.push(name);
                    }
                }
                Report::Anything => self.anything += 1,
                Report::Watching { .. } | Report::Unwatched => {}
            }
            report
        }

        /// Waits until every one of `names` was reported.
        async fn named(&mut self, names: &[&str]) {
            while !names
                .iter()
                .all(|name| self.named.iter().any(|seen| seen == name))
            {
                self.next().await;
            }
        }

        /// Waits until every one of `names` was reported as gone.
        async fn gone(&mut self, names: &[&str]) {
            while !names
                .iter()
                .all(|name| self.gone.iter().any(|seen| seen == name))
            {
                self.next().await;
            }
        }

        /// Waits for `Watching` and returns its `missed`.
        async fn watching(&mut self) -> bool {
            loop {
                if let Report::Watching { missed } = self.next().await {
                    return missed;
                }
            }
        }

        /// The system starts delivering a moment after the watch is made (FSEvents): a probe is rewritten until it
        /// is reported. After this, every change is.
        async fn live(&mut self) {
            assert!(!self.watching().await);
            let mut round = 0;
            while !self.named.iter().any(|name| name == "probe.jsonl") {
                round += 1;
                self.write("probe.jsonl", &"{}\n".repeat(round));
                let _ = tokio::time::timeout(Duration::from_secs(1), self.next()).await;
                assert!(round < 30, "the watch never reported a write");
            }
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            self.watch.take();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_session_files_at_both_depths_and_no_file_beside_them() {
        let mut rig = Rig::new(true);
        fs::create_dir_all(rig.path("project-x/session-one")).unwrap();
        rig.write("project-x/session-one/tool-output.md", "before\n");
        rig.live().await;
        // Each other file is written before a session file beside it, so a report of it would come first.
        rig.write("project-x/session-one/plan.md", "a plan\n");
        rig.write("project-x/session-one/subagent.jsonl", "{}\n");
        rig.named(&["project-x/session-one/subagent.jsonl"]).await;
        rig.write("project-x/session-one/plan.md", "a longer plan\n");
        rig.write("project-x/plan.md", "a plan beside the sessions\n");
        fs::create_dir_all(rig.path("project-x/session-one/deep")).unwrap();
        rig.write("project-x/session-one/deep/too-deep.jsonl", "{}\n");
        rig.write("project-x/session-two.jsonl", "{}\n");
        rig.named(&["project-x/session-two.jsonl"]).await;
        assert!(
            !rig.named
                .iter()
                .any(|name| name.ends_with(".md") || name.contains("deep")),
            "{:?}",
            rig.named
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_nothing_for_a_change_that_moved_neither_time_nor_size() {
        let mut rig = Rig::new(true);
        fs::create_dir_all(rig.path("p")).unwrap();
        rig.live().await;
        rig.write("p/a.jsonl", "{}\n");
        rig.named(&["p/a.jsonl"]).await;
        let times = |rig: &Rig| rig.named.iter().filter(|name| *name == "p/a.jsonl").count();
        let before = times(&rig);
        // The same bytes again, then the time they had: changes the system reports and the watch does not.
        let modified = fs::metadata(rig.path("p/a.jsonl"))
            .unwrap()
            .modified()
            .unwrap();
        rig.write("p/a.jsonl", "{}\n");
        let file = fs::OpenOptions::new()
            .write(true)
            .open(rig.path("p/a.jsonl"))
            .unwrap();
        file.set_modified(modified).unwrap();
        drop(file);
        rig.write("p/b.jsonl", "{}\n");
        rig.named(&["p/b.jsonl"]).await;
        assert_eq!(times(&rig), before, "{:?}", rig.named);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_both_names_of_a_renamed_session_and_a_folder_renamed_with_its_sessions() {
        let mut rig = Rig::new(true);
        fs::create_dir_all(rig.path("project-old")).unwrap();
        rig.write("project-old/a.jsonl", "{}\n");
        rig.live().await;
        fs::rename(
            rig.path("project-old/a.jsonl"),
            rig.path("project-old/b.jsonl"),
        )
        .unwrap();
        rig.named(&["project-old/a.jsonl", "project-old/b.jsonl"])
            .await;
        rig.gone(&["project-old/a.jsonl"]).await;
        // Stock's cwd-encoding migration moves a whole project folder: no session file has a change of its own.
        fs::rename(rig.path("project-old"), rig.path("project-new")).unwrap();
        rig.named(&["project-new"]).await;
        rig.gone(&["project-old"]).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_a_deleted_folder_and_the_sessions_in_it() {
        let mut rig = Rig::new(true);
        fs::create_dir_all(rig.path("project-x/session")).unwrap();
        rig.write("project-x/a.jsonl", "{}\n");
        rig.write("project-x/session/sub.jsonl", "{}\n");
        rig.live().await;
        fs::remove_dir_all(rig.path("project-x")).unwrap();
        rig.gone(&["project-x"]).await;
        // The root is still there, so the watch is: the next session is reported.
        fs::create_dir_all(rig.path("project-y")).unwrap();
        rig.write("project-y/b.jsonl", "{}\n");
        rig.named(&["project-y/b.jsonl"]).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn loses_none_of_a_burst_of_a_thousand_writes() {
        let mut rig = Rig::new(true);
        for project in 0..10 {
            fs::create_dir_all(rig.path(&format!("project-{project}"))).unwrap();
        }
        rig.live().await;
        let names: Vec<String> = (0..1000)
            .map(|n| format!("project-{}/session-{n}.jsonl", n % 10))
            .collect();
        for name in &names {
            rig.write(name, "{}\n");
        }
        // Each write is named, or the system dropped changes and said so; then whoever lists reads again.
        let mut round = 1;
        rig.write("project-0/last.jsonl", "{}\n");
        while !rig.named.iter().any(|name| name == "project-0/last.jsonl") {
            if tokio::time::timeout(Duration::from_secs(2), rig.next())
                .await
                .is_err()
            {
                // Nothing more comes: the last write was among the changes the system dropped.
                assert!(
                    rig.anything > 0,
                    "the last write was neither named nor covered"
                );
                round += 1;
                rig.write("project-0/last.jsonl", &"{}\n".repeat(round));
            }
        }
        let unnamed = names
            .iter()
            .filter(|name| !rig.named.contains(name))
            .count();
        assert!(
            unnamed == 0 || rig.anything > 0,
            "{unnamed} writes were neither named nor covered"
        );
        println!(
            "1 000 writes: {} named, anything may have changed {} times",
            1000 - unnamed,
            rig.anything
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_root_made_later_is_watched_and_says_it_missed_what_came_before() {
        let mut rig = Rig::new(false);
        // omp makes the root, a project and its first session together: only a fresh list finds that one.
        fs::create_dir_all(rig.path("project-x")).unwrap();
        rig.write("project-x/first.jsonl", "{}\n");
        assert!(rig.watching().await);
        let mut round = 0;
        while !rig
            .named
            .iter()
            .any(|name| name == "project-x/second.jsonl")
        {
            round += 1;
            rig.write("project-x/second.jsonl", &"{}\n".repeat(round));
            let _ = tokio::time::timeout(Duration::from_secs(1), rig.next()).await;
            assert!(round < 30, "the watch never reported a write");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_root_deleted_and_remade_is_watched_again_and_says_it_missed_the_time_between() {
        let mut rig = Rig::new(true);
        fs::create_dir_all(rig.path("project-x")).unwrap();
        rig.write("project-x/a.jsonl", "{}\n");
        rig.live().await;
        fs::remove_dir_all(&rig.root).unwrap();
        loop {
            if let Report::Unwatched = rig.next().await {
                break;
            }
        }
        // Written while nothing watches: no change names it, the next watch's `missed` covers it.
        fs::create_dir_all(rig.path("project-x")).unwrap();
        rig.write("project-x/between.jsonl", "{}\n");
        assert!(rig.watching().await);
        let mut round = 0;
        while !rig.named.iter().any(|name| name == "project-x/after.jsonl") {
            round += 1;
            rig.write("project-x/after.jsonl", &"{}\n".repeat(round));
            let _ = tokio::time::timeout(Duration::from_secs(1), rig.next()).await;
            assert!(round < 30, "the watch never reported a write");
        }
    }

    /// Windows keeps what changes between two reads and says when it dropped it: both are what "nothing is lost"
    /// rests on there, so they are checked on the system call itself, with a buffer too small for the burst.
    #[cfg(windows)]
    #[test]
    fn windows_names_every_change_after_open_or_says_it_dropped_them() {
        use crate::sys::{DirChange, DirChanges};

        let root =
            std::env::temp_dir().join(format!("ompdesk-core-changes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("p")).unwrap();
        let (mut changes, stop) = DirChanges::open(&root, 1024).unwrap();
        // Written before the first `next`: the read `open` made holds it.
        fs::write(root.join("p").join("first.jsonl"), "{}\n").unwrap();
        let DirChange::Names(names) = changes.next().unwrap() else {
            panic!("the first change was not named");
        };
        assert!(names.contains(&"p\\first.jsonl".to_owned()), "{names:?}");
        // Far more than 1 KiB of names between two reads.
        for n in 0..200 {
            fs::write(root.join("p").join(format!("burst-{n}.jsonl")), "{}\n").unwrap();
        }
        let mut dropped = false;
        let mut named = 0;
        fs::write(root.join("p").join("last.jsonl"), "{}\n").unwrap();
        loop {
            match changes.next().unwrap() {
                DirChange::Overflow => dropped = true,
                DirChange::Names(names) => {
                    named += names
                        .iter()
                        .filter(|name| name.starts_with("p\\burst-"))
                        .count();
                    if names.contains(&"p\\last.jsonl".to_owned()) {
                        break;
                    }
                }
                DirChange::Stopped => panic!("nobody stopped it"),
            }
            if dropped {
                // Whatever came before the drop is covered by it; from here on changes are named again.
                fs::write(root.join("p").join("last.jsonl"), "{}\n{}\n").unwrap();
            }
        }
        assert!(dropped || named >= 200, "{named} named and nothing dropped");
        stop.stop();
        assert!(matches!(changes.next().unwrap(), DirChange::Stopped));
        drop(changes);
        // The folder going ends the read with the system's error.
        let (mut changes, _stop) = DirChanges::open(&root, 1024).unwrap();
        fs::remove_dir_all(&root).unwrap();
        loop {
            match changes.next() {
                Err(_) => break,
                Ok(DirChange::Stopped) => panic!("nobody stopped it"),
                Ok(_) => {}
            }
        }
    }
}
