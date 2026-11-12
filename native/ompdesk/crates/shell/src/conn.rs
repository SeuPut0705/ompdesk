//! The socket Node and a second launch speak to the shell on: a named pipe on Windows, a unix socket elsewhere
//! (macOS: `<userData>/shell.sock`). One type for both, so the host code is the same.

use std::io::{self, Read, Write};
#[cfg(unix)]
use std::path::Path;

/// A connected stream; `try_clone` gives the second handle one reader and one writer thread each need.
#[cfg(windows)]
pub type Conn = crate::sys::PipeConn;
#[cfg(unix)]
pub type Conn = std::os::unix::net::UnixStream;

pub struct Listener {
    #[cfg(windows)]
    inner: crate::sys::PipeListener,
    #[cfg(unix)]
    inner: std::os::unix::net::UnixListener,
}

impl Listener {
    /// Claims `name` (a pipe name on Windows, a socket path elsewhere). `Err(AddrInUse | PermissionDenied)` when
    /// another process owns it.
    #[cfg(windows)]
    pub fn bind(name: &str) -> io::Result<Self> {
        Ok(Self {
            inner: crate::sys::PipeListener::bind(name, true)?,
        })
    }

    #[cfg(unix)]
    pub fn bind(name: &str) -> io::Result<Self> {
        use std::os::unix::net::{UnixListener, UnixStream};
        let path = Path::new(name);
        match UnixListener::bind(path) {
            Ok(inner) => Ok(Self { inner }),
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                // A socket file whose owner is gone (a crash) refuses connections: take the name over.
                if UnixStream::connect(path).is_ok() {
                    return Err(error);
                }
                std::fs::remove_file(path)?;
                Ok(Self {
                    inner: UnixListener::bind(path)?,
                })
            }
            Err(error) => Err(error),
        }
    }

    pub fn accept(&mut self) -> io::Result<Conn> {
        #[cfg(windows)]
        return self.inner.accept();
        #[cfg(unix)]
        return self.inner.accept().map(|(stream, _)| stream);
    }
}

#[cfg(windows)]
pub fn connect(name: &str) -> io::Result<Conn> {
    crate::sys::pipe_connect(name)
}

#[cfg(unix)]
pub fn connect(name: &str) -> io::Result<Conn> {
    std::os::unix::net::UnixStream::connect(Path::new(name))
}

/// What a second launch sends the first: one line `{"argv": […], "cwd": "…"}`; the first answers `ok\n`.
pub fn hand_over(name: &str, argv: &[String], cwd: &str) -> io::Result<()> {
    let mut conn = connect(name)?;
    let line = serde_json::json!({ "argv": argv, "cwd": cwd }).to_string();
    conn.write_all(line.as_bytes())?;
    conn.write_all(b"\n")?;
    let mut answer = [0u8; 3];
    conn.read_exact(&mut answer)?;
    if &answer == b"ok\n" {
        Ok(())
    } else {
        Err(io::Error::other("the first instance did not acknowledge"))
    }
}

/// Reads the one line a second launch sent; answers `ok`.
pub fn take_hand_over(conn: &mut Conn) -> io::Result<(Vec<String>, String)> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while line.len() < 1 << 20 {
        if conn.read(&mut byte)? == 0 || byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    let value: serde_json::Value = serde_json::from_slice(&line).map_err(io::Error::other)?;
    let argv = value["argv"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let cwd = value["cwd"].as_str().unwrap_or("").to_string();
    conn.write_all(b"ok\n")?;
    Ok((argv, cwd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_launch_hands_its_argv_over_and_the_first_acknowledges() {
        #[cfg(windows)]
        let name = format!(
            "\\\\.\\pipe\\ompdesk-shell-handover-test-{}",
            std::process::id()
        );
        #[cfg(unix)]
        let name = std::env::temp_dir()
            .join(format!("shell-handover-{}.sock", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let mut listener = Listener::bind(&name).unwrap();
        assert!(Listener::bind(&name).is_err(), "a second owner is refused");
        let server = std::thread::spawn(move || {
            let mut conn = listener.accept().unwrap();
            take_hand_over(&mut conn).unwrap()
        });
        hand_over(
            &name,
            &["OMPDesk.exe".into(), "omp://open?x=1".into()],
            "C:\\work",
        )
        .unwrap();
        let (argv, cwd) = server.join().unwrap();
        assert_eq!(
            argv,
            vec!["OMPDesk.exe".to_string(), "omp://open?x=1".to_string()]
        );
        assert_eq!(cwd, "C:\\work");
        #[cfg(unix)]
        let _ = std::fs::remove_file(&name);
    }
}
