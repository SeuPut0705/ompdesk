//! Reaching a host (was `dial`, `firstToConnect`, `probeHost` and `probeAny` in `src/main/remote/client.ts`): a TCP
//! connect with a timeout, the staggered race over a host's candidate ports, and the probe.

use std::time::Duration;

use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::{Instant, sleep_until};

use super::address;
use super::handshake::{self, Failure, Probe};
use super::link::Conn;
use crate::server::Scope;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// A dial to a port no answer has come from yet starts this long after the one before it (or as soon as that one fails).
pub const DIAL_STAGGER: Duration = Duration::from_millis(250);

/// A failed dial: `unreachable` with what failed, and whether the computer answered and nothing listened.
#[derive(Debug, Clone, PartialEq)]
pub struct DialFailure {
    pub failure: Failure,
    pub refused: bool,
}

impl DialFailure {
    fn unreachable(message: String, refused: bool) -> DialFailure {
        DialFailure {
            failure: Failure::unreachable(message),
            refused,
        }
    }
}

/// node's error code for a failed connect, as its message spells it (`connect ECONNREFUSED 1.2.3.4:5`).
fn node_code(error: &std::io::Error) -> Option<&'static str> {
    use std::io::ErrorKind::*;
    Some(match error.kind() {
        ConnectionRefused => "ECONNREFUSED",
        ConnectionReset => "ECONNRESET",
        TimedOut => "ETIMEDOUT",
        HostUnreachable => "EHOSTUNREACH",
        NetworkUnreachable => "ENETUNREACH",
        AddrNotAvailable => "EADDRNOTAVAIL",
        NetworkDown => "ENETDOWN",
        ConnectionAborted => "ECONNABORTED",
        _ => return None,
    })
}

/// A TCP connect as node's: to a loopback IP on Windows without the SYN retries after a refusal (`sys`).
async fn connect(target: &address::HostPort) -> std::io::Result<TcpStream> {
    let Ok(ip) = target
        .host
        .split('%')
        .next()
        .unwrap_or_default()
        .parse::<std::net::IpAddr>()
    else {
        return TcpStream::connect((target.host.as_str(), target.port)).await;
    };
    let socket = match ip {
        std::net::IpAddr::V4(_) => tokio::net::TcpSocket::new_v4()?,
        std::net::IpAddr::V6(_) => tokio::net::TcpSocket::new_v6()?,
    };
    #[cfg(windows)]
    if ip.is_loopback() {
        use std::os::windows::io::AsRawSocket;
        crate::sys::no_syn_retries(socket.as_raw_socket());
    }
    socket
        .connect(std::net::SocketAddr::new(ip, target.port))
        .await
}

/// One address, within `timeout`.
pub async fn dial(address: &str, timeout: Duration) -> Result<TcpStream, DialFailure> {
    let Some(target) = address::parse(address, address::DEFAULT_REMOTE_PORT) else {
        return Err(DialFailure::unreachable(
            format!("invalid address: {address}"),
            false,
        ));
    };
    let spelled = address::format(&target.host, u32::from(target.port));
    match tokio::time::timeout(timeout, connect(&target)).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => {
            let refused = matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset
            );
            let message = match node_code(&error) {
                Some(code) => format!("connect {code} {}:{}", target.host, target.port),
                None => error.to_string(),
            };
            Err(DialFailure::unreachable(
                format!("{spelled}: {message}"),
                refused,
            ))
        }
        Err(_) => Err(DialFailure::unreachable(
            format!("{spelled}: connect timed out"),
            false,
        )),
    }
}

/// The first of `addresses` (a host's candidate ports, best first) whose connect succeeds. Dials start
/// `DIAL_STAGGER` apart, the next at once when the latest fails, so a port that answers nothing costs a quarter
/// second, never its whole timeout, and an earlier port that answers in time still wins; the others are dropped.
/// Fails `unreachable` once every one failed, `refused` when every one was refused. `scope`: a cancel ends it.
pub async fn first_to_connect(
    addresses: &[String],
    timeout: Duration,
    scope: Option<&Scope>,
) -> Result<(String, TcpStream), DialFailure> {
    if addresses.is_empty() {
        return Err(DialFailure::unreachable("no address to dial".into(), false));
    }
    let mut dials = JoinSet::new();
    let mut next = 0;
    let mut all_refused = true;
    let mut stagger: Option<Instant> = None;
    let start = |dials: &mut JoinSet<_>, next: &mut usize, stagger: &mut Option<Instant>| {
        let address = addresses[*next].clone();
        *next += 1;
        dials.spawn(async move {
            let result = dial(&address, timeout).await;
            (address, result)
        });
        *stagger = (*next < addresses.len()).then(|| Instant::now() + DIAL_STAGGER);
    };
    start(&mut dials, &mut next, &mut stagger);
    let far = || Instant::now() + Duration::from_secs(86_400);
    loop {
        let cancelled = async {
            match scope {
                Some(scope) => scope.on_cancel().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            joined = dials.join_next() => {
                let Some(Ok((address, result))) = joined else {
                    continue;
                };
                match result {
                    Ok(stream) => return Ok((address, stream)),
                    Err(failure) => {
                        all_refused &= failure.refused;
                        let last = failure;
                        if next < addresses.len() {
                            start(&mut dials, &mut next, &mut stagger);
                        } else if dials.is_empty() {
                            let mut failure = last;
                            failure.refused = all_refused;
                            return Err(failure);
                        }
                    }
                }
            }
            () = sleep_until(stagger.unwrap_or_else(far)), if stagger.is_some() => {
                start(&mut dials, &mut next, &mut stagger);
            }
            () = cancelled => {
                let address = &addresses[next.saturating_sub(1)];
                return Err(DialFailure::unreachable(format!("{address}: dial cancelled"), false));
            }
        }
    }
}

/// `probeHost`: one address, no stagger.
pub async fn probe_host(address: &str) -> Result<Probe, Failure> {
    let stream = dial(address, PROBE_TIMEOUT)
        .await
        .map_err(|failure| failure.failure)?;
    handshake::probe(Conn::new(stream), address).await
}

/// `probeAny`: the first of `addresses` that connects and answers a probe `skip` does not set aside (this computer
/// itself). None: none did; the probe then holds the last refusal heard, else `unreachable`.
pub async fn probe_any(addresses: &[String], skip: Option<&str>) -> (Option<String>, Probe) {
    let mut probe = Probe::Refused("unreachable".into());
    let mut remaining = addresses.to_vec();
    while !remaining.is_empty() {
        let Ok((address, stream)) = first_to_connect(&remaining, PROBE_TIMEOUT, None).await else {
            break;
        };
        remaining.retain(|other| *other != address);
        let Ok(answer) = handshake::probe(Conn::new(stream), &address).await else {
            continue;
        };
        let skipped =
            matches!(&answer, Probe::Ok { device_id, .. } if Some(device_id.as_str()) == skip);
        probe = answer;
        if skipped {
            continue;
        }
        return (Some(address), probe);
    }
    (None, probe)
}
