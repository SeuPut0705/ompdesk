//! The `ompdesk-core` binary: serves the core's methods over stdio until main closes its stdin, then exits 0. Only
//! frames go to stdout; diagnostics go to stderr as plain lines.

use std::process::ExitCode;

fn main() -> ExitCode {
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
