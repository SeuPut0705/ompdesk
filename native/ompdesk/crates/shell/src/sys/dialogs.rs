//! `dialog.*` on Windows: a TaskDialog for the message box (custom buttons, verification checkbox, the icon by type)
//! and the common item dialogs (IFileOpenDialog / IFileSaveDialog) for files and folders. Everything here runs on the
//! thread that calls it and is modal: call it from CEF's UI thread.

use std::ffi::c_void;
use std::path::Path;
use std::sync::LazyLock;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemFree};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FOS_ALLOWMULTISELECT, FOS_CREATEPROMPT, FOS_DONTADDTORECENT, FOS_FILEMUSTEXIST,
    FOS_FORCEFILESYSTEM, FOS_FORCESHOWHIDDEN, FOS_OVERWRITEPROMPT, FOS_PICKFOLDERS, FileOpenDialog,
    FileSaveDialog, IFileDialog, IFileOpenDialog, IFileSaveDialog, IShellItem,
    SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
};
use windows::core::{HRESULT, PCWSTR};
use windows_sys::Win32::Foundation::{HMODULE, HWND as RawHwnd, LPARAM, WPARAM};
use windows_sys::Win32::System::ApplicationInstallationAndServicing::{
    ACTCTXW, ActivateActCtx, CreateActCtxW, DeactivateActCtx, ReleaseActCtx,
};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows_sys::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TD_ERROR_ICON, TD_INFORMATION_ICON,
    TD_WARNING_ICON, TDF_ALLOW_DIALOG_CANCELLATION, TDF_POSITION_RELATIVE_TO_WINDOW,
    TDF_USE_COMMAND_LINKS, TDF_VERIFICATION_FLAG_CHECKED, TDM_CLICK_BUTTON, TDN_CREATED,
    TDN_DESTROYED,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{IDCANCEL, PostMessageW};

use super::comthread;
use crate::dialog_spec::{
    ButtonPlan, DialogCancel, FileDialogSpec, MessageBoxResult, MessageBoxSpec, MessageType,
    default_extension, split_default_path,
};

/// The title of a box that gave none.
const APP_NAME: &str = "OMPdesk";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn hwnd_of(owner: isize) -> Option<HWND> {
    (owner != 0).then_some(HWND(owner as *mut c_void))
}

fn describe(context: &str) -> impl Fn(windows::core::Error) -> String + '_ {
    move |error| {
        format!(
            "{context}: {} (0x{:08X})",
            error.message().trim(),
            error.code().0 as u32
        )
    }
}

// ------------------------------------------------------------------ message box

type TaskDialogIndirectFn =
    unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut i32) -> i32;

/// TaskDialogIndirect lives in comctl32 v6 only. The shell's manifest may not ask for v6, so the function is looked
/// up at run time (a static import would stop the process from starting under v5) and, when the process is bound to
/// v5, v6 is loaded through an activation context made from a small manifest.
struct TaskDialogApi {
    call: TaskDialogIndirectFn,
    /// 0 when the process already runs v6.
    activation: isize,
}

// SAFETY: the function pointer and the activation context handle are process-wide and immutable once found.
unsafe impl Send for TaskDialogApi {}
// SAFETY: as above; nothing is mutated after construction.
unsafe impl Sync for TaskDialogApi {}

const COMCTL6_MANIFEST: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n\
<assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\" manifestVersion=\"1.0\"><dependency><dependentAssembly>\
<assemblyIdentity type=\"win32\" name=\"Microsoft.Windows.Common-Controls\" version=\"6.0.0.0\" processorArchitecture=\"*\" \
publicKeyToken=\"6595b64144ccf1df\" language=\"*\"/></dependentAssembly></dependency></assembly>\r\n";

fn find_task_dialog() -> Option<TaskDialogIndirectFn> {
    let dll = wide("comctl32.dll");
    // SAFETY: a NUL-terminated library name; comctl32 stays loaded for the process.
    let module: HMODULE = unsafe { LoadLibraryW(dll.as_ptr()) };
    if module.is_null() {
        return None;
    }
    // SAFETY: a loaded module and a NUL-terminated export name.
    let found = unsafe { GetProcAddress(module, c"TaskDialogIndirect".as_ptr().cast()) };
    // SAFETY: TaskDialogIndirect has exactly the signature of `TaskDialogIndirectFn` (comctl32.h).
    found.map(|f| unsafe {
        std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirectFn>(f)
    })
}

fn load_task_dialog() -> Result<TaskDialogApi, String> {
    if let Some(call) = find_task_dialog() {
        return Ok(TaskDialogApi {
            call,
            activation: 0,
        });
    }
    let manifest = std::env::temp_dir().join("ompdesk-shell-comctl6.manifest");
    if std::fs::read_to_string(&manifest).ok().as_deref() != Some(COMCTL6_MANIFEST) {
        std::fs::write(&manifest, COMCTL6_MANIFEST)
            .map_err(|e| format!("writing {}: {e}", manifest.display()))?;
    }
    let source = wide(&manifest.to_string_lossy());
    // SAFETY: ACTCTXW is plain data; zero means "not set" for every field the flags do not name.
    let mut context: ACTCTXW = unsafe { std::mem::zeroed() };
    context.cbSize = std::mem::size_of::<ACTCTXW>() as u32;
    context.lpSource = source.as_ptr();
    // SAFETY: `context` is filled in and `source` outlives the call.
    let handle = unsafe { CreateActCtxW(&context) };
    if handle.is_null() || handle as isize == -1 {
        return Err(format!(
            "comctl32 v6 is not available: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut cookie = 0usize;
    // SAFETY: a context handle just created; the cookie is released below.
    if unsafe { ActivateActCtx(handle, &mut cookie) } == 0 {
        let error = std::io::Error::last_os_error();
        // SAFETY: the handle came from CreateActCtxW and is not used again.
        unsafe { ReleaseActCtx(handle) };
        return Err(format!("activating comctl32 v6: {error}"));
    }
    let found = find_task_dialog();
    // SAFETY: the cookie came from the ActivateActCtx above, on this thread.
    unsafe { DeactivateActCtx(0, cookie) };
    match found {
        Some(call) => Ok(TaskDialogApi {
            call,
            activation: handle as isize,
        }),
        None => {
            // SAFETY: the handle came from CreateActCtxW and is not used again.
            unsafe { ReleaseActCtx(handle) };
            Err("comctl32 does not export TaskDialogIndirect".into())
        }
    }
}

fn task_dialog_api() -> Result<&'static TaskDialogApi, String> {
    static API: LazyLock<Result<TaskDialogApi, String>> = LazyLock::new(load_task_dialog);
    API.as_ref().map_err(Clone::clone)
}

/// TaskDialog's notifications: once the box exists, a cancel clicks its IDCANCEL (the Esc key's answer, allowed by
/// `TDF_ALLOW_DIALOG_CANCELLATION`); once it is gone, a cancel does nothing.
unsafe extern "system" fn on_task_dialog(
    hwnd: RawHwnd,
    msg: u32,
    _wparam: WPARAM,
    _lparam: LPARAM,
    data: isize,
) -> i32 {
    // SAFETY: `data` is the `&DialogCancel` `message_box` put in `lpCallbackData`; it outlives TaskDialogIndirect,
    // which is the only caller of this function.
    let cancel = unsafe { &*(data as *const DialogCancel) };
    match msg as i32 {
        TDN_CREATED => {
            let hwnd = hwnd as isize;
            cancel.arm(move || {
                // SAFETY: a plain message post; a handle that is gone meanwhile only makes the post fail.
                unsafe {
                    PostMessageW(
                        hwnd as RawHwnd,
                        TDM_CLICK_BUTTON as u32,
                        IDCANCEL as WPARAM,
                        0,
                    )
                };
            });
        }
        TDN_DESTROYED => cancel.disarm(),
        _ => {}
    }
    0
}

/// Shows the message box and waits for it. `owner` is the window handle (0 for none). A `cancel` closes it as the Esc
/// key does: the answer is `cancelId`.
pub fn message_box(
    owner: isize,
    spec: &MessageBoxSpec,
    cancel: &DialogCancel,
) -> Result<MessageBoxResult, String> {
    comthread::init();
    let api = task_dialog_api()?;
    let plan = ButtonPlan::new(spec);
    if cancel.is_cancelled() {
        return Ok(MessageBoxResult {
            response: spec.cancel_id,
            checkbox_checked: spec.checkbox_checked,
        });
    }

    let title = wide(if spec.title.is_empty() {
        APP_NAME
    } else {
        &spec.title
    });
    let message = wide(&spec.message);
    let detail = wide(&spec.detail);
    let checkbox = spec.checkbox_label.as_deref().map(wide);
    let labels: Vec<(i32, Vec<u16>)> = plan
        .custom
        .iter()
        .map(|(id, label)| (*id, wide(label)))
        .collect();
    let buttons: Vec<TASKDIALOG_BUTTON> = labels
        .iter()
        .map(|(id, label)| TASKDIALOG_BUTTON {
            nButtonID: *id,
            pszButtonText: label.as_ptr(),
        })
        .collect();

    let icon = match spec.kind {
        MessageType::None => std::ptr::null(),
        MessageType::Info | MessageType::Question => TD_INFORMATION_ICON,
        MessageType::Warning => TD_WARNING_ICON,
        MessageType::Error => TD_ERROR_ICON,
    };
    let mut flags = TDF_ALLOW_DIALOG_CANCELLATION;
    if !spec.no_link {
        flags |= TDF_USE_COMMAND_LINKS;
    }
    if spec.checkbox_checked {
        flags |= TDF_VERIFICATION_FLAG_CHECKED;
    }
    if owner != 0 {
        flags |= TDF_POSITION_RELATIVE_TO_WINDOW;
    }

    // SAFETY: TASKDIALOGCONFIG is plain data (pointers, integers, unions of them); zero is "not set" for each field.
    let mut config: TASKDIALOGCONFIG = unsafe { std::mem::zeroed() };
    config.cbSize = std::mem::size_of::<TASKDIALOGCONFIG>() as u32;
    config.hwndParent = owner as _;
    config.dwFlags = flags;
    config.dwCommonButtons = plan.common_flags;
    config.pszWindowTitle = title.as_ptr();
    config.Anonymous1 = TASKDIALOGCONFIG_0 { pszMainIcon: icon };
    config.pszMainInstruction = message.as_ptr();
    if !spec.detail.is_empty() {
        config.pszContent = detail.as_ptr();
    }
    config.cButtons = buttons.len() as u32;
    config.pButtons = if buttons.is_empty() {
        std::ptr::null()
    } else {
        buttons.as_ptr()
    };
    config.nDefaultButton = plan.default_button;
    config.pszVerificationText = checkbox.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
    config.pfCallback = Some(on_task_dialog);
    config.lpCallbackData = cancel as *const DialogCancel as isize;

    let mut pressed = 0i32;
    let mut verified = 0i32;
    let mut cookie = 0usize;
    let activated = api.activation != 0 && {
        // SAFETY: the context handle is the one `load_task_dialog` made and kept for the process.
        unsafe { ActivateActCtx(api.activation as _, &mut cookie) != 0 }
    };
    // SAFETY: `config` and everything it points to (the wide strings and the button array above) outlive the call;
    // the out-pointers are valid i32 locals; the radio button out-pointer may be null.
    let hr = unsafe { (api.call)(&config, &mut pressed, std::ptr::null_mut(), &mut verified) };
    if activated {
        // SAFETY: the cookie came from the activation above, on this thread.
        unsafe { DeactivateActCtx(0, cookie) };
    }
    cancel.disarm();
    if hr < 0 {
        return Err(format!(
            "the message box could not be shown (HRESULT 0x{:08X})",
            hr as u32
        ));
    }
    Ok(MessageBoxResult {
        response: plan.index_for(pressed),
        checkbox_checked: verified != 0,
    })
}

// ------------------------------------------------------------------ file dialogs

/// What a dialog needs to stay alive while it is open: the strings the filter specs point at.
struct Keep(Vec<Vec<u16>>);

impl Keep {
    fn text(&mut self, s: &str) -> PCWSTR {
        self.0.push(wide(s));
        PCWSTR(self.0.last().map_or(std::ptr::null(), |v| v.as_ptr()))
    }
}

fn folder_item(path: &str) -> Option<IShellItem> {
    let wide_path = wide(&crate::shell_args::windows_path(path));
    // SAFETY: a NUL-terminated path that outlives the call; no bind context.
    unsafe {
        SHCreateItemFromParsingName::<_, _, IShellItem>(
            PCWSTR(wide_path.as_ptr()),
            None::<&windows::Win32::System::Com::IBindCtx>,
        )
    }
    .ok()
}

fn is_dir(path: &str) -> bool {
    Path::new(&crate::shell_args::windows_path(path)).is_dir()
}

/// The settings both kinds share: title, button label, file types, start folder and name, hidden files, recents.
fn configure(
    dialog: &IFileDialog,
    spec: &FileDialogSpec,
    save: bool,
    keep: &mut Keep,
) -> Result<(), String> {
    // SAFETY (this whole function): COM calls on a live dialog object; every PCWSTR points into `keep` or a local
    // that outlives the call, and the filter array lives until `SetFileTypes` returns.
    unsafe {
        let mut options = dialog
            .GetOptions()
            .map_err(describe("reading the dialog options"))?;
        options |= FOS_FORCEFILESYSTEM;
        if spec.show_hidden {
            options |= FOS_FORCESHOWHIDDEN;
        }
        if spec.dont_add_to_recent {
            options |= FOS_DONTADDTORECENT;
        }
        if save {
            options |= FOS_OVERWRITEPROMPT;
        } else {
            if spec.open_directory {
                options |= FOS_PICKFOLDERS;
            }
            if spec.multi_selections {
                options |= FOS_ALLOWMULTISELECT;
            }
            if spec.prompt_to_create {
                options &= !FOS_FILEMUSTEXIST;
                options |= FOS_CREATEPROMPT;
            }
        }
        dialog
            .SetOptions(options)
            .map_err(describe("setting the dialog options"))?;

        if let Some(title) = &spec.title {
            dialog
                .SetTitle(keep.text(title))
                .map_err(describe("setting the title"))?;
        }
        if let Some(label) = &spec.button_label {
            dialog
                .SetOkButtonLabel(keep.text(label))
                .map_err(describe("setting the button label"))?;
        }
        // Folder pickers show no file types.
        if (save || !spec.open_directory) && !spec.filters.is_empty() {
            let specs: Vec<COMDLG_FILTERSPEC> = spec
                .filters
                .iter()
                .map(|f| {
                    let name = keep.text(&f.name);
                    let pattern = keep.text(&f.pattern);
                    COMDLG_FILTERSPEC {
                        pszName: name,
                        pszSpec: pattern,
                    }
                })
                .collect();
            dialog
                .SetFileTypes(&specs)
                .map_err(describe("setting the file types"))?;
            dialog
                .SetFileTypeIndex(1)
                .map_err(describe("selecting the first file type"))?;
            if save && let Some(ext) = default_extension(&spec.filters) {
                dialog
                    .SetDefaultExtension(keep.text(ext))
                    .map_err(describe("setting the default extension"))?;
            }
        }
        if let Some(path) = &spec.default_path {
            let split = split_default_path(path, is_dir);
            if let Some(folder) = split
                .folder
                .as_deref()
                .filter(|f| is_dir(f))
                .and_then(folder_item)
            {
                dialog
                    .SetFolder(&folder)
                    .map_err(describe("setting the start folder"))?;
            }
            if let Some(name) = &split.name {
                dialog
                    .SetFileName(keep.text(name))
                    .map_err(describe("setting the file name"))?;
            }
        }
    }
    Ok(())
}

/// The dialog shown, `Ok(false)` for a user who backed out.
fn show(dialog: &IFileDialog, owner: isize) -> Result<bool, String> {
    // SAFETY: Show runs the dialog's modal loop on this thread; the owner handle is a window of this process or none.
    match unsafe { dialog.Show(hwnd_of(owner)) } {
        Ok(()) => Ok(true),
        // HRESULT_FROM_WIN32(ERROR_CANCELLED)
        Err(e) if e.code() == HRESULT(0x800704C7u32 as i32) => Ok(false),
        Err(e) => Err(describe("showing the file dialog")(e)),
    }
}

fn path_of(item: &IShellItem) -> Result<String, String> {
    // SAFETY: GetDisplayName returns a CoTaskMem string that is read once and freed below.
    unsafe {
        let name = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(describe("reading the chosen path"))?;
        let path = name
            .to_string()
            .map_err(|e| format!("the chosen path is not valid text: {e}"));
        CoTaskMemFree(Some(name.0 as *const c_void));
        path
    }
}

/// `Ok(None)` when the user cancelled.
pub fn open_dialog(owner: isize, spec: &FileDialogSpec) -> Result<Option<Vec<String>>, String> {
    comthread::init();
    // SAFETY: CoCreateInstance of the system's open dialog class in this (initialized) apartment.
    let dialog: IFileOpenDialog =
        unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }
            .map_err(describe("creating the open dialog"))?;
    let mut keep = Keep(Vec::new());
    configure(&dialog, spec, false, &mut keep)?;
    if !show(&dialog, owner)? {
        return Ok(None);
    }
    // SAFETY: the dialog returned OK, so its results are readable.
    let items = unsafe { dialog.GetResults() }.map_err(describe("reading the chosen files"))?;
    // SAFETY: `items` is a live IShellItemArray.
    let count = unsafe { items.GetCount() }.map_err(describe("counting the chosen files"))?;
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        // SAFETY: `index` is below the count just read.
        let item = unsafe { items.GetItemAt(index) }.map_err(describe("reading a chosen file"))?;
        paths.push(path_of(&item)?);
    }
    Ok(Some(paths))
}

/// `Ok(None)` when the user cancelled.
pub fn save_dialog(owner: isize, spec: &FileDialogSpec) -> Result<Option<String>, String> {
    comthread::init();
    // SAFETY: CoCreateInstance of the system's save dialog class in this (initialized) apartment.
    let dialog: IFileSaveDialog =
        unsafe { CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER) }
            .map_err(describe("creating the save dialog"))?;
    let mut keep = Keep(Vec::new());
    configure(&dialog, spec, true, &mut keep)?;
    if !show(&dialog, owner)? {
        return Ok(None);
    }
    // SAFETY: the dialog returned OK, so its result is readable.
    let item = unsafe { dialog.GetResult() }.map_err(describe("reading the chosen file"))?;
    path_of(&item).map(Some)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    fn confirm_spec() -> MessageBoxSpec {
        MessageBoxSpec::from_json(&json!({
            "type": "question",
            "title": "Outside process",
            "message": "Allow?",
            "buttons": ["Allow", "Don't allow"],
            "defaultId": 1,
            "cancelId": 1,
        }))
    }

    /// The control socket's confirm card (`ipc.ts` `confirmOutside`) times out: the box that is up closes and the
    /// answer is its `cancelId` (refused). The box returning at all is the proof it closed.
    /// It shows a real TaskDialog for half a second, so it runs only on a GitHub runner, never on a person's desktop.
    #[test]
    fn a_cancelled_box_closes_and_answers_its_cancel_id() {
        if std::env::var_os("GITHUB_ACTIONS").is_none() {
            return;
        }
        let cancel = Arc::new(DialogCancel::default());
        let (done, answered) = mpsc::channel();
        let shown = cancel.clone();
        std::thread::spawn(move || {
            let _ = done.send(message_box(0, &confirm_spec(), &shown));
        });
        std::thread::sleep(Duration::from_millis(500));
        cancel.cancel();
        let result = answered
            .recv_timeout(Duration::from_secs(10))
            .expect("the cancelled box is still open after 10 s");
        assert_eq!(
            result,
            Ok(MessageBoxResult {
                response: 1,
                checkbox_checked: false
            })
        );
    }

    #[test]
    fn a_box_cancelled_before_it_shows_answers_at_once() {
        let cancel = DialogCancel::default();
        cancel.cancel();
        assert_eq!(
            message_box(0, &confirm_spec(), &cancel).map(|r| r.response),
            Ok(1)
        );
    }
}
