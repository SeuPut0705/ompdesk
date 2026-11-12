//! What machine setup fetches from the network (was `src/main/setup/download.ts` and the lookups of
//! `src/main/setup/archives.ts`): a verified download to disk with byte progress (`download`) and the release
//! lookups for the archives setup installs itself (`archives`: Node.js, GitHub CLI, agent-desktop, Tailscale).
//! `net` holds what both read the network with. Main keeps how a failure is shown and when a download starts.
//!
//! Methods:
//! - `setup.download` `{id, url, sha256, file, accept?, mirror?}` answers `{}` once `file` holds bytes that match
//!   `sha256`; the failures are `download` and `checksum` (code), and `cancelled` when its `{cancel}` frame came.
//!   Progress is the event `setup.downloadProgress` `{id, received, total}` while it runs.
//! - `setup.resolveArchive` `{item, arch, mirror?, githubToken?}`, `setup.resolveAgentDesktop`
//!   `{platform, arch, …}` and `setup.resolveTailscale` `{platform, msiArch, …}` answer the release; a lookup that
//!   cannot say fails `setup_lookup` with a readable reason.
//! - `mirror` is a test's server on 127.0.0.1 standing in for every host (`net::routed`).

mod archives;
mod download;
mod net;
#[cfg(test)]
mod tests;

use serde::Deserialize;

use archives::{Platform, resolve_agent_desktop, resolve_archive, resolve_tailscale};
use net::Http;

use crate::server::{Call, Fault, Registry, Reply};

pub fn register(registry: &mut Registry) {
    registry.add("setup.download", |call| Box::pin(download::handle(call)));
    registry.add("setup.resolveArchive", |call| {
        Box::pin(async move { resolve_archive_method(call).await })
    });
    registry.add("setup.resolveAgentDesktop", |call| {
        Box::pin(async move { resolve_agent_desktop_method(call).await })
    });
    registry.add("setup.resolveTailscale", |call| {
        Box::pin(async move { resolve_tailscale_method(call).await })
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    mirror: Option<String>,
    github_token: Option<String>,
}

impl Source {
    fn pages(&self) -> Http<'_> {
        Http {
            mirror: self.mirror.as_deref(),
            token: self.github_token.as_deref(),
        }
    }
}

fn lookup_failed(message: String) -> Fault {
    Fault::new("setup_lookup", message)
}

#[derive(Deserialize)]
struct ArchiveParams {
    item: String,
    arch: String,
    #[serde(flatten)]
    source: Source,
}

async fn resolve_archive_method(call: Call) -> Result<Reply, Fault> {
    let params: ArchiveParams = call.params()?;
    if params.item != "gh" && params.item != "node" {
        return Err(Fault::new("invalid_params", "item is gh or node"));
    }
    let release = resolve_archive(&params.source.pages(), &params.item, &params.arch)
        .await
        .map_err(lookup_failed)?;
    Reply::json(&release)
}

#[derive(Deserialize)]
struct AgentDesktopParams {
    platform: Platform,
    arch: String,
    #[serde(flatten)]
    source: Source,
}

async fn resolve_agent_desktop_method(call: Call) -> Result<Reply, Fault> {
    let params: AgentDesktopParams = call.params()?;
    let release = resolve_agent_desktop(&params.source.pages(), params.platform, &params.arch)
        .await
        .map_err(lookup_failed)?;
    Reply::json(&release)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TailscaleParams {
    platform: Platform,
    msi_arch: Option<String>,
    #[serde(flatten)]
    source: Source,
}

async fn resolve_tailscale_method(call: Call) -> Result<Reply, Fault> {
    let params: TailscaleParams = call.params()?;
    let release = resolve_tailscale(
        &params.source.pages(),
        params.platform,
        params.msi_arch.as_deref(),
    )
    .await
    .map_err(lookup_failed)?;
    Reply::json(&release)
}
