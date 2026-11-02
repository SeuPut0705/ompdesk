/**
 * Every Windows process with its parent and working set, for main's memory admission (`src/main/memory-sampler.ts`):
 * Electron's main has no FFI, and WMI answers "call cancelled" on a loaded machine (`.omp/rules/e2e-ci-windows.md`).
 * A Toolhelp32 snapshot names pid and parent (x64 `PROCESSENTRY32W`: pid at 8, parent at 32, as `e2e/win-processes.ts`
 * reads it); `K32GetProcessMemoryInfo` gives each process's working set (`PROCESS_MEMORY_COUNTERS.WorkingSetSize`
 * at 16). A process this user may not open counts 0 bytes. Runs in the terminals worker, whose requests never queue.
 */
import { dlopen, FFIType, type Library, ptr } from "bun:ffi";

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const INVALID_HANDLE = 0xffffffffffffffffn;
const ENTRY_SIZE = 568;
const COUNTERS_SIZE = 72;

interface ProcessRow {
	pid: number;
	ppid: number;
	bytes: number;
}

const KERNEL32 = {
	CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
	Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
	K32GetProcessMemoryInfo: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
} as const;

let kernel: Library<typeof KERNEL32>["symbols"] | undefined;

function symbols(): Library<typeof KERNEL32>["symbols"] {
	kernel ??= dlopen("kernel32.dll", KERNEL32).symbols;
	return kernel;
}
function workingSet(pid: number, counters: Buffer): number {
	const native = symbols();
	const handle = native.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
	if (!handle) return 0;
	try {
		counters.fill(0);
		counters.writeUInt32LE(COUNTERS_SIZE, 0);
		return native.K32GetProcessMemoryInfo(handle, ptr(counters), COUNTERS_SIZE)
			? Number(counters.readBigUInt64LE(16))
			: 0;
	} finally {
		native.CloseHandle(handle);
	}
}

export function listProcessMemory(): ProcessRow[] {
	if (process.platform !== "win32") throw new Error("processes.memory is for Windows; macOS reads ps");
	const native = symbols();
	const snapshot = native.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snapshot === INVALID_HANDLE) throw new Error("CreateToolhelp32Snapshot failed");
	const entry = Buffer.alloc(ENTRY_SIZE);
	const counters = Buffer.alloc(COUNTERS_SIZE);
	entry.writeUInt32LE(ENTRY_SIZE, 0);
	const rows: ProcessRow[] = [];
	try {
		for (
			let more = native.Process32FirstW(snapshot, ptr(entry));
			more;
			more = native.Process32NextW(snapshot, ptr(entry))
		) {
			const pid = entry.readUInt32LE(8);
			rows.push({ pid, ppid: entry.readUInt32LE(32), bytes: pid === 0 ? 0 : workingSet(pid, counters) });
		}
	} finally {
		native.CloseHandle(snapshot);
	}
	return rows;
}

export const methods = {
	"processes.memory": () => listProcessMemory(),
};
