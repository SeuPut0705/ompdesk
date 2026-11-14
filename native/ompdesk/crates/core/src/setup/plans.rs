use base64::Engine as _;

use super::archives::{ArchiveRelease, TailscaleRelease};
use super::scripts;
use super::types::{
    InstallPlan, Item, Method, PlanContext, PlanDownload, Platform, Presence, SpawnSpec,
};

pub const OMP_PACKAGE: &str = "@oh-my-pi/pi-coding-agent";

pub fn join(platform: Platform, root: &str, parts: &[&str]) -> String {
    let sep = if platform == Platform::Win32 {
        '\\'
    } else {
        '/'
    };
    let mut result = root.trim_end_matches(['/', '\\']).to_owned();
    for part in parts {
        result.push(sep);
        result.push_str(part.trim_matches(['/', '\\']));
    }
    result
}

pub fn select_method(item: Item, presence: &Presence, ctx: &PlanContext) -> Option<Method> {
    if presence.present() || ctx.platform == Platform::Other {
        return None;
    }
    let mac = ctx.platform == Platform::Darwin;
    Some(match item {
        Item::Bun => {
            if matches!(presence, Presence::Outdated { .. }) && ctx.bun.is_some() {
                Method::BunUpgrade
            } else {
                Method::BunScript
            }
        }
        Item::Omp => {
            if matches!(presence, Presence::Outdated { .. }) && ctx.omp.is_some() {
                Method::OmpUpdate
            } else {
                Method::BunGlobal
            }
        }
        Item::Git => {
            if mac {
                Method::XcodeSelect
            } else {
                Method::PortableGit
            }
        }
        Item::Gh | Item::Node => {
            if mac {
                if ctx.brew.is_some() {
                    Method::Brew
                } else {
                    Method::Archive
                }
            } else if ctx.winget.is_some() {
                Method::Winget
            } else {
                return None;
            }
        }
        Item::AgentDesktop => {
            if matches!(ctx.arch.as_str(), "arm64" | "x64") {
                Method::AgentDesktopArchive
            } else {
                return None;
            }
        }
        Item::Tailscale => {
            if mac {
                Method::TailscaleZip
            } else if ctx.winget.is_some() {
                Method::Winget
            } else if msi_arch(&ctx.arch).is_some() {
                Method::TailscaleMsi
            } else {
                return None;
            }
        }
    })
}

pub fn msi_arch(arch: &str) -> Option<&'static str> {
    match arch {
        "x64" => Some("amd64"),
        "arm64" => Some("arm64"),
        "ia32" => Some("x86"),
        _ => None,
    }
}

pub fn command(file: &str, args: &[&str], platform: Platform) -> SpawnSpec {
    let extension = file.rsplit('.').next().unwrap_or_default();
    let shell = platform == Platform::Win32 && (extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat"));
    SpawnSpec {
        file: if shell {
            cmd_quote(file)
        } else {
            file.to_owned()
        },
        args: args
            .iter()
            .map(|arg| {
                if shell {
                    cmd_quote(arg)
                } else {
                    (*arg).to_owned()
                }
            })
            .collect(),
        shell,
        input_file: None,
        isolated: false,
    }
}

fn cmd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn powershell(ctx: &PlanContext, script: &str) -> SpawnSpec {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let file = join(
        Platform::Win32,
        &ctx.system_root,
        &["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    );
    let mut spec = command(
        &file,
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
        ],
        ctx.platform,
    );
    spec.args
        .push(base64::prelude::BASE64_STANDARD.encode(bytes));
    spec
}

fn winget_id(item: Item) -> Option<&'static str> {
    match item {
        Item::Git => Some("Git.Git"),
        Item::Gh => Some("GitHub.cli"),
        Item::Node => Some("OpenJS.NodeJS.LTS"),
        Item::Tailscale => Some("Tailscale.Tailscale"),
        Item::Bun | Item::Omp | Item::AgentDesktop => None,
    }
}

pub fn build_plan(
    item: Item,
    method: Method,
    ctx: &PlanContext,
    release: Option<&ArchiveRelease>,
    tailscale: Option<&TailscaleRelease>,
) -> Option<InstallPlan> {
    let win = ctx.platform == Platform::Win32;
    let path = |root: &str, parts: &[&str]| join(ctx.platform, root, parts);
    let mut plan = InstallPlan {
        item,
        method,
        spawn: command("", &[], ctx.platform),
        command: String::new(),
        location: String::new(),
        prompt: None,
        download: None,
    };
    match method {
        Method::BunScript => {
            plan.location.clone_from(&ctx.bun_install);
            if win {
                plan.command = scripts::bun(&ctx.bun_install);
                plan.spawn = powershell(ctx, &plan.command);
            } else {
                plan.command = "curl -fsSL https://bun.sh/install | bash".to_owned();
                plan.spawn = command(
                    "/bin/bash",
                    &[
                        "-c",
                        "set -o pipefail; curl -fsSL https://bun.sh/install | bash",
                    ],
                    ctx.platform,
                );
            }
        }
        Method::BunUpgrade => {
            let bun = ctx.bun.as_deref()?;
            plan.spawn = command(bun, &["upgrade"], ctx.platform);
            plan.command = format!("\"{bun}\" upgrade");
            plan.location = bun.to_owned();
        }
        Method::BunGlobal => {
            let bun = ctx.bun.as_deref()?;
            plan.spawn = command(bun, &["install", "-g", OMP_PACKAGE], ctx.platform);
            plan.command = format!("\"{bun}\" install -g {OMP_PACKAGE}");
            plan.location = path(
                &ctx.bun_install,
                &[
                    "install",
                    "global",
                    "node_modules",
                    "@oh-my-pi",
                    "pi-coding-agent",
                ],
            );
        }
        Method::OmpUpdate => {
            let omp = ctx.omp.as_deref()?;
            plan.spawn = command(omp, &["update"], ctx.platform);
            plan.command = format!("\"{omp}\" update");
            plan.location = omp.to_owned();
        }
        Method::PortableGit => {
            let (file, sha256) = if ctx.arch == "arm64" {
                (
                    "PortableGit-2.56.0.2-arm64.7z.exe",
                    "0f21e681bd33e006e0348dfa1a2be6769efd77e3bfdb247320314facde23a46c",
                )
            } else {
                (
                    "PortableGit-2.56.0.2-64-bit.7z.exe",
                    "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b",
                )
            };
            let download = PlanDownload {
                url: format!(
                    "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/{file}"
                ),
                sha256: sha256.to_owned(),
                file: path(&ctx.tools_dir, &[".downloads", file]),
            };
            plan.location = path(&ctx.tools_dir, &["git"]);
            plan.command = scripts::portable_git(&plan.location, &download);
            plan.spawn = powershell(ctx, &plan.command);
            plan.download = Some(download);
        }
        Method::XcodeSelect => {
            plan.spawn = command("/usr/bin/xcode-select", &["--install"], ctx.platform);
            plan.command = "xcode-select --install".to_owned();
            plan.location = "/Library/Developer/CommandLineTools".to_owned();
            plan.prompt = Some("dialog");
        }
        Method::Brew => {
            let brew = ctx.brew.as_deref()?;
            let formula = if item == Item::Gh { "gh" } else { "node" };
            plan.spawn = command(brew, &["install", formula], ctx.platform);
            plan.command = format!("\"{brew}\" install {formula}");
            plan.location = std::path::Path::new(brew)
                .parent()?
                .parent()?
                .to_string_lossy()
                .into_owned();
        }
        Method::Winget => {
            let winget = ctx.winget.as_deref()?;
            let mut args = vec!["install", "--id", winget_id(item)?, "-e"];
            if item == Item::Tailscale {
                args.extend([
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ]);
            } else {
                args.extend(["--accept-source-agreements", "--accept-package-agreements"]);
            }
            plan.command = format!("winget {}", args.join(" "));
            plan.spawn = command(winget, &args, ctx.platform);
            plan.location = match item {
                Item::Node => "C:\\Program Files\\nodejs",
                Item::Tailscale => "C:\\Program Files\\Tailscale",
                _ => "C:\\Program Files",
            }
            .to_owned();
            plan.prompt = Some("uac");
        }
        Method::Archive | Method::AgentDesktopArchive => {
            let release = release.filter(|release| release.item == item.name())?;
            if method == Method::Archive && item == Item::AgentDesktop {
                return None;
            }
            if method == Method::AgentDesktopArchive
                && (item != Item::AgentDesktop || ctx.platform == Platform::Other)
            {
                return None;
            }
            let download = PlanDownload {
                url: release.url.clone(),
                sha256: release.sha256.clone(),
                file: path(&ctx.tools_dir, &[".downloads", &release.file]),
            };
            plan.location = path(&ctx.tools_dir, &[item.name()]);
            plan.command = if method == Method::Archive {
                scripts::archive(release, &ctx.tools_dir, &plan.location, &download)
            } else if win {
                scripts::agent_desktop_windows(release, &plan.location, &download)
            } else {
                scripts::agent_desktop(
                    release,
                    &ctx.tools_dir,
                    &plan.location,
                    &path(&ctx.tools_dir, &[".agent-desktop."]),
                    &download,
                )
            };
            plan.spawn = if win {
                powershell(ctx, &plan.command)
            } else {
                command("/bin/bash", &["-c", &plan.command], ctx.platform)
            };
            plan.download = Some(download);
        }
        Method::TailscaleZip | Method::TailscaleMsi => {
            let release = tailscale?;
            if !release.file.ends_with(if method == Method::TailscaleZip {
                ".zip"
            } else {
                ".msi"
            }) {
                return None;
            }
            let download = PlanDownload {
                url: release.url.clone(),
                sha256: release.sha256.clone(),
                file: path(&ctx.tools_dir, &[".downloads", &release.file]),
            };
            if method == Method::TailscaleZip {
                plan.command = scripts::tailscale_zip(release, &download);
                plan.spawn = command("/bin/bash", &["-c", &plan.command], ctx.platform);
                plan.location = "/Applications/Tailscale.app".to_owned();
            } else {
                plan.command = scripts::tailscale_msi(&download);
                plan.spawn = powershell(ctx, &plan.command);
                plan.location = "C:\\Program Files\\Tailscale".to_owned();
                plan.prompt = Some("uac");
            }
            plan.download = Some(download);
        }
    }
    Some(plan)
}

pub fn manual_steps(item: Item, platform: Platform) -> (Vec<String>, String) {
    let win = platform == Platform::Win32;
    let (commands, url) = match item {
        Item::Bun | Item::Omp => (vec![], ""),
        Item::Git => (
            vec![
                if win {
                    "winget install --id Git.Git -e"
                } else {
                    "xcode-select --install"
                }
                .to_owned(),
            ],
            "https://git-scm.com/downloads",
        ),
        Item::Gh | Item::Node => (
            vec![if win {
                format!(
                    "winget install --id {} -e",
                    winget_id(item).unwrap_or_default()
                )
            } else {
                format!("brew install {}", item.name())
            }],
            if item == Item::Gh {
                "https://cli.github.com/"
            } else {
                "https://nodejs.org/en/download"
            },
        ),
        Item::AgentDesktop => (
            vec![],
            "https://github.com/vercel-labs/agent-desktop/releases",
        ),
        Item::Tailscale => (
            vec![
                if win {
                    "winget install --id Tailscale.Tailscale -e"
                } else {
                    "brew install --cask tailscale-app"
                }
                .to_owned(),
            ],
            "https://tailscale.com/download",
        ),
    };
    (commands, url.to_owned())
}
