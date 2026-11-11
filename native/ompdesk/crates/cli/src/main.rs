//! `ompdesk`: drives a running OMPdesk from a terminal, a script or another agent CLI, the way OMPdesk's own agents
//! use the `ompdesk_*` host tools.

mod args;
mod conn;
mod endpoint;
mod json;
mod number;
mod protocol;
mod run;
mod sys;

use std::collections::HashMap;
use std::io::{self, Write};

fn main() {
    let mut argv: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    // `ompdesk -- sessions` ran `sessions` while Bun ran the CLI (it took the `--` for itself).
    if argv.first().is_some_and(|arg| arg == "--") {
        argv.remove(0);
    }
    let env: HashMap<String, String> = std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let cwd = std::env::current_dir()
        .map(|dir| dir.display().to_string())
        .unwrap_or_default();
    let (mut stdout, mut stderr, mut stdin) =
        (io::stdout().lock(), io::stderr(), io::stdin().lock());
    let home = sys::home(&env);
    let code = run::run(
        &argv,
        &mut run::Io {
            stdout: &mut stdout,
            stderr: &mut stderr,
            stdin: &mut stdin,
            env,
            platform,
            home,
            cwd,
            uid: sys::uid(),
            exit_on_interrupt: true,
        },
    );
    let _ = stdout.flush();
    std::process::exit(code);
}
