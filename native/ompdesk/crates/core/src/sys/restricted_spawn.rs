//! Windows process creation with an explicit inherited-handle list.
//! Argument quoting and executable lookup are adapted from Rust std revision 0ef1bc386:
//! library/std/src/sys/args/windows.rs and library/std/src/sys/process/windows.rs.
//! Copyright (c) The Rust Project Contributors; used under MIT (LICENSES/MIT-rust-std.txt).

use std::ffi::{OsStr, c_void};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::process::ExitStatus;
use std::ptr::{null, null_mut};

type Handle = *mut c_void;

#[repr(C)]
struct StartupInfo {
    size: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_chars: u32,
    y_chars: u32,
    fill: u32,
    flags: u32,
    show: u16,
    reserved_size: u16,
    reserved_bytes: *mut u8,
    input: Handle,
    output: Handle,
    error: Handle,
}
#[repr(C)]
struct StartupInfoEx {
    startup: StartupInfo,
    attributes: *mut c_void,
}
#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn GetStdHandle(which: u32) -> Handle;
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
    fn DuplicateHandle(
        source_process: Handle,
        source: Handle,
        target_process: Handle,
        target: *mut Handle,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous: *mut c_void,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        application: *const u16,
        command: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit: i32,
        flags: u32,
        environment: *mut c_void,
        directory: *const u16,
        startup: *mut StartupInfo,
        information: *mut ProcessInformation,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(handle: Handle, code: *mut u32) -> i32;
    fn TerminateProcess(handle: Handle, code: u32) -> i32;
}

fn duplicate_raw(source: Handle) -> io::Result<OwnedHandle> {
    let mut result = null_mut();
    // SAFETY: Both process handles are current-process pseudo handles; source is live and result is writable.
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            source,
            GetCurrentProcess(),
            &mut result,
            0,
            1,
            2,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: DuplicateHandle returned a new owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(result) })
}

fn duplicate(file: &File) -> io::Result<OwnedHandle> {
    duplicate_raw(file.as_raw_handle())
}

fn output_handle(file: Option<&File>, standard: u32) -> io::Result<OwnedHandle> {
    if let Some(file) = file {
        return duplicate(file);
    }
    // SAFETY: GetStdHandle returns the current process's borrowed standard handle.
    let handle = unsafe { GetStdHandle(standard) };
    if handle.is_null() || handle as isize == -1 {
        return duplicate(&File::create("NUL")?);
    }
    match duplicate_raw(handle) {
        Err(error) if error.raw_os_error() == Some(6) => duplicate(&File::create("NUL")?),
        result => result,
    }
}

struct Attributes {
    storage: Vec<usize>,
}
impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: storage contains an initialized attribute list until this drop.
        unsafe { DeleteProcThreadAttributeList(self.storage.as_mut_ptr().cast()) }
    }
}

pub struct RestrictedChild {
    process: OwnedHandle,
    id: u32,
}
impl RestrictedChild {
    pub fn id(&self) -> u32 {
        self.id
    }
    pub fn raw_handle(&self) -> Handle {
        self.process.as_raw_handle()
    }
    pub fn kill(&self) -> io::Result<()> {
        // SAFETY: process is a live owned process handle.
        if unsafe { TerminateProcess(self.raw_handle(), 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        // SAFETY: process remains owned while waiting.
        if unsafe { WaitForSingleObject(self.raw_handle(), u32::MAX) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut code = 0;
        // SAFETY: process is live and code is writable.
        if unsafe { GetExitCodeProcess(self.raw_handle(), &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(ExitStatus::from_raw(code))
    }
}

fn quote(value: &OsStr, line: &mut Vec<u16>, always: bool) {
    let quoted = always
        || value.is_empty()
        || value
            .as_encoded_bytes()
            .iter()
            .any(|byte| *byte == b' ' || *byte == b'\t');
    if quoted {
        line.push(b'"' as u16);
    }
    let mut slashes = 0;
    for ch in value.encode_wide() {
        if ch == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        if ch == b'"' as u16 {
            line.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
        } else {
            line.extend(std::iter::repeat_n(b'\\' as u16, slashes));
        }
        slashes = 0;
        line.push(ch);
    }
    line.extend(std::iter::repeat_n(
        b'\\' as u16,
        if quoted { slashes * 2 } else { slashes },
    ));
    if quoted {
        line.push(b'"' as u16);
    }
}

fn system_directory(system: bool) -> io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    let mut buffer = vec![0u16; 260];
    loop {
        // SAFETY: buffer is writable for its declared capacity.
        let length = unsafe {
            if system {
                GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
            } else {
                GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
            }
        } as usize;
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() {
            return Ok(std::ffi::OsString::from_wide(&buffer[..length]).into());
        }
        buffer.resize(length + 1, 0);
    }
}

fn resolve(program: &OsStr) -> io::Result<std::path::PathBuf> {
    use std::path::{Path, PathBuf};
    let path = Path::new(program);
    let text = program.to_string_lossy();
    if text.is_empty() || text.ends_with(['\\', '/']) || text.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid program path",
        ));
    }
    let has_exe = text.to_ascii_lowercase().ends_with(".exe");
    if text.contains(['\\', '/', ':']) {
        if !has_exe {
            let mut candidate = program.to_os_string();
            candidate.push(".exe");
            if std::fs::symlink_metadata(&candidate).is_ok() {
                return Ok(candidate.into());
            }
        }
        return Ok(path.to_path_buf());
    }
    let mut name = program.to_os_string();
    if !text.contains('.') {
        name.push(".exe");
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .filter(|p| !p.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    if let Ok(dir) = system_directory(true) {
        dirs.push(dir);
    }
    if let Ok(dir) = system_directory(false) {
        dirs.push(dir);
    }
    dirs.into_iter()
        .map(|dir| dir.join(&name))
        .find(|candidate| std::fs::symlink_metadata(candidate).is_ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "program not found"))
}

fn batch_line(program: &OsStr, args: &[String], raw_args: Option<&str>) -> io::Result<Vec<u16>> {
    let script: Vec<u16> = program.encode_wide().collect();
    if script.contains(&(b'"' as u16)) || script.last() == Some(&(b'\\' as u16)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid batch file path",
        ));
    }
    let mut line: Vec<u16> = "cmd.exe /e:ON /v:OFF /d /c \"\"".encode_utf16().collect();
    line.extend(script);
    line.push(b'"' as u16);
    if let Some(raw) = raw_args {
        line.push(b' ' as u16);
        line.extend(OsStr::new(raw).encode_wide());
    }
    for arg in if raw_args.is_some() { &[][..] } else { args } {
        if arg.contains(['\r', '\n', '\0']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid batch file argument",
            ));
        }
        line.push(b' ' as u16);
        let quoted = arg.is_empty()
            || arg.ends_with('\\')
            || arg.chars().any(|c| {
                c.is_control()
                    || (c.is_ascii() && !(c.is_ascii_alphanumeric() || "#$*+-./:?@\\_".contains(c)))
            });
        if quoted {
            line.push(b'"' as u16);
        }
        let mut slashes = 0;
        for ch in arg.encode_utf16() {
            if ch == b'\\' as u16 {
                slashes += 1;
            } else {
                if ch == b'"' as u16 {
                    line.extend(std::iter::repeat_n(b'\\' as u16, slashes));
                    line.push(b'"' as u16);
                } else if ch == b'%' as u16 {
                    line.extend("%%cd:~,".encode_utf16());
                }
                slashes = 0;
            }
            line.push(ch);
        }
        if quoted {
            line.extend(std::iter::repeat_n(b'\\' as u16, slashes));
            line.push(b'"' as u16);
        }
    }
    line.push(b'"' as u16);
    Ok(line)
}

pub fn spawn(
    program: &OsStr,
    args: &[String],
    raw_args: Option<&str>,
    input: &File,
    output: Option<&File>,
) -> io::Result<RestrictedChild> {
    let input = duplicate(input)?;
    let stdout = output_handle(output, (-11i32) as u32)?;
    let stderr = output_handle(output, (-12i32) as u32)?;
    let mut handles = [
        input.as_raw_handle(),
        stdout.as_raw_handle(),
        stderr.as_raw_handle(),
    ];
    let mut size = 0;
    // SAFETY: A null list queries the necessary allocation size.
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
    if size == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
    // SAFETY: storage is aligned and holds at least size bytes; the API initializes one attribute slot.
    if unsafe { InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut size) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut attributes = Attributes { storage };
    // SAFETY: the initialized list and handle array remain live through CreateProcessW.
    if unsafe {
        UpdateProcThreadAttribute(
            attributes.storage.as_mut_ptr().cast(),
            0,
            0x0002_0002,
            handles.as_mut_ptr().cast(),
            size_of_val(&handles),
            null_mut(),
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let resolved = resolve(program)?;
    let is_batch = resolved.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("bat") || extension.eq_ignore_ascii_case("cmd")
    });
    let (application, mut line) = if is_batch {
        (
            system_directory(true)?.join("cmd.exe"),
            batch_line(resolved.as_os_str(), args, raw_args)?,
        )
    } else {
        let mut line = Vec::new();
        quote(program, &mut line, true);
        if let Some(raw) = raw_args {
            line.push(32);
            line.extend(OsStr::new(raw).encode_wide());
        } else {
            for arg in args {
                line.push(32);
                quote(OsStr::new(arg), &mut line, false);
            }
        }
        (resolved, line)
    };
    if line.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command contains a NUL",
        ));
    }
    line.push(0);
    let mut environment: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("OMPDESK_SETUP_SPEC"))
        .collect();
    environment.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in environment {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    // SAFETY: zero is valid initialization for STARTUPINFOEX and PROCESS_INFORMATION.
    let mut startup: StartupInfoEx = unsafe { std::mem::zeroed() };
    startup.startup.size = size_of::<StartupInfoEx>() as u32;
    startup.startup.flags = 0x100;
    startup.startup.input = handles[0];
    startup.startup.output = handles[1];
    startup.startup.error = handles[2];
    startup.attributes = attributes.storage.as_mut_ptr().cast();
    // SAFETY: zero is valid initialization for PROCESS_INFORMATION.
    let mut info: ProcessInformation = unsafe { std::mem::zeroed() };
    let application: Vec<u16> = application.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: all pointers refer to live initialized buffers; the command line is mutable and NUL-terminated.
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            null_mut(),
            null_mut(),
            1,
            0x0008_0000 | 0x0800_0000 | 0x0000_0004 | 0x0000_0400,
            block.as_mut_ptr().cast(),
            null(),
            &mut startup.startup,
            &mut info,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateProcessW returned two distinct owned handles.
    let process = unsafe { OwnedHandle::from_raw_handle(info.process) };
    // SAFETY: the thread handle is newly owned and may close while the process remains suspended.
    drop(unsafe { OwnedHandle::from_raw_handle(info.thread) });
    Ok(RestrictedChild {
        process,
        id: info.process_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit: i32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreatePipe(
            read: *mut Handle,
            write: *mut Handle,
            attributes: *mut SecurityAttributes,
            size: u32,
        ) -> i32;
        fn PeekNamedPipe(
            pipe: Handle,
            buffer: *mut c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            remaining: *mut u32,
        ) -> i32;
        fn WriteFile(
            file: Handle,
            buffer: *const c_void,
            length: u32,
            written: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
    }

    fn pipe(inheritable: bool) -> (File, File) {
        let mut read = null_mut();
        let mut write = null_mut();
        let mut attrs = SecurityAttributes {
            length: size_of::<SecurityAttributes>() as u32,
            descriptor: null_mut(),
            inherit: i32::from(inheritable),
        };
        // SAFETY: the output pointers and security attributes are valid for the call.
        assert_ne!(
            unsafe { CreatePipe(&mut read, &mut write, &mut attrs, 0) },
            0
        );
        // SAFETY: CreatePipe returned two distinct owned handles.
        unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) }
    }

    #[test]
    #[ignore]
    fn probe() {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).unwrap();
        let handle = text.parse::<usize>().unwrap() as Handle;
        let marker = b"leaked";
        let mut written = 0;
        // SAFETY: the handle value is deliberately untrusted; WriteFile validates it in the kernel.
        unsafe {
            WriteFile(
                handle,
                marker.as_ptr().cast(),
                marker.len() as u32,
                &mut written,
                null_mut(),
            )
        };
        println!("restricted-handle-probe-ran");
        eprintln!("restricted-stderr-probe-ran");
    }

    #[test]
    fn isolated_child_does_not_inherit_unrelated_pipe() {
        let (sentinel_read, sentinel_write) = pipe(true);
        let (input, mut writer) = pipe(false);
        write!(writer, "{}", sentinel_write.as_raw_handle() as usize).unwrap();
        drop(writer);
        let (mut output_read, output) = pipe(false);
        let exe = std::env::current_exe().unwrap();
        let args = vec![
            "--exact".into(),
            "sys::restricted_spawn::tests::probe".into(),
            "--ignored".into(),
            "--nocapture".into(),
        ];
        let mut child = spawn(exe.as_os_str(), &args, None, &input, Some(&output)).unwrap();
        drop(output);
        let tree = super::super::ProcessTree::outliving(child.raw_handle()).unwrap();
        super::super::resume_process(child.id()).unwrap();
        assert!(child.wait().unwrap().success());
        let mut text = String::new();
        output_read.read_to_string(&mut text).unwrap();
        assert!(text.contains("restricted-handle-probe-ran"));
        assert!(text.contains("restricted-stderr-probe-ran"));
        let mut available = 0;
        // SAFETY: sentinel_read is a live pipe and available points to writable storage.
        assert_ne!(
            unsafe {
                PeekNamedPipe(
                    sentinel_read.as_raw_handle(),
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            },
            0
        );
        assert_eq!(available, 0, "child inherited an unrelated pipe");
        drop(tree);
        drop(sentinel_write);
    }

    #[test]
    #[ignore]
    fn inherit_probe() {
        let (input, mut writer) = pipe(false);
        write!(writer, "0").unwrap();
        drop(writer);
        let exe = std::env::current_exe().unwrap();
        let args = vec![
            "--exact".into(),
            "sys::restricted_spawn::tests::probe".into(),
            "--ignored".into(),
            "--nocapture".into(),
        ];
        let mut child = spawn(exe.as_os_str(), &args, None, &input, None).unwrap();
        let tree = super::super::ProcessTree::outliving(child.raw_handle()).unwrap();
        super::super::resume_process(child.id()).unwrap();
        assert!(child.wait().unwrap().success());
        drop(tree);
    }

    #[test]
    fn isolated_child_inherits_selected_standard_streams() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "sys::restricted_spawn::tests::inherit_probe",
                "--ignored",
                "--nocapture",
            ])
            .output()
            .unwrap();
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stdout).contains("restricted-handle-probe-ran"));
        assert!(String::from_utf8_lossy(&result.stderr).contains("restricted-stderr-probe-ran"));
        assert!(!String::from_utf8_lossy(&result.stdout).contains("restricted-stderr-probe-ran"));
        assert!(!String::from_utf8_lossy(&result.stderr).contains("restricted-handle-probe-ran"));
    }

    #[test]
    fn failed_spawn_releases_redirected_handles() {
        let input = File::open("NUL").unwrap();
        let (read, output) = pipe(false);
        let result = spawn(
            OsStr::new(r"Z:\ompdesk-missing\missing.exe"),
            &[],
            None,
            &input,
            Some(&output),
        );
        assert!(result.is_err());
        drop(output);
        let mut available = 0;
        // SAFETY: read is a live pipe and available is writable; no writers remain.
        assert_eq!(
            unsafe {
                PeekNamedPipe(
                    read.as_raw_handle(),
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            },
            0
        );
    }

    #[test]
    fn isolated_job_stop_waits_for_child_exit() {
        let (input, writer) = pipe(false);
        let output = File::create("NUL").unwrap();
        let exe = std::env::current_exe().unwrap();
        let args = vec![
            "--exact".into(),
            "sys::restricted_spawn::tests::probe".into(),
            "--ignored".into(),
        ];
        let mut child = spawn(exe.as_os_str(), &args, None, &input, Some(&output)).unwrap();
        let tree = super::super::ProcessTree::outliving(child.raw_handle()).unwrap();
        super::super::resume_process(child.id()).unwrap();
        tree.end();
        assert!(!child.wait().unwrap().success());
        drop(writer);
    }
}
