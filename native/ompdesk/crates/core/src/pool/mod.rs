//! The sidecar pool (was `src/main/sidecar-pool.ts`'s rules and state; units 9d and 9e): a hub instance of kind `pool`.
//!
//! The core is the one writer of what the pool knows: which tabs there are, what each window shows of them, who owns
//! which session file, which request came from which tab, each tab's run and its facts. Main's `SidecarPool` is the
//! client with the same public methods. What stays in main are the handles (the sidecars, the windows, the hosted views
//! of paired devices, the full-channel forwarders with their slimmers) and the collaborators, which the core asks.
//!
//! Protocol (`src/main/sidecar-pool.ts` is the other end):
//! - Calls: one method per public method of the pool, plus `feed`, which carries each sidecar event in the order the
//!   sidecar emitted it. Every call carries main's clock (`now`) and whether main's layout hook is installed (`wt`).
//! - Items the core pushes (their effects need nothing back): `send` (a window send, by `IPC_EVENTS` key), `wireFull`
//!   and `unwireFull`, `listenClosed`, `command` (a command to a sidecar whose answer nobody reads), `emitView`,
//!   `settleWatch`, `modelWaitForget`, `turnStop`, `reloadExtensions`, `immediate` and `stopTimer` (a tick and a timer
//!   run by main's clock), and `settle` (the end of a method that was `async`).
//! - Questions the core asks (the collaborator answers at once, `ask`): `blocked`, `spawn`, `wire`, `acquired`,
//!   `facts`, `window`, `start`, `restart`, `sleep`, `adoptCwd`, `sideChannel`, `endViews`, `dispose`, `disposeSidecars`,
//!   `announce`, `decide`, `mergePlans`, `deletedAdd`, `selfDevice`, `snowflake`, the hooks `onRunningChange`,
//!   `onSessionFilesChanged` and `onWindowTabsChanged`; and, for what main answers with a promise (`ask_later`):
//!   `rpc`, `sideChannelLater` and `exiting`.

mod api;
mod claims;
mod later;
pub mod layout;
mod listen;
mod omap;
mod persist;
mod routes;
mod run;
mod split;
mod state;
#[cfg(test)]
mod tests;
mod windows;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::value::RawValue;
use serde_json::{Value, json};

pub(crate) use crate::hub::spawn;
use crate::hub::{Kind, Out, Outcome};
use crate::server::Fault;
use state::{Ctx, LevelKey, P, Pool, R};

pub const KIND: Kind = Kind {
    name: "pool",
    open,
    call,
    close,
};

thread_local! {
    static POOLS: RefCell<HashMap<u64, Ctx>> = RefCell::default();
}

fn open(id: u64, opts: &RawValue, out: Out) -> Result<(), Fault> {
    let opts: Value = serde_json::from_str(opts.get()).unwrap_or(Value::Null);
    let pool = Pool {
        layout_version: opts["layoutVersion"].as_i64().unwrap_or(1),
        max_former_tab_ids: opts["maxFormerTabIds"]
            .as_u64()
            .and_then(|max| usize::try_from(max).ok())
            .unwrap_or(8),
        stop_wait_ms: opts["stopSessionWaitMs"].as_u64().unwrap_or(60_000),
        ..Pool::default()
    };
    let ctx = Ctx {
        out,
        pool: Rc::new(RefCell::new(pool)),
    };
    POOLS.with(|pools| pools.borrow_mut().insert(id, ctx));
    Ok(())
}

fn close(id: u64) {
    POOLS.with(|pools| pools.borrow_mut().remove(&id));
}

fn call(id: u64, method: &str, params: &RawValue) -> Outcome {
    let Some(ctx) = POOLS.with(|pools| pools.borrow().get(&id).cloned()) else {
        return Outcome::fault("no_instance", format!("No pool {id}"));
    };
    let params: Value = match serde_json::from_str(params.get()) {
        Ok(params) => params,
        Err(error) => return Outcome::fault("invalid_params", error.to_string()),
    };
    ctx.with(|pool| {
        if let Some(now) = params["now"].as_i64() {
            pool.now = now;
        }
        pool.window_tabs_hook = params["wt"].as_bool() == Some(true);
    });
    dispatch(ctx, method, P(params))
}

fn later<F>(work: F) -> Outcome
where
    F: Future<Output = R<Value>> + 'static,
{
    Outcome::Later(Box::pin(work))
}

fn now(value: Value) -> Outcome {
    Outcome::Now(Ok(value))
}

fn done(result: R<()>) -> R<Value> {
    result.map(|()| Value::Null)
}

fn dispatch(ctx: Ctx, method: &str, p: P) -> Outcome {
    match method {
        // ---- the tabs ----
        "acquire" => later(async move {
            let args = windows::Acquire {
                cwd: p.s("cwd")?,
                win: p.i("win")?,
                tab: p.s("tab")?,
                session_path: p.os("sessionPath"),
                kind: p.os("kind").unwrap_or_else(|| "agent".into()),
                worktree: p.has("worktree").then(|| p.v("worktree")),
                fresh: p.b("fresh"),
                placeholder: p.b("placeholder"),
                defer_start: p.b("deferStart"),
                title: p.os("title"),
                device: p.os("device"),
                task: p.os("task"),
                former_ids: p.has("formerIds").then(|| p.strings("formerIds")),
                owner_detached: p.b("ownerDetached"),
            };
            let (ok, added) = ctx.acquire(args).await?;
            Ok(json!({"ok": ok, "added": added}))
        }),
        "acquireHostedView" => later(async move {
            let ok = ctx
                .acquire_hosted_view(
                    p.i("win")?,
                    p.s("tab")?,
                    p.s("kind")?,
                    p.s("status")?,
                    p.has("reading").then(|| p.v("reading")),
                    p.s("sessionPath")?,
                )
                .await?;
            Ok(Value::from(ok))
        }),
        "feed" => later(async move {
            done(
                ctx.feed(
                    &p.s("tab")?,
                    &p.s("event")?,
                    &p.v("payload"),
                    p.b("fromLink"),
                )
                .await,
            )
        }),
        "windowClosed" => later(async move { done(ctx.window_closed(p.i("win")?).await) }),
        "immediate" => later(async move { done(ctx.immediate(&p.s("tab")?, &p.s("kind")?).await) }),
        "stopTimeout" => {
            ctx.stop_timeout(
                p.oi("token")
                    .and_then(|t| u64::try_from(t).ok())
                    .unwrap_or(0),
            );
            Outcome::done()
        }
        "size" => now(Value::from(ctx.with(|pool| pool.entries.len()))),
        "tabFacts" => now(ctx.tab_facts(&p.s("tab").unwrap_or_default())),
        "pendingPlan" => now(ctx.pending_plan(&p.s("tab").unwrap_or_default())),
        "isRequestOpen" => now(Value::from(ctx.is_request_open(
            &p.s("tab").unwrap_or_default(),
            &p.s("id").unwrap_or_default(),
        ))),
        "claimRequest" => now(ctx.claim_request(
            &p.s("tab").unwrap_or_default(),
            &p.s("id").unwrap_or_default(),
        )),
        "releaseRequest" => {
            ctx.release_request(
                &p.s("id").unwrap_or_default(),
                p.oi("claim")
                    .and_then(|c| u64::try_from(c).ok())
                    .unwrap_or(0),
            );
            Outcome::done()
        }
        "guardAsk" => Outcome::Now(
            ctx.guard_ask(
                &p.s("id").unwrap_or_default(),
                p.oi("claim").and_then(|c| u64::try_from(c).ok()),
            )
            .map(|()| Value::Null),
        ),
        "claimPlan" => now(ctx.claim_plan(
            &p.s("tab").unwrap_or_default(),
            &p.s("file").unwrap_or_default(),
            p.oi("generation")
                .and_then(|c| u64::try_from(c).ok())
                .unwrap_or(0),
        )),
        "planStillClaimed" => now(Value::from(
            ctx.plan_still_claimed(
                &p.s("tab").unwrap_or_default(),
                p.oi("claim")
                    .and_then(|c| u64::try_from(c).ok())
                    .unwrap_or(0),
            ),
        )),
        "releasePlan" => {
            ctx.release_plan(
                &p.s("tab").unwrap_or_default(),
                p.oi("claim")
                    .and_then(|c| u64::try_from(c).ok())
                    .unwrap_or(0),
            );
            Outcome::done()
        }
        "guardPlan" => Outcome::Now(
            ctx.guard_plan(&p.s("tab").unwrap_or_default(), p.b("own"))
                .map(|()| Value::Null),
        ),
        "restartHolds" => now(ctx.restart_holds()),
        "runningBridges" => later(async move { ctx.running_bridges().await }),
        "isHostedView" => now(Value::from(ctx.with(|pool| {
            pool.entry(&p.s("tab").unwrap_or_default())
                .is_some_and(|entry| entry.hosted_view)
        }))),
        // ---- paired devices' views ----
        "viewTarget" => Outcome::Now(ctx.view_target(&p.s("path").unwrap_or_default())),
        "deviceViewAdded" => {
            later(async move { done(ctx.device_view_added(&p.s("tab")?, view(&p)?).await) })
        }
        "deviceViewLeft" => {
            later(async move { done(ctx.device_view_left(&p.s("tab")?, view(&p)?).await) })
        }
        "deviceSnapshot" => now(ctx.device_snapshot(&p.s("tab").unwrap_or_default())),
        "deviceSubagentLevel" => now(Value::from(ctx.note_subagent_level(
            &p.s("tab").unwrap_or_default(),
            LevelKey::View(view(&p).unwrap_or(0)),
            &p.s("level").unwrap_or_default(),
        ))),
        "deviceAnswer" => later(async move {
            done(
                ctx.answer_from_device(&p.s("tab")?, &p.v("frame"), view(&p)?)
                    .await,
            )
        }),
        // ---- sessions ----
        "sessionRunning" => now(Value::from(
            ctx.session_running(&p.s("path").unwrap_or_default(), p.os("device").as_deref()),
        )),
        "stopSession" => later(async move {
            done(
                ctx.stop_session(token(&p)?, &p.s("path")?, p.os("device").as_deref())
                    .await,
            )
        }),
        "closeSessionTab" => later(async move {
            done(
                ctx.close_session_tab(token(&p)?, &p.s("path")?, p.os("device").as_deref())
                    .await,
            )
        }),
        "commandForSession" => later(async move {
            done(
                ctx.command_for_session(
                    token(&p)?,
                    &p.s("path")?,
                    &p.v("command"),
                    p.os("device").as_deref(),
                )
                .await,
            )
        }),
        "routeSideChannel" => later(async move {
            done(
                ctx.route_side_channel(
                    token(&p)?,
                    &p.s("id")?,
                    &p.v("frame"),
                    p.os("tab").as_deref(),
                    p.oi("responder"),
                    &p.os("choice").unwrap_or_default(),
                    p.oi("claim").and_then(|c| u64::try_from(c).ok()),
                )
                .await,
            )
        }),
        "releaseIdle" => {
            later(async move { done(ctx.release_idle(token(&p)?, &p.s("tab")?).await) })
        }
        "settleFacts" => {
            later(async move { done(ctx.settle_facts(token(&p)?, &p.s("tab")?).await) })
        }
        "sessionOwner" => {
            now(ctx.session_owner(&p.s("path").unwrap_or_default(), p.os("device").as_deref()))
        }
        "sessionOwnerIsLive" => later(async move {
            Ok(Value::from(
                ctx.session_owner_is_live(&p.s("path")?, p.os("device").as_deref())
                    .await?,
            ))
        }),
        "foreignSessionOwner" => {
            now(ctx.foreign_session_owner(p.os("tab").as_deref(), &p.s("path").unwrap_or_default()))
        }
        "noteSessionFile" => later(async move {
            done(
                ctx.note_session_file(&p.s("tab")?, p.os("file").as_deref())
                    .await,
            )
        }),
        "adoptSessionCwd" => later(async move {
            Ok(Value::from(
                ctx.adopt_session_cwd(&p.s("tab")?, &p.s("cwd")?).await?,
            ))
        }),
        "sessionFileOf" => now(ctx.session_file_of(&p.s("tab").unwrap_or_default())),
        "tabForSession" => now(ctx.with(|pool| {
            pool.session_owners
                .get(&p.s("path").unwrap_or_default())
                .map_or(Value::Null, |owner| Value::from(owner.tab_id.clone()))
        })),
        // ---- windows ----
        "viewIdentity" => now(ctx.with(|pool| {
            pool.entry(&p.s("tab").unwrap_or_default())
                .and_then(|entry| entry.view_identity(p.i("win").unwrap_or(0)))
                .map_or(Value::Null, Value::from)
        })),
        "leaveWindowView" => later(async move {
            done(
                ctx.leave_exact_window_view(
                    token(&p)?,
                    p.i("guard")?
                        .try_into()
                        .map_err(|_| Fault::new("bad_params", "Invalid view guard"))?,
                    p.i("win")?,
                    &p.s("tab")?,
                    &p.s("identity")?,
                    &p.s("sessionPath")?,
                )
                .await,
            )
        }),
        "continuationSettled" => later(async move {
            done(ctx.release_hidden_if_unused(&p.s("tab")?, true).await)
        }),
        "attachViewer" => later(async move {
            Ok(Value::from(
                ctx.attach_viewer(p.i("win")?, &p.s("tab")?).await?,
            ))
        }),
        "detachViewer" => later(async move {
            Ok(Value::from(
                ctx.detach_viewer(p.i("win")?, &p.s("tab")?).await?,
            ))
        }),
        "isShared" => now(Value::from(ctx.is_shared(&p.s("tab").unwrap_or_default()))),
        "setTabView" => later(async move {
            let visible = p.strings("visible");
            let remembered = p.has("remembered").then(|| p.v("remembered"));
            Ok(Value::from(
                ctx.set_tab_view(
                    p.i("win")?,
                    &p.s("focused")?,
                    &visible,
                    &p.v("split"),
                    remembered.as_ref(),
                )
                .await?,
            ))
        }),
        "releaseTab" => later(async move { Ok(Value::from(ctx.release_tab(&p.s("tab")?).await?)) }),
        "announceClosed" => later(async move {
            let closed = [p.s("tab")?];
            done(ctx.send_tab_list(p.i("win")?, Some(&closed), None).await)
        }),
        "bindWorktree" => later(async move {
            Ok(Value::from(
                ctx.bind_worktree(&p.s("tab")?, p.v("worktree")).await?,
            ))
        }),
        "activeTabForWindow" => now(ctx.active_tab_for_window(p.i("win").unwrap_or(0))),
        "tabsForWindow" => {
            later(async move { Ok(Value::Array(ctx.tabs_for_window(p.i("win")?).await?)) })
        }
        "reorderWindowTabs" => later(async move {
            Ok(Value::from(
                ctx.reorder_window_tabs(p.i("win")?, &p.strings("order"))
                    .await?,
            ))
        }),
        "tabForWindow" => now(ctx.tab_for_window(p.i("win").unwrap_or(0))),
        "tabForWindowTab" => {
            now(ctx.tab_for_window_tab(p.i("win").unwrap_or(0), &p.s("tab").unwrap_or_default()))
        }
        "tabTarget" => now(ctx.tab_target(p.i("win").unwrap_or(0), p.os("tab").as_deref())),
        "windowOfTab" => now(ctx.window_of_tab(&p.s("tab").unwrap_or_default())),
        "windowsShowingTab" => now(ctx.windows_showing_tab(&p.s("tab").unwrap_or_default())),
        "tabWindows" => now(ctx.tab_windows()),
        "extensionUiState" => now(ctx.extension_ui_state(p.i("win").unwrap_or(0))),
        "openRequests" => now(ctx.open_requests(p.i("win").unwrap_or(0))),
        "broadcastTargets" => now(ctx.broadcast_targets()),
        "tabIds" => now(ctx.tab_ids()),
        "modelWaitTogether" => {
            ctx.model_wait_together(&p.v("together"));
            Outcome::done()
        }
        // ---- notes from the windows and handlers ----
        "hasDraft" => now(Value::from(ctx.has_draft(&p.s("tab").unwrap_or_default()))),
        "noteDraft" => now(Value::from(ctx.note_draft(
            &p.s("tab").unwrap_or_default(),
            p.i("win").unwrap_or(0),
            &p.s("command").unwrap_or_default(),
            p.b("empty"),
        ))),
        "noteSubagentLevel" => now(Value::from(ctx.note_subagent_level(
            &p.s("tab").unwrap_or_default(),
            LevelKey::Window(p.i("win").unwrap_or(0)),
            &p.s("level").unwrap_or_default(),
        ))),
        "noteModeChanged" => {
            ctx.note_mode_changed(&p.s("tab").unwrap_or_default(), p.i("win").unwrap_or(0));
            Outcome::done()
        }
        "noteSessionName" => {
            later(async move { done(ctx.note_session_name(&p.s("tab")?, &p.s("title")?).await) })
        }
        "noteStopped" => later(async move { done(ctx.note_stopped(&p.s("tab")?).await) }),
        "noteUnstarted" => {
            later(async move { done(ctx.note_unstarted(&p.s("tab")?, p.b("unstarted")).await) })
        }
        "noteTouched" => later(async move { done(ctx.note_counter(&p.s("tab")?, true).await) }),
        "notePrompted" => later(async move { done(ctx.note_counter(&p.s("tab")?, false).await) }),
        "noteSignIn" => {
            let login = p.has("login").then(|| {
                let login = p.v("login");
                (
                    login["providerId"].as_str().unwrap_or("").to_string(),
                    login["error"].as_str().map(str::to_string),
                )
            });
            ctx.note_sign_in(&p.s("tab").unwrap_or_default(), p.b("active"), login);
            Outcome::done()
        }
        "signInActive" => now(Value::from(
            ctx.sign_in_active(&p.s("tab").unwrap_or_default()),
        )),
        "setAwaitingConnection" => later(async move {
            done(
                ctx.set_awaiting_connection(&p.s("tab")?, p.b("awaiting"))
                    .await,
            )
        }),
        "setResuming" => {
            later(async move { done(ctx.set_resuming(&p.s("tab")?, p.b("resuming")).await) })
        }
        "resumeRank" => now(Value::from(
            ctx.resume_rank(&p.s("tab").unwrap_or_default()),
        )),
        "setScheduledRetry" => later(async move {
            let retry = p.has("retry").then(|| p.v("retry"));
            done(ctx.set_scheduled_retry(&p.s("tab")?, retry).await)
        }),
        "startTab" => later(async move { Ok(Value::from(ctx.start_tab(&p.s("tab")?).await?)) }),
        "ensureStarted" => later(async move { done(ctx.ensure_started(&p.s("tab")?).await) }),
        "closeAsleepTabsIn" => later(async move {
            ctx.close_asleep_tabs_in(p.os("device").as_deref(), &p.strings("folders"))
                .await
        }),
        "deviceSessionFiles" => now(ctx.device_session_files(&p.s("device").unwrap_or_default())),
        "closeHostDeletedSessions" => later(async move {
            ctx.close_host_deleted_sessions(&p.s("device")?, &p.strings("paths"))
                .await
        }),
        "setTabTask" => {
            later(async move { done(ctx.set_tab_task(&p.s("tab")?, &p.s("task")?).await) })
        }
        "formerTabIds" => now(json!(ctx.former_tab_ids(&p.s("tab").unwrap_or_default()))),
        "setTabOpener" => {
            later(async move { done(ctx.set_tab_opener(&p.s("tab")?, &p.s("opener")?).await) })
        }
        // ---- what other parts of main read ----
        "resumeFacts" => later(async move { ctx.resume_facts().await }),
        "summarySources" => now(ctx.summary_sources()),
        "summaryFactsAll" => later(async move {
            let sources: Vec<(String, Option<String>)> =
                p.0.get("sources")
                    .and_then(Value::as_array)
                    .map(|sources| {
                        sources
                            .iter()
                            .map(|source| {
                                (
                                    source["tab"].as_str().unwrap_or("").to_string(),
                                    source["ask"].as_str().map(str::to_string),
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default();
            ctx.summary_facts_all(&sources).await
        }),
        "summaryFacts" => later(async move {
            ctx.summary_facts(&p.s("tab")?, p.os("ask").as_deref())
                .await
        }),
        "sessionOpeners" => now(ctx.session_openers()),
        "remoteOpenedTabs" => later(async move { ctx.remote_opened_tabs().await }),
        "windowSessionFiles" => now(ctx.window_session_files()),
        "worktreeBindings" => now(ctx.worktree_bindings()),
        "tabInventory" => now(ctx.tab_inventory()),
        "memoryTabs" => later(async move { ctx.memory_tabs().await }),
        "workspaceDirs" => later(async move { ctx.workspace_dirs().await }),
        "restartOnNewOmp" => later(async move { Ok(Value::from(ctx.restart_on_new_omp().await?)) }),
        "applyExtensionUpdate" => {
            later(async move { Ok(Value::from(ctx.apply_extension_update(&p.v("plan")).await?)) })
        }
        "tabLayoutForWindow" => later(async move { ctx.tab_layout_for_window(p.i("win")?).await }),
        "restoreLayout" => later(async move {
            Ok(Value::from(
                ctx.restore_layout(p.i("win")?, &p.v("layout")).await?,
            ))
        }),
        "seed" => {
            ctx.seed(p.v("tabs").as_array().map_or(&[][..], Vec::as_slice));
            Outcome::done()
        }
        "disposeAll" => later(async move { done(ctx.dispose_all().await) }),
        other => Outcome::fault("no_method", format!("The pool has no method {other}")),
    }
}

fn token(p: &P) -> R<u64> {
    p.oi("token")
        .and_then(|token| u64::try_from(token).ok())
        .ok_or_else(|| Fault::new("invalid_params", "`token` is not a number"))
}

fn view(p: &P) -> R<u64> {
    p.oi("view")
        .and_then(|view| u64::try_from(view).ok())
        .ok_or_else(|| Fault::new("invalid_params", "`view` is not a number"))
}
