use std::sync::Arc;

use ompdesk_app_contract::Owner;

use super::{
    Application, EffectFuture, ExecutionCommand, Host, Selected, Service, Sidecar, execution_source,
};
use crate::remote::requests::RemoteRequests;
use crate::server::Fault;

struct Execution<S: Sidecar + ?Sized> {
    owner: Owner,
    tab: String,
    incarnation: u64,
    source: Arc<S>,
}

/// The original authenticated execution. A rejoin retains this handle; a command captures its run later.
/// No page or rtab parser can construct or deserialize it.
pub struct ExecutionTarget<S: Sidecar + ?Sized>(Arc<Execution<S>>);

impl<S: Sidecar + ?Sized> Clone for ExecutionTarget<S> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<S: Sidecar + ?Sized> ExecutionTarget<S> {
    pub fn owner(&self) -> &Owner {
        &self.0.owner
    }
    pub fn tab(&self) -> &str {
        &self.0.tab
    }
    pub fn incarnation(&self) -> u64 {
        self.0.incarnation
    }
    pub fn source(&self) -> &Arc<S> {
        &self.0.source
    }
}

fn selected<H: Host>(
    ctx: &crate::pool::state::Ctx,
    app: &Application<H>,
    target: &ExecutionTarget<H::Sidecar>,
) -> Result<Selected<H::Sidecar>, Fault> {
    let window = execution_source(ctx, app, &target.0.tab, &target.0.source, None)?;
    let (incarnation, device, session_file) = ctx.with(|pool| {
        let entry = pool
            .entry(&target.0.tab)
            .expect("checked entry remains in this hub step");
        (entry.seq, entry.device.clone(), entry.session_file.clone())
    });
    if incarnation != target.0.incarnation {
        return Err(Fault::new(
            "tab_stale",
            "The captured execution has changed",
        ));
    }
    let cwd = target.0.source.facts()["cwd"]
        .as_str()
        .ok_or_else(|| Fault::new("tab_state", "The execution has no working directory"))?
        .to_owned();
    Ok(Selected {
        tab: target.0.tab.clone(),
        cwd,
        device,
        window,
        session_file,
        generation: target.0.source.generation(),
        sidecar: Arc::clone(&target.0.source),
    })
}

impl<H: Host> Service<H> {
    pub fn release_peer_execution(
        &self,
        target: &ExecutionTarget<H::Sidecar>,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        self.release_execution_captured(
            Arc::clone(&self.callers),
            &target.0.owner,
            &target.0.tab,
            Arc::clone(&target.0.source),
            Some(target.0.incarnation),
        )
    }

    /// Internal cleanup capability. The original execution remains admitted after its presentation link closes.
    pub fn execution_selected(
        &self,
        target: &ExecutionTarget<H::Sidecar>,
    ) -> EffectFuture<'static, Result<Selected<H::Sidecar>, Fault>> {
        let target = target.clone();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers.admit_execution(&target.0.owner, &target.0.tab, None, || {
                    selected(&ctx, &app, &target)
                })
            })
        })
    }

    /// Called after the real pool acquire commits. This never creates an owner or re-resolves a retained target.
    pub fn peer_execution_target(
        &self,
        owner: &Owner,
        connection: &RemoteRequests,
        tab: &str,
    ) -> EffectFuture<'static, Result<ExecutionTarget<H::Sidecar>, Fault>> {
        let owner = owner.clone();
        let connection = connection.clone();
        let tab = tab.to_owned();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                let execution = callers.execution_owner(&tab)?;
                callers.admit_peer_execution(&owner, &connection, &execution, || {
                    let source = app.sidecar(&tab).ok_or_else(|| {
                        Fault::new("tab_stale", "The execution is no longer open")
                    })?;
                    execution_source(&ctx, &app, &tab, &source, None)?;
                    let incarnation =
                        ctx.with(|pool| pool.entry(&tab).expect("checked execution").seq);
                    Ok(ExecutionTarget(Arc::new(Execution {
                        owner: execution.clone(),
                        tab,
                        incarnation,
                        source,
                    })))
                })
            })
        })
    }

    /// Capture cwd/run in the same admitted hub step, before command-specific awaits.
    pub fn peer_execution_selected(
        &self,
        owner: &Owner,
        connection: &RemoteRequests,
        target: &ExecutionTarget<H::Sidecar>,
    ) -> EffectFuture<'static, Result<Selected<H::Sidecar>, Fault>> {
        let owner = owner.clone();
        let connection = connection.clone();
        let target = target.clone();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers.admit_peer_execution(&owner, &connection, &target.0.owner, || {
                    selected(&ctx, &app, &target)
                })
            })
        })
    }

    /// Internal typed stock/bridge effects only; tab.command still runs the actual local command dispatcher.
    pub fn peer_execution_command(
        &self,
        owner: &Owner,
        connection: &RemoteRequests,
        target: &ExecutionTarget<H::Sidecar>,
        command: ExecutionCommand,
    ) -> EffectFuture<'static, Result<serde_json::Value, Fault>> {
        let owner = owner.clone();
        let connection = connection.clone();
        let target = target.clone();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                let receipt =
                    callers.admit_peer_execution(&owner, &connection, &target.0.owner, || {
                        let captured = selected(&ctx, &app, &target)?;
                        Ok(match command {
                            ExecutionCommand::Stock(command) => captured
                                .sidecar
                                .stock_for_generation(captured.generation, command),
                            ExecutionCommand::Bridge {
                                method,
                                params,
                                timeout_ms,
                            } => captured.sidecar.bridge_for_generation(
                                captured.generation,
                                method,
                                params,
                                timeout_ms,
                            ),
                        })
                    })?;
                receipt.await
            })
        })
    }
}
