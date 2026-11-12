//! The `ompdesk-core` binary: serves the core's methods over stdio until main closes its stdin, then exits 0. Only
//! frames go to stdout; diagnostics go to stderr as plain lines. The processes it starts end with it: on Windows through
//! the job object it joins first; on POSIX main kills its process group once it is gone. Run by ssh as its askpass
//! helper instead (`ssh/askpass.rs`), it asks the core that started that ssh and prints the answer.

use std::process::ExitCode;

fn main() -> ExitCode {
    // An ssh the core started runs this binary as its `SSH_ASKPASS` helper.
    if let Some(code) = ompdesk_core::ssh::askpass_helper() {
        return ExitCode::from(code);
    }
    #[cfg(windows)]
    if let Err(error) = ompdesk_core::end_children_with_this_process() {
        eprintln!("ompdesk-core: no job object, so a git it starts may outlive it: {error}");
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("ompdesk-core: cannot start its runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    let served = runtime.block_on(ompdesk_core::serve(
        tokio::io::stdin(),
        tokio::io::stdout(),
        ompdesk_core::registry(),
    ));
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ompdesk-core: {error}");
            ExitCode::FAILURE
        }
    }
}
