//! Where main's worker connects to the hub: a Unix socket in a folder only this user may open (main makes the folder
//! 0700 and names the socket in it), or a Windows named pipe with an unguessable name that refuses remote clients and
//! must be its first instance. Main names both, and the token every connection proves, in the core's environment.

use super::serve_conn;

/// Listens where `OMPDESK_HUB` names, if it does: from the core's start, so main's first call finds it.
pub fn listen_from_env() {
    let (Ok(address), Ok(token)) = (
        std::env::var("OMPDESK_HUB"),
        std::env::var("OMPDESK_HUB_TOKEN"),
    ) else {
        return;
    };
    tokio::spawn(async move {
        if let Err(error) = accept(&address, token).await {
            eprintln!("ompdesk-core: the hub does not listen at {address}: {error}");
        }
    });
}

#[cfg(unix)]
async fn accept(address: &str, token: String) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(address);
    let listener = tokio::net::UnixListener::bind(address)?;
    std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?;
    loop {
        let (stream, _) = listener.accept().await?;
        let token = token.clone();
        tokio::spawn(async move {
            let (reader, writer) = stream.into_split();
            serve_conn(reader, writer, Some(token)).await;
        });
    }
}

#[cfg(windows)]
async fn accept(address: &str, token: String) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(address)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new()
            .reject_remote_clients(true)
            .create(address)?;
        let token = token.clone();
        tokio::spawn(async move {
            let (reader, writer) = tokio::io::split(connected);
            serve_conn(reader, writer, Some(token)).await;
        });
    }
}
