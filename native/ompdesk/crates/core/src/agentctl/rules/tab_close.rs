//! How main closes a tab for an agent (`tab-close.ts`): the one place that decides between asking the tab's window,
//! releasing it in main and keeping it. A desktop window closes its own tab when asked and refuses one in use, with
//! unsaved Files edits or its last. A paired web page's window may have no socket, so main releases that tab itself,
//! unless a live connection of the page reported unsaved Files edits in it or the person is at it and the close was
//! not cleared by `needs_person_turn`. Pure; no seams (`FileEdits` is `web/file-edit-reports.ts`' answer, passed in).

/// What a paired page's live connections report of one tab's Files edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileEdits {
    Clean,
    Dirty,
    Unreported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TabCloseFacts {
    /// Only on a paired web page's tab: what its page's live connections report.
    pub web_edits: Option<FileEdits>,
    /// The person is looking at it.
    pub looked: bool,
    /// The person typed into it or prompted it.
    pub user_touched: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepReason {
    /// A live connection of its page reported unsaved Files edits in it.
    Dirty,
    /// The person is at it.
    InUse,
}

impl KeepReason {
    pub fn as_str(self) -> &'static str {
        match self {
            KeepReason::Dirty => "dirty",
            KeepReason::InUse => "in-use",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabCloseStep {
    /// A desktop window's tab: its renderer closes it, and applies its own guards.
    AskWindow,
    /// A paired web page's tab: main releases it as the page's own close would.
    Release,
    Keep(KeepReason),
}

/// Whether stopping, closing or deleting a tab needs a turn the person's own message started. A session the person
/// typed into always does; one they only look at does unless the caller opened it (`own`).
pub fn needs_person_turn(tab: &TabCloseFacts, own: bool) -> bool {
    tab.user_touched || (!own && tab.looked)
}

/// `cleared`: the in-use rule was checked for this close and lets it go.
pub fn tab_close_step(tab: &TabCloseFacts, cleared: bool) -> TabCloseStep {
    match tab.web_edits {
        None => TabCloseStep::AskWindow,
        Some(FileEdits::Dirty) => TabCloseStep::Keep(KeepReason::Dirty),
        Some(_) if !cleared && needs_person_turn(tab, false) => {
            TabCloseStep::Keep(KeepReason::InUse)
        }
        Some(_) => TabCloseStep::Release,
    }
}
