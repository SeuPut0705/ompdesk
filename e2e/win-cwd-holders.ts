/**
 * Prints `pid ppid name cwd` for every process whose working directory is `<folder>` or below it (`bun
 * e2e/win-cwd-holders.ts <folder>`): the answer to "who holds this folder" when `fs.rm` fails `EBUSY` with the app
 * gone, which neither Restart Manager (it names files, not a working directory) nor a command-line search
 * (`survivors`: a child of a shim has none that names the folder) gives. The directory is read from the process's
 * PEB (`RTL_USER_PROCESS_PARAMETERS.CurrentDirectory`, x64 offsets), so a process this user may not open, or a
 * 32-bit one, is skipped. A holder whose parent is gone is an orphan: its tree was ended before it existed
 * (docs/windows-dev.md).
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const PROCESS_QUERY_INFORMATION_AND_VM_READ = 0x0410;
const TH32CS_SNAPPROCESS = 0x2;
const ENTRY_SIZE = 568;
const PEB_PROCESS_PARAMETERS = 0x20n;
const PARAMETERS_CURRENT_DIRECTORY = 0x38n;

const { symbols: kernel } = dlopen("kernel32.dll", {
	CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
	Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
	CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	ReadProcessMemory: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});
const { symbols: nt } = dlopen("ntdll.dll", {
	NtQueryInformationProcess: {
		args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
		returns: FFIType.i32,
	},
});

function read(handle: bigint, address: bigint, bytes: number): Buffer | null {
	const out = Buffer.alloc(bytes);
	return kernel.ReadProcessMemory(handle, address, ptr(out), BigInt(bytes), ptr(Buffer.alloc(8))) ? out : null;
}

function currentDirectory(handle: bigint): string | null {
	const basic = Buffer.alloc(48);
	if (nt.NtQueryInformationProcess(handle, 0, ptr(basic), basic.length, null) !== 0) return null;
	const parameters = read(handle, basic.readBigUInt64LE(8) + PEB_PROCESS_PARAMETERS, 8);
	if (!parameters) return null;
	// UNICODE_STRING { u16 Length; u16 MaximumLength; PWSTR Buffer }
	const header = read(handle, parameters.readBigUInt64LE(0) + PARAMETERS_CURRENT_DIRECTORY, 16);
	const text = header ? read(handle, header.readBigUInt64LE(8), header.readUInt16LE(0)) : null;
	return text ? text.toString("utf16le") : null;
}

const folder = process.argv[2]?.toLowerCase().replaceAll("/", "\\");
if (!folder) throw new Error("usage: bun e2e/win-cwd-holders.ts <folder>");
const snapshot = kernel.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
const entry = Buffer.alloc(ENTRY_SIZE);
entry.writeUInt32LE(ENTRY_SIZE, 0);
for (
	let more = kernel.Process32FirstW(snapshot, ptr(entry));
	more;
	more = kernel.Process32NextW(snapshot, ptr(entry))
) {
	const pid = entry.readUInt32LE(8);
	const handle = kernel.OpenProcess(PROCESS_QUERY_INFORMATION_AND_VM_READ, 0, pid);
	if (handle === 0n) continue;
	const cwd = currentDirectory(handle);
	kernel.CloseHandle(handle);
	if (cwd?.toLowerCase().startsWith(folder)) {
		let end = 44;
		while (end < ENTRY_SIZE && entry.readUInt16LE(end) !== 0) end += 2;
		console.log(pid, entry.readUInt32LE(32), entry.toString("utf16le", 44, end), cwd);
	}
}
kernel.CloseHandle(snapshot);
