//! `gui_visualize` on this computer's Preview pages (panels-sidebar › Agent visuals; `src/main/preview/visuals.ts` and
//! `preview-check.ts`, the TypeScript this replaced): one tool call of a tab is `preview.visualize`, and its text is
//! what the agent reads. Opening a visual stores it and asks Node to reveal it in the tab's window; `check` reports the
//! page showing it; `choose` waits for the user's click on a `data-choice` element (C143: only a real click counts, never
//! the agent's browser or a script's); and a just-opened page gets the Preview check, a judge model's look at it.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use base64::Engine;
use serde_json::{Value, json};
use shell_core::preview_core::page_tools::{self, PAGE_WORLD};
use shell_core::preview_core::visuals::{
    Choice, PREVIEW_CHECK_IMAGE_MAX, PageInfo, Problem, ToolArgs, ToolText, Verdict, check_text,
    choose_text, choose_timeout_ms, close_text, error_text, invalid_args_text, not_in_tab_text,
    open_text, parse_tool_args,
};

use super::host::{self, GESTURE_WINDOW_MS, HostRef, Notice, PageRef, Session};
use super::{ctx, page as cef_page, scheme};
use crate::host::Call;
use crate::log::log;

/// A page that finished loading paints its last frame within this long (late scripts, fonts, layout).
const CHECK_SETTLE_MS: i64 = 300;
/// Until the page is on screen, loaded and settled; later the capture is given up.
const CHECK_CAPTURE_MS: f64 = 2000.0;
/// `reveal` makes a window show the visual only when its tab is in front, so a tab behind never gets its page on screen:
/// the capture does not wait for it past this.
const CHECK_BEHIND_MS: f64 = 400.0;
/// The whole check (probe + page + settle + judge) holds the tool's answer at most this long.
const CHECK_TOTAL_MS: f64 = 4000.0;
/// Asking the tab's omp whether a native judge would answer at all; no answer in time counts as "no".
const CHECK_PROBE_MS: f64 = 1500.0;
/// The capture looks for its page this often, and gives the screenshot at least this long.
const CAPTURE_POLL_MS: f64 = 50.0;
const CAPTURE_MIN_MS: f64 = 500.0;

thread_local! {
    static NEXT: Cell<u64> = const { Cell::new(1) };
    static CHECKS: RefCell<HashMap<u64, Check>> = RefCell::new(HashMap::new());
    static CAPTURES: RefCell<HashMap<u64, Capture>> = RefCell::new(HashMap::new());
    static CHOICES: RefCell<HashMap<u64, Waiting>> = RefCell::new(HashMap::new());
}

fn next_id() -> u64 {
    NEXT.with(|n| n.replace(n.get() + 1))
}

fn answer(call: Call, text: ToolText) {
    call.ok(json!({ "text": text.text, "isError": text.is_error }));
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `preview.visualize`: one `gui_visualize` call of tab `tabId`.
pub(super) fn run(call: Call) {
    let tab = text_of(&call.params, "tabId");
    let args = call.params.get("args").cloned().unwrap_or(Value::Null);
    let tool = match parse_tool_args(&args) {
        Ok(tool) => tool,
        Err(error) => return answer(call, invalid_args_text(&error)),
    };
    let visual = match &tool {
        ToolArgs::Open(_) => None,
        ToolArgs::Check { visual }
        | ToolArgs::Close { visual }
        | ToolArgs::Choose { visual, .. } => Some(visual.clone()),
    };
    if let Some(visual) = &visual
        && !scheme::store().for_tab(&tab).contains(visual)
    {
        return answer(call, not_in_tab_text(visual));
    }
    match tool {
        ToolArgs::Open(input) => {
            let cwd = text_of(&call.params, "cwd");
            let judge = call
                .params
                .get("judge")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let in_front = call
                .params
                .get("inFront")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // Reading the target and writing the version are disk work: a thread of its own.
            let spawned = std::thread::Builder::new()
                .name("preview-visual-open".into())
                .spawn(move || {
                    let result = scheme::store().open(&tab, &cwd, &input, host::now_ms());
                    crate::ui::post(move || match result {
                        Err(error) => answer(call, error_text(&error)),
                        Ok(opened) => {
                            let visual = opened.record.id.clone();
                            ctx().emit("reveal", json!({ "tabId": tab, "visualId": visual }));
                            check(
                                &tab,
                                &visual,
                                opened.version,
                                judge,
                                in_front,
                                move |verdict| {
                                    answer(
                                        call,
                                        open_text(
                                            &opened.record,
                                            opened.version,
                                            opened.added,
                                            verdict,
                                        ),
                                    );
                                },
                            );
                        }
                    });
                });
            if let Err(error) = spawned {
                log(
                    "preview.visualize_failed",
                    json!({ "message": error.to_string() }),
                );
            }
        }
        ToolArgs::Close { visual } => {
            scheme::store().remove_from_tab(&tab, &visual);
            close(&visual);
            answer(call, close_text(&visual));
        }
        ToolArgs::Check { visual } => answer(call, check_text(inspect(&visual).as_ref())),
        ToolArgs::Choose {
            visual,
            timeout_seconds,
        } => {
            choose(&visual, choose_timeout_ms(timeout_seconds), move |choice| {
                answer(call, choose_text(&choice));
            });
        }
    }
}

// ------------------------------------------------------------------ the pages showing a visual

/// The first page showing `visual` (a host's shown page first), or none.
fn find_visual(visual: &str) -> Option<(HostRef, PageRef)> {
    let shows = |page: &PageRef| {
        page.borrow()
            .visual
            .as_ref()
            .is_some_and(|(id, _)| id == visual)
    };
    for host in host::hosts() {
        let found = {
            let active = host::active_page(&host);
            if shows(&active) {
                Some(active)
            } else {
                host.borrow().pages.iter().find(|p| shows(p)).cloned()
            }
        };
        if let Some(page) = found {
            return Some((host, page));
        }
    }
    None
}

/// The visual-session page showing `version` of `visual`. A web visual (an http(s) address) is never one: it lives in
/// the session the person browses, keeps its visual after they navigate elsewhere, and a re-open of the same version
/// does not reload it, so its pixels may be a site they moved to.
fn visual_session_page(visual: &str, version: u64) -> Option<(HostRef, PageRef)> {
    for host in host::hosts() {
        let found = host
            .borrow()
            .pages
            .iter()
            .find(|page| {
                let p = page.borrow();
                p.visual
                    .as_ref()
                    .is_some_and(|(id, v)| id == visual && *v == version)
                    && p.state.session == Session::Visual
                    && cef_page::exists(p.wc_id)
            })
            .cloned();
        if let Some(page) = found {
            return Some((host, page));
        }
    }
    None
}

/// That page when it is on screen, whether or not it finished loading: a page that is not on screen captures as nothing
/// or as a stale frame, and is never judged.
fn on_screen_visual_page(visual: &str, version: u64) -> Option<(HostRef, PageRef)> {
    let (host, page) = visual_session_page(visual, version)?;
    let shown = {
        let h = host.borrow();
        h.active == page.borrow().wc_id && h.layout.as_ref().is_some_and(|l| l.visible)
    };
    shown.then_some((host, page))
}

/// The on-screen page that also finished loading.
fn shown_visual_page(visual: &str, version: u64) -> Option<(HostRef, PageRef)> {
    let (host, page) = on_screen_visual_page(visual, version)?;
    let ready = {
        let p = page.borrow();
        !p.state.url.is_empty() && !p.state.loading && p.state.error.is_none() && !p.state.crashed
    };
    ready.then_some((host, page))
}

/// What the preview reports about the page showing `visual`.
fn inspect(visual: &str) -> Option<PageInfo> {
    let (_, page) = find_visual(visual)?;
    let p = page.borrow();
    Some(PageInfo {
        title: p.state.title.clone(),
        url: p.state.url.clone(),
        loading: p.state.loading,
        problems: p
            .state
            .problems
            .iter()
            .map(|problem| Problem {
                level: problem.level.clone(),
                message: problem.message.clone(),
                source: problem.source.clone(),
                line: problem.line,
            })
            .collect(),
    })
}

/// Close every preview tab showing it.
fn close(visual: &str) {
    for host in host::hosts() {
        let pages: Vec<PageRef> = host
            .borrow()
            .pages
            .iter()
            .filter(|p| {
                p.borrow()
                    .visual
                    .as_ref()
                    .is_some_and(|(id, _)| id == visual)
            })
            .cloned()
            .collect();
        for page in pages {
            host::remove_page(&host, &page);
        }
    }
}

/// A quiet notice on the page showing `version` of the visual: what the judge saw.
fn flag(visual: &str, version: u64, problem: Verdict) {
    let Some((host, page)) = shown_visual_page(visual, version) else {
        return;
    };
    // Another notice (a refused download or link, an unresponsive page) is the more urgent one and stays.
    if page.borrow().state.notice.is_some() {
        return;
    }
    let problem = match problem {
        Verdict::Error => "error",
        Verdict::Blank => "blank",
    }
    .to_owned();
    host::publish(&host, &page, move |s| {
        s.notice = Some(Notice::Check { problem })
    });
}

// ------------------------------------------------------------------ capture

/// What a capture answers: the PNG, or none.
type CaptureDone = Box<dyn FnOnce(Option<Vec<u8>>)>;

/// The visual's own page as a PNG once it is on screen, loaded and settled (never the window: only that page's pixels);
/// none when there is none within `budget_ms`, or when no window has put it on screen within `appear_ms`.
struct Capture {
    visual: String,
    version: u64,
    started: f64,
    deadline: f64,
    appear_ms: f64,
    done: Option<CaptureDone>,
}

fn capture(
    visual: &str,
    version: u64,
    budget_ms: f64,
    appear_ms: f64,
    done: impl FnOnce(Option<Vec<u8>>) + 'static,
) {
    let id = next_id();
    let now = host::clock_ms();
    CAPTURES.with(|c| {
        c.borrow_mut().insert(
            id,
            Capture {
                visual: visual.to_owned(),
                version,
                started: now,
                deadline: now + budget_ms,
                appear_ms,
                done: Some(Box::new(done)),
            },
        );
    });
    poll_capture(id);
}

fn capture_of(id: u64) -> Option<(String, u64, f64, f64, f64)> {
    CAPTURES.with(|c| {
        c.borrow().get(&id).map(|c| {
            (
                c.visual.clone(),
                c.version,
                c.started,
                c.deadline,
                c.appear_ms,
            )
        })
    })
}

fn finish_capture(id: u64, png: Option<Vec<u8>>) {
    let done = CAPTURES
        .with(|c| c.borrow_mut().remove(&id))
        .and_then(|mut c| c.done.take());
    if let Some(done) = done {
        done(png);
    }
}

fn poll_capture(id: u64) {
    let Some((visual, version, started, _, appear_ms)) = capture_of(id) else {
        return;
    };
    if let Some((_, page)) = shown_visual_page(&visual, version) {
        let wc_id = page.borrow().wc_id;
        crate::ui::post_delayed(CHECK_SETTLE_MS, move || settled(id, wc_id));
        return;
    }
    if on_screen_visual_page(&visual, version).is_none() && host::clock_ms() - started >= appear_ms
    {
        // No window has put it on screen within what the caller allows: waiting longer would only delay the tool.
        return finish_capture(id, None);
    }
    look_again(id);
}

/// Another look in `CAPTURE_POLL_MS`, unless that is past the deadline.
fn look_again(id: u64) {
    let Some((_, _, _, deadline, _)) = capture_of(id) else {
        return;
    };
    if host::clock_ms() + CAPTURE_POLL_MS >= deadline {
        return finish_capture(id, None);
    }
    crate::ui::post_delayed(CAPTURE_POLL_MS as i64, move || poll_capture(id));
}

/// The page had `CHECK_SETTLE_MS` to paint its last frame: a reload, a newer version or a tab switch during it starts
/// the wait again.
fn settled(id: u64, wc_id: u64) {
    let Some((visual, version, _, deadline, _)) = capture_of(id) else {
        return;
    };
    let same =
        shown_visual_page(&visual, version).is_some_and(|(_, page)| page.borrow().wc_id == wc_id);
    if !same {
        return look_again(id);
    }
    // The screenshot's own bound: a page that never answers does not hold the check past its deadline.
    let wait = host::clock_ms();
    let allowed = (deadline - wait).max(CAPTURE_MIN_MS);
    crate::ui::post_delayed(allowed.ceil() as i64, move || finish_capture(id, None));
    // The picture is taken at the bound `judge_image` holds it to: only ever one within it.
    cef_page::viewport_size(wc_id, move |size| {
        let factor = cef_page::zoom_factor(wc_id);
        let scale = size
            .map(|(w, h)| shell_core::preview_core::js::max(w, h) * factor)
            .filter(|longer| *longer > f64::from(PREVIEW_CHECK_IMAGE_MAX))
            .map_or(1.0, |longer| f64::from(PREVIEW_CHECK_IMAGE_MAX) / longer);
        cef_page::capture(wc_id, None, scale, move |png| finish_capture(id, png));
    });
}

// ------------------------------------------------------------------ the Preview check

#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    Probe,
    Capture,
    Judge,
}

/// One Preview check in progress.
struct Check {
    tab: String,
    visual: String,
    version: u64,
    in_front: bool,
    started: f64,
    step: Step,
    done: Option<Box<dyn FnOnce(Option<Verdict>)>>,
}

/// After `gui_visualize open` loaded a page, the judge model looks at that one page and says whether it shows an error
/// or nothing; on a problem the page also gets its notice. With the switch off (`judge` false) nothing happens. The
/// answer comes within `CHECK_TOTAL_MS` whatever happens: every other outcome is none.
fn check(
    tab: &str,
    visual: &str,
    version: u64,
    judge: bool,
    in_front: bool,
    done: impl FnOnce(Option<Verdict>) + 'static,
) {
    if !judge {
        return done(None);
    }
    let id = next_id();
    CHECKS.with(|c| {
        c.borrow_mut().insert(
            id,
            Check {
                tab: tab.to_owned(),
                visual: visual.to_owned(),
                version,
                in_front,
                started: host::clock_ms(),
                step: Step::Probe,
                done: Some(Box::new(done)),
            },
        );
    });
    crate::ui::post_delayed(CHECK_TOTAL_MS as i64, move || finish_check(id, None));
    // No answer in time counts as "no": a user with the switch on but no native judge loses no time.
    crate::ui::post_delayed(CHECK_PROBE_MS as i64, move || {
        if CHECKS.with(|c| {
            c.borrow()
                .get(&id)
                .is_some_and(|c| matches!(c.step, Step::Probe))
        }) {
            finish_check(id, None);
        }
    });
    ctx().ask(
        "judgeAvailable",
        json!({ "tabId": tab, "budgetMs": CHECK_PROBE_MS }),
        None,
        move |result, _| {
            let available = result
                .ok()
                .and_then(|v| v.get("available").and_then(Value::as_bool))
                .unwrap_or(false);
            crate::ui::post(move || probed(id, available));
        },
    );
}

fn finish_check(id: u64, verdict: Option<Verdict>) {
    let done = CHECKS
        .with(|c| c.borrow_mut().remove(&id))
        .and_then(|mut c| c.done.take());
    if let Some(done) = done {
        done(verdict);
    }
}

fn step_is(id: u64, step: Step) -> bool {
    CHECKS.with(|c| c.borrow().get(&id).is_some_and(|c| c.step == step))
}

fn set_step(id: u64, step: Step) {
    CHECKS.with(|c| {
        if let Some(check) = c.borrow_mut().get_mut(&id) {
            check.step = step;
        }
    });
}

fn probed(id: u64, available: bool) {
    if !step_is(id, Step::Probe) {
        return;
    }
    if !available {
        return finish_check(id, None);
    }
    let Some((visual, version, in_front)) = CHECKS.with(|c| {
        c.borrow()
            .get(&id)
            .map(|c| (c.visual.clone(), c.version, c.in_front))
    }) else {
        return;
    };
    set_step(id, Step::Capture);
    let appear = if in_front {
        CHECK_CAPTURE_MS
    } else {
        CHECK_BEHIND_MS
    };
    capture(&visual, version, CHECK_CAPTURE_MS, appear, move |png| {
        captured(id, png)
    });
}

fn captured(id: u64, png: Option<Vec<u8>>) {
    if !step_is(id, Step::Capture) {
        return;
    }
    let Some(png) = png else {
        return finish_check(id, None);
    };
    let Some((tab, started)) =
        CHECKS.with(|c| c.borrow().get(&id).map(|c| (c.tab.clone(), c.started)))
    else {
        return;
    };
    set_step(id, Step::Judge);
    let image = base64::engine::general_purpose::STANDARD.encode(png);
    let budget = (CHECK_TOTAL_MS - (host::clock_ms() - started)).max(0.0);
    let params = json!({ "tabId": tab, "image": { "data": image, "mimeType": "image/png" }, "budgetMs": budget });
    ctx().ask("judge", params, None, move |result, _| {
        let reply = result.ok();
        let judged = reply
            .as_ref()
            .and_then(|v| v.get("judged").and_then(Value::as_bool))
            == Some(true);
        let problem = match reply
            .as_ref()
            .and_then(|v| v.get("problem").and_then(Value::as_str))
        {
            Some("error") => Some(Verdict::Error),
            Some("blank") => Some(Verdict::Blank),
            _ => None,
        };
        crate::ui::post(move || judged_by(id, judged, problem));
    });
}

fn judged_by(id: u64, judged: bool, problem: Option<Verdict>) {
    if !step_is(id, Step::Judge) {
        return;
    }
    let Some((visual, version)) =
        CHECKS.with(|c| c.borrow().get(&id).map(|c| (c.visual.clone(), c.version)))
    else {
        return;
    };
    match problem.filter(|_| judged) {
        Some(problem) => {
            flag(&visual, version, problem);
            finish_check(id, Some(problem));
        }
        None => finish_check(id, None),
    }
}

// ------------------------------------------------------------------ choose

/// A `choose` call waiting for the user's click on one of the page's `data-choice` elements.
struct Waiting {
    visual: String,
    wc_id: u64,
    deadline: f64,
    /// Which run or wait is current: an older one's answer or expiry is dropped.
    round: u64,
    waiting_load: bool,
    done: Option<Box<dyn FnOnce(Choice)>>,
}

/// Wait for a real click on one of the visual's page's `data-choice` elements: the choice, or why there is none (`None`
/// = no page shows it, `Agent` = the agent's browser or a debugger holds that page).
fn choose(visual: &str, timeout_ms: u64, done: impl FnOnce(Choice) + 'static) {
    let Some((host, page)) = find_visual(visual) else {
        return done(Choice::None);
    };
    // C143: the agent's browser (or any debugger) on the page could click for the user.
    if held(&host, &page) {
        return done(Choice::Agent);
    }
    let id = next_id();
    let wc_id = page.borrow().wc_id;
    CHOICES.with(|c| {
        c.borrow_mut().insert(
            id,
            Waiting {
                visual: visual.to_owned(),
                wc_id,
                deadline: host::clock_ms() + timeout_ms as f64,
                round: 0,
                waiting_load: false,
                done: Some(Box::new(done)),
            },
        );
    });
    ask_page(id);
}

fn held(host: &HostRef, page: &PageRef) -> bool {
    let wc_id = page.borrow().wc_id;
    host.borrow()
        .agent
        .as_ref()
        .is_some_and(|a| a.page == wc_id)
        || cef_page::debugger_attached(wc_id)
}

fn finish_choice(id: u64, choice: Choice) {
    let Some(mut waiting) = CHOICES.with(|c| c.borrow_mut().remove(&id)) else {
        return;
    };
    if let Some(page) = host::page(waiting.wc_id) {
        page.borrow_mut().choosers.retain(|c| *c != id);
    }
    if let Some(done) = waiting.done.take() {
        done(choice);
    }
}

/// One round of the wait: the page's own `choose` runs in the isolated world until it answers or the time is up.
fn ask_page(id: u64) {
    let Some((wc_id, deadline)) =
        CHOICES.with(|c| c.borrow().get(&id).map(|w| (w.wc_id, w.deadline)))
    else {
        return;
    };
    let remaining = deadline - host::clock_ms();
    if remaining <= 0.0 {
        return finish_choice(id, Choice::Timeout);
    }
    let round = CHOICES.with(|c| {
        c.borrow_mut().get_mut(&id).map_or(0, |w| {
            w.round += 1;
            w.waiting_load = false;
            w.round
        })
    });
    crate::ui::post_delayed(remaining.ceil() as i64, move || expired(id, round));
    cef_page::run_in_world(
        wc_id,
        PAGE_WORLD,
        &page_tools::call("choose", &[]),
        move |picked| {
            chose(id, round, &picked);
        },
    );
}

fn expired(id: u64, round: u64) {
    let current = CHOICES.with(|c| c.borrow().get(&id).map(|w| (w.round, w.wc_id)));
    let Some((now, wc_id)) = current else { return };
    if now != round {
        return;
    }
    if cef_page::exists(wc_id) {
        cef_page::run_in_world(wc_id, PAGE_WORLD, &page_tools::call("cancel", &[]), |_| {});
    }
    finish_choice(id, Choice::Timeout);
}

fn chose(id: u64, round: u64, picked: &Value) {
    let current = CHOICES.with(|c| {
        c.borrow()
            .get(&id)
            .map(|w| (w.round, w.wc_id, w.visual.clone()))
    });
    let Some((now, wc_id, visual)) = current else {
        return;
    };
    if now != round {
        return;
    }
    let found = host::page(wc_id).and_then(|page| {
        let host = host::host_of(&page)?;
        let listed = host
            .borrow()
            .pages
            .iter()
            .any(|p| std::rc::Rc::ptr_eq(p, &page));
        let shows = page
            .borrow()
            .visual
            .as_ref()
            .is_some_and(|(shown, _)| *shown == visual);
        (listed && shows).then_some((host, page))
    });
    let Some((host, page)) = found else {
        return finish_choice(id, Choice::Closed);
    };
    if picked.is_null() {
        // A new version (or a reload) replaced the document: wait on the next one.
        if !crate::state::wc(wc_id).is_some_and(|e| e.borrow().state.loading) {
            return finish_choice(id, Choice::Closed);
        }
        CHOICES.with(|c| {
            if let Some(w) = c.borrow_mut().get_mut(&id) {
                w.waiting_load = true;
            }
        });
        page.borrow_mut().choosers.push(id);
        return;
    }
    if held(&host, &page) {
        return finish_choice(id, Choice::Agent);
    }
    // Only a click the user made counts: a script's click is not trusted (the page tools), and a trusted one needs a
    // real release on this page just now.
    if host::now_ms().saturating_sub(page.borrow().last_input) > GESTURE_WINDOW_MS {
        return ask_page(id);
    }
    finish_choice(
        id,
        Choice::Picked {
            value: text_of(picked, "value"),
            text: text_of(picked, "text"),
        },
    );
}

/// The page finished (or failed) loading, or went away: a `choose` waiting for its next document goes on.
pub(super) fn loaded(wc_id: u64) {
    let Some(page) = host::page(wc_id) else {
        return;
    };
    let waiting = std::mem::take(&mut page.borrow_mut().choosers);
    for id in waiting {
        ask_page(id);
    }
}

/// The page was closed: a `choose` on it is over.
pub(super) fn page_gone(wc_id: u64) {
    let ids: Vec<u64> = CHOICES.with(|c| {
        c.borrow()
            .iter()
            .filter(|(_, w)| w.wc_id == wc_id)
            .map(|(id, _)| *id)
            .collect()
    });
    for id in ids {
        finish_choice(id, Choice::Closed);
    }
}
