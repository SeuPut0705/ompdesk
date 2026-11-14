#[unsafe(no_mangle)]
pub extern "C" fn policy_abi_version() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn policy_alloc(len: u32) -> u32 {
    let bytes: Box<[u8]> = vec![0_u8; len as usize].into_boxed_slice();
    Box::into_raw(bytes).cast::<u8>() as u32
}

#[unsafe(no_mangle)]
/// # Safety
/// `ptr` and `len` must identify a live boxed byte slice returned by this module, exactly once.
pub unsafe extern "C" fn policy_free(ptr: u32, len: u32) {
    // SAFETY: the embedded adapter returns the exact live allocation and length from this module.
    drop(unsafe {
        Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            ptr as *mut u8,
            len as usize,
        ))
    });
}

fn error(code: &str, message: &str) -> String {
    serde_json::json!({"error": {"code": code, "message": message}}).to_string()
}

fn evaluate(input: &[u8]) -> String {
    let text = match std::str::from_utf8(input) {
        Ok(text) => text,
        Err(_) => return error("invalid_utf8", "Invalid UTF-8 memory prompt"),
    };
    let request: serde_json::Value = match serde_json::from_str(text) {
        Ok(request) => request,
        Err(problem) => return error("invalid_request", &problem.to_string()),
    };
    let Some(text) = request.get("text").and_then(serde_json::Value::as_str) else {
        return error("invalid_request", "Memory prompt text must be a string");
    };
    let name = match request.get("sessionName") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(name)) => Some(name.as_str()),
        _ => return error("invalid_request", "Memory session name must be a string"),
    };
    super::policy::facts(text, name).json()
}

#[unsafe(no_mangle)]
/// # Safety
/// `ptr` and `len` must identify an initialized live allocation from `policy_alloc`.
pub unsafe extern "C" fn policy_eval(ptr: u32, len: u32) -> u64 {
    // SAFETY: the adapter initialized policy_alloc's allocation and retains it through this call.
    let input = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let output = evaluate(input).into_bytes().into_boxed_slice();
    let length = output.len() as u64;
    let pointer = Box::into_raw(output).cast::<u8>() as u64;
    (pointer << 32) | length
}
