//! The control socket's constants as the CLI needs them. Main's side is `src/shared/control-protocol.ts`;
//! `src/main/control-socket/cli.test.ts` runs this binary against main's server.

pub const CONTROL_PROTOCOL_VERSION: u32 = 1;
pub const CONTROL_SOCKET_ENV: &str = "OMPDESK_SOCKET";
pub const CONTROL_DIR_ENV: &str = "OMPDESK_CONTROL_DIR";
pub const CONTROL_OFF_ENV: &str = "OMPDESK_CONTROL_OFF";
pub const CONTROL_CALLER_ENV: &str = "OMPDESK_CALLER";
pub const ENDPOINT_FILE: &str = "endpoint.json";
pub const TOKEN_FILE: &str = "token";
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const WAIT_UNTIL: &[&str] = &["idle", "blocked", "done", "any"];

/// `CALLER_NAME`: `^[a-z0-9_-]{1,32}$`.
pub fn is_caller_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}
