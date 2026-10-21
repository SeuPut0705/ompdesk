/**
 * Prints every Windows process as JSON (`WinProcess[]` of process-tree.ts) without asking WMI, which answers "call
 * cancelled" (0x80041032) while the machine is loaded. A spec runs this with bun (`bun e2e/win-processes.ts`)
 * because Playwright's own process is node and has no FFI: pid, parent, name and thread count come from a Toolhelp32
 * snapshot, the image path from `QueryFullProcessImageNameW`, the creation time from `GetProcessTimes` (a FILETIME,
 * the value `Win32_Process.CreationDate.ToFileTimeUtc()` gave) and the command line from
 * `NtQueryInformationProcess(ProcessCommandLineInformation)`. A process this user may not open (system, protected,
 * another user's, or one that exited since the snapshot) has `null` for what needs a handle.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_COMMAND_LINE_INFORMATION = 60;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0;
const STATUS_BUFFER_OVERFLOW = 0x80000005 | 0;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023 | 0;
const INVALID_HANDLE = 0xffffffffffffffffn;

/** x64 PROCESSENTRY32W: dwSize 0, th32ProcessID 8, cntThreads 28, th32ParentProcessID 32, szExeFile 44. */
const ENTRY_SIZE = 568;

const { symbols: kernel } = dlopen("kernel32.dll", {
	CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
	Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
	CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	GetProcessTimes: {
		args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
		returns: FFIType.i32,
	},
	QueryFullProcessImageNameW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
});
const { symbols: nt } = dlopen("ntdll.dll", {
	NtQueryInformationProcess: {
		args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
		returns: FFIType.i32,
	},
});

const wide = (buffer: Buffer, offset: number, bytes: number) => buffer.toString("utf16le", offset, offset + bytes);

function commandLine(handle: bigint): string | null {
	const returned = Buffer.alloc(4);
	let size = 0;
	for (let attempt = 0; attempt < 4; attempt++) {
		const out = Buffer.alloc(Math.max(size, 16));
		const status = nt.NtQueryInformationProcess(
			handle,
			PROCESS_COMMAND_LINE_INFORMATION,
			ptr(out),
			out.length,
			ptr(returned),
		);
		if (status === 0) {
			// UNICODE_STRING { u16 Length; u16 MaximumLength; PWSTR Buffer } with Buffer pointing just past the header.
			return wide(out, 16, out.readUInt16LE(0));
		}
		if (
			status !== STATUS_INFO_LENGTH_MISMATCH &&
			status !== STATUS_BUFFER_OVERFLOW &&
			status !== STATUS_BUFFER_TOO_SMALL
		)
			return null;
		size = returned.readUInt32LE(0);
	}
	return null;
}

function imagePath(handle: bigint): string | null {
	const path = Buffer.alloc(2 * 32768);
	const length = Buffer.alloc(4);
	length.writeUInt32LE(32768);
	return kernel.QueryFullProcessImageNameW(handle, 0, ptr(path), ptr(length))
		? wide(path, 0, length.readUInt32LE(0) * 2)
		: null;
}

function created(handle: bigint): string {
	const [start, exit, kernelTime, userTime] = [0, 1, 2, 3].map(() => Buffer.alloc(8));
	if (!kernel.GetProcessTimes(handle, ptr(start), ptr(exit), ptr(kernelTime), ptr(userTime))) return "";
	return start.readBigUInt64LE(0).toString();
}

const snapshot = kernel.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
if (snapshot === INVALID_HANDLE) throw new Error("CreateToolhelp32Snapshot failed");
const entry = Buffer.alloc(ENTRY_SIZE);
entry.writeUInt32LE(ENTRY_SIZE, 0);
const listing: unknown[] = [];
for (
	let more = kernel.Process32FirstW(snapshot, ptr(entry));
	more;
	more = kernel.Process32NextW(snapshot, ptr(entry))
) {
	const pid = entry.readUInt32LE(8);
	let end = 44;
	while (end < ENTRY_SIZE && entry.readUInt16LE(end) !== 0) end += 2;
	const row = {
		pid,
		ppid: entry.readUInt32LE(32),
		threads: entry.readUInt32LE(28),
		name: wide(entry, 44, end - 44),
		exe: null as string | null,
		commandLine: null as string | null,
		created: "",
	};
	const handle = pid === 0 ? 0n : kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
	if (handle !== 0n) {
		row.exe = imagePath(handle);
		row.commandLine = commandLine(handle);
		row.created = created(handle);
		kernel.CloseHandle(handle);
	}
	listing.push(row);
}
kernel.CloseHandle(snapshot);
process.stdout.write(JSON.stringify(listing));
