use super::*;
use crate::worktree_lifecycle::RemovalGuard;

fn folders<H: Host>(app: &Application<H>) -> Result<Vec<Folder>, Fault> {
    let handles = app.handles();
    handles
        .iter()
        .filter_map(|(key, handle)| {
            if !matches!(key, super::super::HandleKey::Tab(_)) || handle.device.is_some() {
                return None;
            }
            Some(
                handle.sidecar.facts()["cwd"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        Fault::new("tab_state", "An open local tab has no working directory")
                    })
                    .and_then(|cwd| Folder::resolve_now(&cwd)),
            )
        })
        .collect()
}

impl<H: Host> Service<H> {
    /// Includes a synchronously created local source before Ctx's acquire continuation inserts its entry.
    pub fn worktree_folders(
        &self,
        owner: &Owner,
    ) -> EffectFuture<'static, Result<Vec<Folder>, Fault>> {
        let owner = owner.clone();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |_ctx| {
            Box::pin(async move { callers.admit_owner(&owner, || folders(&app)) })
        })
    }

    pub fn claim_worktree(
        &self,
        owner: &Owner,
        folder: Folder,
        claims: Arc<RemovalClaims>,
    ) -> EffectFuture<'static, Result<RemovalGuard, Fault>> {
        let owner = owner.clone();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        let canonical = Arc::clone(&self.removal_claims);
        self.execute_typed(move |_ctx| {
            Box::pin(async move {
                callers.admit_owner(&owner, || {
                    if !Arc::ptr_eq(&canonical, &claims) {
                        return Err(Fault::new(
                            "removal_claims",
                            "The worktree claim belongs to another application",
                        ));
                    }
                    let open = folders(&app)?;
                    claims.try_claim(folder, &open)
                })
            })
        })
    }
}
