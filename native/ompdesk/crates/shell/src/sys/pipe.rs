//! Named pipes: the single-instance name and the host socket.
//!
//! Every handle is opened for overlapped I/O. A synchronous pipe handle serialises its operations in the kernel: a
//! `ReadFile` waiting for Node's next frame would block the writer thread's `WriteFile` on the same pipe (even through a
//! duplicated handle), and the two sides would wait for each other. With overlapped handles each operation waits on its
//! own event, so one thread reads while another writes.

use std::io::{self, Read, Write};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
    ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
};
use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

struct Handle(HANDLE);

// SAFETY: a pipe HANDLE is a kernel object reference usable from any thread; overlapped operations carry their own
// OVERLAPPED and event, so concurrent calls do not share state.
unsafe impl Send for Handle {}
// SAFETY: as above.
unsafe impl Sync for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle is open and owned by this value, closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// One end of a connected pipe. `try_clone` shares the handle, so a reader thread and a writer thread can each own one.
#[derive(Clone)]
pub struct PipeConn(Arc<Handle>);

impl PipeConn {
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(self.clone())
    }

    /// Runs one overlapped `ReadFile`/`WriteFile` and waits for it.
    fn transfer(&self, buffer: *mut u8, len: usize, write: bool) -> io::Result<usize> {
        let len = u32::try_from(len.min(1 << 20)).unwrap_or(1 << 20);
        // SAFETY: a manual-reset event for this one operation, closed below.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OVERLAPPED is plain data; all-zero plus the event is the documented initial state.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event;
        let handle = self.0.0;
        // SAFETY: `buffer` points at `len` bytes owned by the caller for the call; `overlapped` outlives the wait below.
        let started = unsafe {
            if write {
                WriteFile(handle, buffer, len, std::ptr::null_mut(), &mut overlapped)
            } else {
                ReadFile(handle, buffer, len, std::ptr::null_mut(), &mut overlapped)
            }
        };
        let mut transferred = 0u32;
        let result = if started != 0 {
            // SAFETY: the operation completed synchronously; the result is read without waiting.
            unsafe { GetOverlappedResult(handle, &overlapped, &mut transferred, 0) };
            Ok(transferred as usize)
        } else {
            // SAFETY: reads this thread's last error.
            let error = unsafe { GetLastError() };
            if error == ERROR_IO_PENDING {
                // SAFETY: waits for the pending operation on `overlapped`, which is alive.
                let ok = unsafe { GetOverlappedResult(handle, &overlapped, &mut transferred, 1) };
                if ok != 0 {
                    Ok(transferred as usize)
                } else {
                    Err(io::Error::last_os_error())
                }
            } else {
                Err(io::Error::from_raw_os_error(error as i32))
            }
        };
        // SAFETY: the event created above, closed once; nothing waits on it any more.
        unsafe { CloseHandle(event) };
        match result {
            Err(e)
                if !write
                    && matches!(e.raw_os_error(), Some(code) if matches!(code as u32, ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA)) =>
            {
                Ok(0)
            }
            other => other,
        }
    }
}

impl Read for PipeConn {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        match self.transfer(buf.as_mut_ptr(), buf.len(), false) {
            // The peer closed its end: the stream ends (ERROR_BROKEN_PIPE, ERROR_NO_DATA and ERROR_PIPE_NOT_CONNECTED).
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(0),
            other => other,
        }
    }
}

impl Write for PipeConn {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        // WriteFile only reads the buffer; the cast to *mut is the shared signature's.
        self.transfer(buf.as_ptr().cast_mut(), buf.len(), true)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn create_instance(name: &[u16], first: bool) -> io::Result<HANDLE> {
    let open_mode = PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    // SAFETY: `name` is NUL-terminated and outlives the call; a null security descriptor gives the pipe the creator's
    // default DACL (the same user, administrators and SYSTEM); the other arguments are plain numbers.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            std::ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(handle)
    }
}

/// The server end of a named pipe. One instance waits at all times, so the name stays owned and a second client
/// never finds it missing between two accepts.
pub struct PipeListener {
    name: Vec<u16>,
    waiting: Option<Handle>,
}

impl PipeListener {
    /// `exclusive`: fails (access denied) when another process already owns the name.
    pub fn bind(name: &str, exclusive: bool) -> io::Result<Self> {
        let name = wide(name);
        let waiting = Handle(create_instance(&name, exclusive)?);
        Ok(Self {
            name,
            waiting: Some(waiting),
        })
    }

    /// Blocks until a client connects; returns its end.
    pub fn accept(&mut self) -> io::Result<PipeConn> {
        let connected = self
            .waiting
            .take()
            .ok_or_else(|| io::Error::other("the listener has no instance"))?;
        let conn = PipeConn(Arc::new(connected));
        // SAFETY: a manual-reset event for the connect, closed below.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        // SAFETY: plain data, zero plus the event is the documented initial state.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event;
        let handle = conn.0.0;
        // SAFETY: an instance this listener owns; `overlapped` outlives the wait.
        let started = unsafe { ConnectNamedPipe(handle, &mut overlapped) };
        let outcome = if started != 0 {
            Ok(())
        } else {
            // SAFETY: reads this thread's last error.
            match unsafe { GetLastError() } {
                // A client that connected and already closed (ERROR_NO_DATA) still left its bytes to read.
                ERROR_PIPE_CONNECTED | ERROR_NO_DATA => Ok(()),
                ERROR_IO_PENDING => {
                    // SAFETY: waits for the pending connect on a live event.
                    unsafe { WaitForSingleObject(event, INFINITE) };
                    let mut n = 0u32;
                    // SAFETY: the connect finished; its result is read.
                    if unsafe { GetOverlappedResult(handle, &overlapped, &mut n, 0) } != 0 {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                }
                error => Err(io::Error::from_raw_os_error(error as i32)),
            }
        };
        // SAFETY: the event created above, closed once.
        unsafe { CloseHandle(event) };
        outcome?;
        self.waiting = Some(Handle(create_instance(&self.name, false)?));
        Ok(conn)
    }
}

/// Connects to a named pipe as a client.
pub fn pipe_connect(name: &str) -> io::Result<PipeConn> {
    let name = wide(name);
    // SAFETY: `name` is NUL-terminated; no security attributes, no template file.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(PipeConn(Arc::new(Handle(handle))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipe_is_exclusive_serves_several_clients_in_turn_and_carries_bytes_both_ways() {
        let name = format!("\\\\.\\pipe\\ompdesk-shell-test-{}", std::process::id());
        let mut listener = PipeListener::bind(&name, true).unwrap();
        assert!(
            PipeListener::bind(&name, true).is_err(),
            "a second owner of the name is refused"
        );
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let mut conn = listener.accept().unwrap();
                let mut buf = [0u8; 5];
                conn.read_exact(&mut buf).unwrap();
                conn.write_all(&buf.map(|b| b.to_ascii_uppercase()))
                    .unwrap();
            }
        });
        for word in [b"hello", b"world"] {
            let mut client = pipe_connect(&name).unwrap();
            client.write_all(word).unwrap();
            let mut answer = [0u8; 5];
            client.read_exact(&mut answer).unwrap();
            assert_eq!(&answer, &word.map(|b| b.to_ascii_uppercase()));
        }
        server.join().unwrap();
    }

    #[test]
    fn one_thread_reads_while_another_writes_on_the_same_pipe() {
        let name = format!(
            "\\\\.\\pipe\\ompdesk-shell-duplex-test-{}",
            std::process::id()
        );
        let mut listener = PipeListener::bind(&name, true).unwrap();
        let server = std::thread::spawn(move || {
            let conn = listener.accept().unwrap();
            let mut reader = conn.try_clone().unwrap();
            let mut writer = conn;
            // The reader blocks for the client's byte; the writer must still be able to send first.
            let reading = std::thread::spawn(move || {
                let mut one = [0u8; 1];
                reader.read_exact(&mut one).unwrap();
                one[0]
            });
            writer.write_all(b"first").unwrap();
            reading.join().unwrap()
        });
        let mut client = pipe_connect(&name).unwrap();
        let mut got = [0u8; 5];
        client.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"first");
        client.write_all(b"x").unwrap();
        assert_eq!(server.join().unwrap(), b'x');
    }

    #[test]
    fn a_closed_peer_reads_as_the_end_of_the_stream() {
        let name = format!("\\\\.\\pipe\\ompdesk-shell-eof-test-{}", std::process::id());
        let mut listener = PipeListener::bind(&name, true).unwrap();
        let server = std::thread::spawn(move || {
            let mut conn = listener.accept().unwrap();
            let mut rest = Vec::new();
            conn.read_to_end(&mut rest).unwrap();
            rest
        });
        let mut client = pipe_connect(&name).unwrap();
        client.write_all(b"bye").unwrap();
        drop(client);
        assert_eq!(server.join().unwrap(), b"bye");
    }
}
