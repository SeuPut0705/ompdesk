//! Failures as node reported them: callers and the people they show them to read node's text
//! (`ENOENT: no such file or directory, stat '/x'`), and the app codes come from node's error codes.

use std::io;

use crate::server::Fault;

/// A failed file system call: node's error code (`ENOENT`) and node's message.
#[derive(Debug)]
pub struct NodeError {
    pub code: &'static str,
    pub message: String,
}

/// Which app code an error maps to, per caller (each TypeScript function mapped its own).
#[derive(Clone, Copy)]
pub enum Codes {
    /// None: the fault is `io`.
    None,
    /// `ENOENT` is `file_not_found`.
    Missing,
    /// `fsErrorCode`: `ENOENT` is `file_not_found`, `EEXIST` and `ENOTEMPTY` are `exists`.
    Fs,
}

/// A fault's code for an error that carries no app code.
pub const IO: &str = "io";

impl NodeError {
    /// `<CODE>: <description>, <syscall>` with ` '<path>'` when the call had one.
    pub fn new(error: &io::Error, syscall: &str, path: Option<&str>) -> NodeError {
        NodeError::with_dest(error, syscall, path, None)
    }

    /// A two-path call (`rename '<from>' -> '<to>'`).
    pub fn with_dest(
        error: &io::Error,
        syscall: &str,
        path: Option<&str>,
        dest: Option<&str>,
    ) -> NodeError {
        let (code, description) = uv_error(error);
        let mut message = format!("{code}: {description}, {syscall}");
        if let Some(path) = path {
            message.push_str(&format!(" '{path}'"));
        }
        if let Some(dest) = dest {
            message.push_str(&format!(" -> '{dest}'"));
        }
        NodeError { code, message }
    }

    /// Node refuses a path with a NUL before any system call (`ERR_INVALID_ARG_VALUE`).
    pub fn nul_in_path(name: &str, path: &str) -> NodeError {
        let mut inspected = inspect_string(path);
        if inspected.encode_utf16().count() > 128 {
            let units: Vec<u16> = inspected.encode_utf16().take(128).collect();
            inspected = format!("{}...", String::from_utf16_lossy(&units));
        }
        NodeError {
            code: "ERR_INVALID_ARG_VALUE",
            message: format!(
                "The argument '{name}' must be a string, Uint8Array, or URL without null bytes. Received {inspected}"
            ),
        }
    }

    pub fn fault(self, codes: Codes) -> Fault {
        let code = match (codes, self.code) {
            (Codes::Missing | Codes::Fs, "ENOENT") => "file_not_found",
            (Codes::Fs, "EEXIST" | "ENOTEMPTY") => "exists",
            _ => IO,
        };
        Fault::new(code, self.message)
    }
}

/// `util.inspect` of a string: single quotes unless the text holds one, control characters escaped.
fn inspect_string(text: &str) -> String {
    let quote = if !text.contains('\'') {
        '\''
    } else if !text.contains('"') {
        '"'
    } else if !text.contains('`') && !text.contains("${") {
        '`'
    } else {
        '\''
    };
    let mut out = String::with_capacity(text.len() + 2);
    out.push(quote);
    for c in text.chars() {
        match c {
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '\\' => out.push_str("\\\\"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) => {
                out.push_str(&format!("\\x{:02X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// libuv's name for an OS error (`ENOENT`), as node puts it in a message such as `spawn /usr/bin/git ENOENT`.
pub fn uv_code(error: &io::Error) -> &'static str {
    uv_error(error).0
}

/// libuv's name and description for an OS error, as node's `getSystemErrorMap()` lists them; an error libuv does
/// not map is node's `UNKNOWN: unknown error`.
fn uv_error(error: &io::Error) -> (&'static str, &'static str) {
    let name = error.raw_os_error().and_then(uv_name).unwrap_or("UNKNOWN");
    (name, describe(name))
}

#[cfg(unix)]
fn uv_name(errno: i32) -> Option<&'static str> {
    let table: &[(i32, &str)] = &[
        (libc::E2BIG, "E2BIG"),
        (libc::EACCES, "EACCES"),
        (libc::EAGAIN, "EAGAIN"),
        (libc::EBADF, "EBADF"),
        (libc::EBUSY, "EBUSY"),
        (libc::ECANCELED, "ECANCELED"),
        (libc::EEXIST, "EEXIST"),
        (libc::EFAULT, "EFAULT"),
        (libc::EFBIG, "EFBIG"),
        (libc::EINTR, "EINTR"),
        (libc::EINVAL, "EINVAL"),
        (libc::EIO, "EIO"),
        (libc::EISDIR, "EISDIR"),
        (libc::ELOOP, "ELOOP"),
        (libc::EMFILE, "EMFILE"),
        (libc::EMLINK, "EMLINK"),
        (libc::ENAMETOOLONG, "ENAMETOOLONG"),
        (libc::ENFILE, "ENFILE"),
        (libc::ENODEV, "ENODEV"),
        (libc::ENOENT, "ENOENT"),
        (libc::ENOMEM, "ENOMEM"),
        (libc::ENOSPC, "ENOSPC"),
        (libc::ENOSYS, "ENOSYS"),
        (libc::ENOTDIR, "ENOTDIR"),
        (libc::ENOTEMPTY, "ENOTEMPTY"),
        (libc::ENOTSUP, "ENOTSUP"),
        (libc::ENXIO, "ENXIO"),
        (libc::EOVERFLOW, "EOVERFLOW"),
        (libc::EPERM, "EPERM"),
        (libc::EPIPE, "EPIPE"),
        (libc::ERANGE, "ERANGE"),
        (libc::EROFS, "EROFS"),
        (libc::ESPIPE, "ESPIPE"),
        (libc::ESRCH, "ESRCH"),
        (libc::ETIMEDOUT, "ETIMEDOUT"),
        (libc::ETXTBSY, "ETXTBSY"),
        (libc::EXDEV, "EXDEV"),
        (libc::EILSEQ, "EILSEQ"),
        (libc::ENODATA, "ENODATA"),
        (libc::ENOTTY, "ENOTTY"),
        (libc::ENOEXEC, "ENOEXEC"),
        #[cfg(target_os = "macos")]
        (libc::EFTYPE, "EFTYPE"),
    ];
    table
        .iter()
        .find(|(code, _)| *code == errno)
        .map(|(_, name)| *name)
}

/// libuv's `uv_translate_sys_error` for the Win32 errors a file call returns.
#[cfg(windows)]
fn uv_name(code: i32) -> Option<&'static str> {
    Some(match code {
        1 => "EISDIR",                                               // ERROR_INVALID_FUNCTION
        2 | 3 | 15 | 123 | 126 | 161 | 203 | 267 | 4392 => "ENOENT", // not found, bad name, ERROR_DIRECTORY
        4 => "EMFILE",                                               // ERROR_TOO_MANY_OPEN_FILES
        5 | 1314 => "EPERM", // ERROR_ACCESS_DENIED, ERROR_PRIVILEGE_NOT_HELD
        6 => "EBADF",        // ERROR_INVALID_HANDLE
        8 | 14 => "ENOMEM",  // ERROR_NOT_ENOUGH_MEMORY, ERROR_OUTOFMEMORY
        17 => "EXDEV",       // ERROR_NOT_SAME_DEVICE
        19 => "EROFS",       // ERROR_WRITE_PROTECT
        32 | 33 | 231 => "EBUSY", // sharing and lock violations, ERROR_PIPE_BUSY
        38 | 109 => "EOF",   // ERROR_HANDLE_EOF, ERROR_BROKEN_PIPE
        50 => "ENOTSUP",     // ERROR_NOT_SUPPORTED
        80 | 183 => "EEXIST", // ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS
        87 | 122 | 1464 => "EINVAL", // bad parameter, buffer, symlink not supported
        112 => "ENOSPC",     // ERROR_DISK_FULL
        121 => "ETIMEDOUT",  // ERROR_SEM_TIMEOUT
        145 => "ENOTEMPTY",  // ERROR_DIR_NOT_EMPTY
        206 => "ENAMETOOLONG", // ERROR_FILENAME_EXCED_RANGE
        208 => "E2BIG",      // ERROR_META_EXPANSION_TOO_LONG
        740 | 998 | 1920 => "EACCES", // elevation required, no access, can't access file
        1113 => "ECHARSET",  // ERROR_NO_UNICODE_TRANSLATION
        1921 => "ELOOP",     // ERROR_CANT_RESOLVE_FILENAME
        _ => return None,
    })
}

fn describe(name: &str) -> &'static str {
    match name {
        "E2BIG" => "argument list too long",
        "EACCES" => "permission denied",
        "EAGAIN" => "resource temporarily unavailable",
        "EBADF" => "bad file descriptor",
        "EBUSY" => "resource busy or locked",
        "ECANCELED" => "operation canceled",
        "ECHARSET" => "invalid Unicode character",
        "EEXIST" => "file already exists",
        "EFAULT" => "bad address in system call argument",
        "EFBIG" => "file too large",
        "EFTYPE" => "inappropriate file type or format",
        "EILSEQ" => "illegal byte sequence",
        "EINTR" => "interrupted system call",
        "EINVAL" => "invalid argument",
        "EIO" => "i/o error",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        "EMFILE" => "too many open files",
        "EMLINK" => "too many links",
        "ENAMETOOLONG" => "name too long",
        "ENFILE" => "file table overflow",
        "ENODATA" => "no data available",
        "ENODEV" => "no such device",
        "ENOENT" => "no such file or directory",
        "ENOEXEC" => "exec format error",
        "ENOMEM" => "not enough memory",
        "ENOSPC" => "no space left on device",
        "ENOSYS" => "function not implemented",
        "ENOTDIR" => "not a directory",
        "ENOTEMPTY" => "directory not empty",
        "ENOTSUP" => "operation not supported on socket",
        "ENOTTY" => "inappropriate ioctl for device",
        "ENXIO" => "no such device or address",
        "EOF" => "end of file",
        "EOVERFLOW" => "value too large for defined data type",
        "EPERM" => "operation not permitted",
        "EPIPE" => "broken pipe",
        "ERANGE" => "result too large",
        "EROFS" => "read-only file system",
        "ESPIPE" => "invalid seek",
        "ESRCH" => "no such process",
        "ETIMEDOUT" => "connection timed out",
        "ETXTBSY" => "text file is busy",
        "EXDEV" => "cross-device link not permitted",
        _ => "unknown error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn writes_node_messages() {
        let missing = io::Error::from_raw_os_error(libc::ENOENT);
        assert_eq!(
            NodeError::new(&missing, "stat", Some("/x/y")).message,
            "ENOENT: no such file or directory, stat '/x/y'"
        );
        let exists = io::Error::from_raw_os_error(libc::EEXIST);
        let error = NodeError::with_dest(&exists, "rename", Some("/a"), Some("/b"));
        assert_eq!(
            error.message,
            "EEXIST: file already exists, rename '/a' -> '/b'"
        );
        assert_eq!(error.fault(Codes::Fs).code, "exists");
        let read = NodeError::new(&io::Error::from_raw_os_error(libc::EISDIR), "read", None);
        assert_eq!(
            read.message,
            "EISDIR: illegal operation on a directory, read"
        );
        assert_eq!(
            NodeError::new(
                &io::Error::from_raw_os_error(libc::ENOENT),
                "stat",
                Some("/x")
            )
            .fault(Codes::None)
            .code,
            IO
        );
        let unmapped = io::Error::from_raw_os_error(libc::EDQUOT);
        assert_eq!(
            NodeError::new(&unmapped, "open", Some("/q")).message,
            "UNKNOWN: unknown error, open '/q'"
        );
    }

    #[test]
    fn refuses_a_nul_as_node_words_it() {
        assert_eq!(
            NodeError::nul_in_path("path", "/w/a\0b").message,
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '/w/a\\x00b'"
        );
        assert_eq!(
            NodeError::nul_in_path("path", "it's\0").message,
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received \"it's\\x00\""
        );
        assert_eq!(
            NodeError::nul_in_path("path", "a\"b'c\0").message,
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received `a\"b'c\\x00`"
        );
        assert_eq!(
            NodeError::nul_in_path("path", "\t\u{7f}\u{85}é😀\0\\").message,
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '\\t\\x7F\\x85é😀\\x00\\\\'"
        );
        let long = format!("{}\0", "x".repeat(200));
        assert_eq!(
            NodeError::nul_in_path("path", &long).message,
            format!(
                "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '{}...",
                "x".repeat(127)
            )
        );
    }
}
