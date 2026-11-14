use super::*;
use crate::setup::git_aslr::{self, Action};

pub struct ToolRequest {
    pub tool: String,
    pub method: String,
    pub spawn: Option<SpawnSpec>,
    pub managed: Option<Item>,
    pub env: Environment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolOutcome {
    Succeeded,
    Failed { detail: Option<String> },
    Cancelled,
    Skipped,
}

struct Effect(Arc<Shared>);
impl Drop for Effect {
    fn drop(&mut self) {
        self.0.external_running.store(false, Ordering::Release);
    }
}

impl Data {
    pub(super) async fn latest_managed(&self, item: Item, scope: &Scope) -> Result<String, String> {
        if !matches!(item, Item::Gh | Item::Node | Item::AgentDesktop) {
            return Err("Not a managed archive item".to_owned());
        }
        self.resolve(item, scope)
            .await
            .map(|release| release.version)
    }

    pub(super) async fn latest_omp(&self, scope: &Scope) -> Result<String, String> {
        let omp = self
            .detection
            .as_ref()
            .and_then(|d| d.omp.as_ref())
            .filter(|_| {
                self.shared
                    .item(Item::Omp)
                    .presence
                    .as_ref()
                    .is_some_and(Presence::present)
            })
            .ok_or_else(|| "omp is not installed".to_owned())?;
        let mut env = tokio::select! { biased; () = scope.on_cancel() => return Err("cancelled".to_owned()), env = self.host.update_environment(omp) => env? };
        env.insert("NO_COLOR".to_owned(), "1".to_owned());
        env.insert("FORCE_COLOR".to_owned(), "0".to_owned());
        let spec = plans::command(omp, &["update", "--check"], self.config.platform);
        let text = Arc::new(Mutex::new(String::new()));
        let kept = text.clone();
        let check = Scope::detached();
        let work = self.runner.run(
            &spec,
            &env,
            &check,
            Arc::new(move |chunk| {
                let mut text = lock(&kept);
                text.push_str(chunk);
                trim_tail(&mut text, 1024 * 1024);
            }),
            None,
        );
        tokio::pin!(work);
        let outcome = tokio::select! { outcome = &mut work => outcome, () = scope.on_cancel() => { check.cancel(); work.await }, () = tokio::time::sleep(Duration::from_secs(60)) => { check.cancel(); work.await } };
        let text = lock(&text);
        if outcome == RunOutcome::Succeeded
            && let Some(version) = parse_update_check(&text)
        {
            return Ok(version);
        }
        Err(update_detail(&text)
            .unwrap_or_else(|| "omp update --check did not report a version".to_owned()))
    }

    pub(super) async fn tool_update(&mut self, request: ToolRequest, scope: &Scope) -> ToolOutcome {
        if self.shared.cancelled(scope) || self.config.platform == Platform::Other {
            return ToolOutcome::Skipped;
        }
        self.shared.external_running.store(true, Ordering::Release);
        let _effect = Effect(self.shared.clone());
        let mut download = None;
        let spec = if let Some(installer) = &self.config.test_installer {
            download.clone_from(&self.config.test_download);
            plans::command(
                &installer.to_string_lossy(),
                &[&format!("cli-{}", request.tool), &request.method, "update"],
                self.config.platform,
            )
        } else if let Some(spec) = request.spawn {
            spec
        } else if let Some(item) = request
            .managed
            .filter(|id| matches!(id, Item::Gh | Item::Node | Item::AgentDesktop))
        {
            if self.detection.is_none()
                && let Err(detail) = self.detect(scope).await
            {
                return ToolOutcome::Failed {
                    detail: Some(detail),
                };
            }
            let release = match self.resolve(item, scope).await {
                Ok(release) => release,
                Err(detail) => {
                    return if scope.cancelled() {
                        ToolOutcome::Cancelled
                    } else {
                        ToolOutcome::Failed {
                            detail: Some(detail),
                        }
                    };
                }
            };
            let Some(ctx) = self.context() else {
                return ToolOutcome::Failed {
                    detail: Some("Machine detection is missing".to_owned()),
                };
            };
            let method = if item == Item::AgentDesktop {
                Method::AgentDesktopArchive
            } else {
                Method::Archive
            };
            let Some(plan) = plans::build_plan(item, method, &ctx, Some(&release), None) else {
                return ToolOutcome::Failed {
                    detail: Some(format!("no {} plan for {}", method.name(), item.name())),
                };
            };
            download = plan.download;
            plan.spawn
        } else {
            return ToolOutcome::Skipped;
        };
        let outcome = self
            .tool_execute(&spec, download.as_ref(), request.env, scope)
            .await;
        if let Some(download) = download {
            let _ = std::fs::remove_file(download.file);
        }
        outcome
    }

    async fn tool_execute(
        &self,
        spec: &SpawnSpec,
        download: Option<&PlanDownload>,
        overrides: Environment,
        scope: &Scope,
    ) -> ToolOutcome {
        if let Some(download) = download
            && let Err(fault) =
                download::fetch(download, self.config.mirror.clone(), scope, &|_, _| {}).await
        {
            return if scope.cancelled() {
                ToolOutcome::Cancelled
            } else {
                ToolOutcome::Failed {
                    detail: Some(fault.message),
                }
            };
        }
        let mut env = match self.environment(scope).await {
            Ok(env) => env,
            Err(failure) => {
                return if scope.cancelled() {
                    ToolOutcome::Cancelled
                } else {
                    ToolOutcome::Failed {
                        detail: failure.detail,
                    }
                };
            }
        };
        env.extend(overrides);
        let text = Arc::new(Mutex::new(String::new()));
        let kept = text.clone();
        let outcome = self
            .runner
            .run(
                spec,
                &env,
                scope,
                Arc::new(move |chunk| {
                    let mut text = lock(&kept);
                    text.push_str(chunk);
                    trim_tail(&mut text, OUTPUT_TAIL);
                }),
                None,
            )
            .await;
        match outcome {
            RunOutcome::Succeeded => ToolOutcome::Succeeded,
            RunOutcome::Cancelled => ToolOutcome::Cancelled,
            RunOutcome::Failed {
                exit_code, detail, ..
            } => {
                let detail = update_detail(&lock(&text)).or(detail);
                let parts: Vec<_> = exit_code
                    .map(|code| format!("exit {code}"))
                    .into_iter()
                    .chain(detail)
                    .collect();
                ToolOutcome::Failed {
                    detail: (!parts.is_empty()).then(|| parts.join(" — ")),
                }
            }
        }
    }

    pub(super) async fn git_aslr(
        &mut self,
        action: Action,
        scope: &Scope,
    ) -> Result<usize, String> {
        let root = match self.shared.item(Item::Git).presence {
            Some(Presence::Present {
                path: Some(root), ..
            }) if self.config.platform == Platform::Win32 => root,
            _ => return Err("Git for Windows was not found".to_owned()),
        };
        let dir = self
            .config
            .state_path
            .parent()
            .ok_or_else(|| "Setup state has no folder".to_owned())?;
        let record_file = dir.join("git-aslr.json");
        let input = dir.join("git-aslr-in.json");
        let output = dir.join("git-aslr-out.json");
        let recorded = git_aslr::Record::read(&record_file);
        let env = tokio::select! { biased; () = scope.on_cancel() => return Err("cancelled".to_owned()), env = self.host.environment() => env? };
        if matches!(action, Action::Undo) {
            let images = recorded.images(&root);
            if images.is_empty() {
                return Err(
                    "No record of what Fix changed, so there is nothing to undo exactly".to_owned(),
                );
            }
            if images
                .iter()
                .any(|image| !git_aslr::own_image(&root, &image.path))
            {
                return Err(
                    "The Git ASLR record names an image outside this Git's usr folder".to_owned(),
                );
            }
            crate::disk::tree::write_atomic_if(
                &input,
                git_aslr::undo_input(images).as_bytes(),
                Some(0o600),
                0o700,
                &|| true,
            )
            .map_err(|fault| fault.message)?;
        }
        let _ = std::fs::remove_file(&output);
        if self.shared.cancelled(scope) {
            let _ = std::fs::remove_file(&input);
            return Err("cancelled".to_owned());
        }
        let spec = self.config.test_installer.as_ref().map_or_else(
            || git_aslr::spawn(&self.config.system_root, &root, action, &input, &output),
            |installer| {
                plans::command(
                    &installer.to_string_lossy(),
                    &[
                        "git",
                        if matches!(action, Action::Fix) {
                            "aslr-fix"
                        } else {
                            "aslr-undo"
                        },
                        &input.to_string_lossy(),
                        &output.to_string_lossy(),
                    ],
                    self.config.platform,
                )
            },
        );
        self.shared.external_running.store(true, Ordering::Release);
        let _effect = Effect(self.shared.clone());
        let text = Arc::new(Mutex::new(String::new()));
        let kept = text.clone();
        let outcome = self
            .runner
            .run(
                &spec,
                &env,
                scope,
                Arc::new(move |chunk| {
                    let mut text = lock(&kept);
                    text.push_str(chunk);
                    trim_tail(&mut text, OUTPUT_TAIL);
                }),
                None,
            )
            .await;
        let written = std::fs::read_to_string(&output).unwrap_or_default();
        let _ = std::fs::remove_file(output);
        let _ = std::fs::remove_file(input);
        let mut record = git_aslr::Record::read(&record_file);
        let changed: Vec<String> = match action {
            Action::Fix => {
                let changed = git_aslr::parse_fix(&written);
                if changed
                    .iter()
                    .any(|image| !git_aslr::own_image(&root, &image.path))
                {
                    return Err(
                        "The Git ASLR result names an image outside this Git's usr folder"
                            .to_owned(),
                    );
                }
                let paths = changed.iter().map(|image| image.path.clone()).collect();
                record.fixed(&root, changed);
                paths
            }
            Action::Undo => {
                let restored = git_aslr::parse_undo(&written);
                record.restored(&root, &restored);
                restored
            }
        };
        let count = changed.len();
        record.save(&record_file)?;
        self.host.git_aslr_log(git_aslr::Log {
            root: root.clone(),
            action,
            outcome: outcome.clone(),
            images: changed,
            output: update_detail(&lock(&text)),
        });
        if !scope.cancelled() {
            self.detect(scope).await?;
        }
        match outcome {
            RunOutcome::Succeeded => Ok(count),
            RunOutcome::Cancelled => Err("cancelled".to_owned()),
            RunOutcome::Failed { detail, .. } => {
                Err(update_detail(&lock(&text)).or(detail).unwrap_or_default())
            }
        }
    }
}

pub fn parse_update_check(text: &str) -> Option<String> {
    fn version(text: &str, label: &str) -> Option<String> {
        let rest = text.split_once(label)?.1.trim_start();
        let token = rest.split_whitespace().next()?;
        let mut digits = token.bytes().peekable();
        for index in 0..3 {
            let mut count = 0;
            while digits.peek().is_some_and(u8::is_ascii_digit) {
                digits.next();
                count += 1;
            }
            if count == 0 || (index < 2 && digits.next() != Some(b'.')) {
                return None;
            }
        }
        Some(token.to_owned())
    }
    let current = version(text, "Current version:")?;
    version(text, "New version available:")
        .or_else(|| text.contains("Already up to date").then_some(current))
}
