/**
 * Catches a Playwright worker (or any node/bun process whose command line holds `--match`) dying of a fast fail
 * (`0xC0000409`, "worker process exited unexpectedly (code=3221226505)") on Windows, where such a death writes no
 * Application Error event and no dump unless WER LocalDumps is set (admin only). It attaches as a debugger, so
 * the process is frozen at the exception: it logs the exception code, the fast-fail code (parameter 0: 2 is a
 * stack-cookie failure, 7 `abort()`), the faulting module and a scan of the stack for return addresses, then writes
 * a full-memory minidump. Offsets `node.exe+0x…` become names with dbghelp and `node_pdb.zip` from
 * nodejs.org/dist/v<version>/win-x64 (docs/windows-dev.md).
 *
 *   bun scripts/win-crash-watch.ts [--match <text>] [--out <dir>] [--minutes <n>]
 *
 * Start it before the run; it attaches to a new worker within 2 s of its start and detaches from the workers that
 * are still alive when it ends, without killing them.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { WinProcess } from "../e2e/process-tree";

const { values } = parseArgs({
	options: {
		match: { type: "string", default: "playwright\\lib\\worker" },
		out: { type: "string", default: path.join(os.tmpdir(), "omp-crash-watch") },
		minutes: { type: "string", default: "60" },
	},
});
mkdirSync(values.out, { recursive: true });
const log = (line: string) => {
	const text = `${new Date().toISOString()} ${line}\n`;
	process.stdout.write(text);
	appendFileSync(path.join(values.out, "watch.log"), text);
};

const handle = FFIType.u64;
const { symbols: kernel } = dlopen("kernel32.dll", {
	DebugActiveProcess: { args: [FFIType.u32], returns: FFIType.i32 },
	DebugActiveProcessStop: { args: [FFIType.u32], returns: FFIType.i32 },
	DebugSetProcessKillOnExit: { args: [FFIType.i32], returns: FFIType.i32 },
	WaitForDebugEvent: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	ContinueDebugEvent: { args: [FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
	OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: handle },
	OpenThread: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: handle },
	CloseHandle: { args: [handle], returns: FFIType.i32 },
	GetThreadContext: { args: [handle, FFIType.ptr], returns: FFIType.i32 },
	ReadProcessMemory: { args: [handle, handle, FFIType.ptr, handle, FFIType.ptr], returns: FFIType.i32 },
	CreateFileW: {
		args: [FFIType.ptr, FFIType.u32, FFIType.u32, handle, FFIType.u32, FFIType.u32, handle],
		returns: handle,
	},
	CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: handle },
	Module32FirstW: { args: [handle, FFIType.ptr], returns: FFIType.i32 },
	Module32NextW: { args: [handle, FFIType.ptr], returns: FFIType.i32 },
	GetLastError: { args: [], returns: FFIType.u32 },
});
const { symbols: dbghelp } = dlopen("dbghelp.dll", {
	MiniDumpWriteDump: {
		args: [handle, FFIType.u32, handle, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
		returns: FFIType.i32,
	},
});

const EXCEPTION_DEBUG_EVENT = 1;
const CREATE_PROCESS_DEBUG_EVENT = 3;
const EXIT_PROCESS_DEBUG_EVENT = 5;
const LOAD_DLL_DEBUG_EVENT = 6;
const STATUS_STACK_BUFFER_OVERRUN = 0xc0000409;
const DBG_CONTINUE = 0x00010002;
const DBG_EXCEPTION_NOT_HANDLED = 0x80010001;
const THREAD_AND_PROCESS_ALL_ACCESS = 0x1fffff;
const CONTEXT_CONTROL_INTEGER_FLOAT = 0x10000b;
const MINIDUMP_WITH_FULL_MEMORY_AND_THREAD_INFO = 0x2 | 0x1000;

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
const hex = (value: bigint | number) => `0x${value.toString(16)}`;

interface Module {
	name: string;
	base: bigint;
	size: bigint;
}

/** MODULEENTRY32W (x64, 1080 bytes): modBaseAddr 24, modBaseSize 32, szModule 48. */
function modulesOf(pid: number): Module[] {
	const snapshot = kernel.CreateToolhelp32Snapshot(0x8 | 0x10, pid);
	const entry = Buffer.alloc(1080);
	entry.writeUInt32LE(1080, 0);
	const modules: Module[] = [];
	for (
		let more = kernel.Module32FirstW(snapshot, ptr(entry));
		more;
		more = kernel.Module32NextW(snapshot, ptr(entry))
	) {
		modules.push({
			name: entry.toString("utf16le", 48, 48 + 512).split("\0")[0] ?? "",
			base: entry.readBigUInt64LE(24),
			size: BigInt(entry.readUInt32LE(32)),
		});
	}
	kernel.CloseHandle(snapshot);
	return modules;
}

/** DEBUG_EVENT (x64): code 0, pid 4, tid 8, union 16; EXCEPTION_RECORD: code 0, address 16, count 24, parameters 32. */
function reportFastFail(pid: number, tid: number, event: Buffer) {
	const address = event.readBigUInt64LE(16 + 16);
	const count = Math.min(event.readUInt32LE(16 + 24), 15);
	const parameters = Array.from({ length: count }, (_, i) => hex(event.readBigUInt64LE(16 + 32 + i * 8)));
	log(
		`pid ${pid} thread ${tid}: exception ${hex(STATUS_STACK_BUFFER_OVERRUN)} at ${hex(address)}, parameters ${parameters.join(", ")}`,
	);
	const process_ = kernel.OpenProcess(THREAD_AND_PROCESS_ALL_ACCESS, 0, pid);
	const thread = kernel.OpenThread(THREAD_AND_PROCESS_ALL_ACCESS, 0, tid);
	const modules = modulesOf(pid);
	const where = (value: bigint) => {
		const module = modules.find(entry => value >= entry.base && value < entry.base + entry.size);
		return module ? `${module.name}+${hex(value - module.base)}` : null;
	};
	log(`fault address: ${where(address) ?? "in no module"}`);
	// A CONTEXT is 16-byte aligned: Rsp 0x98, Rip 0xF8, ContextFlags 0x30.
	const raw = Buffer.alloc(1232 + 16);
	const start = (16 - (Number(ptr(raw)) % 16)) % 16;
	const context = raw.subarray(start, start + 1232);
	context.writeUInt32LE(CONTEXT_CONTROL_INTEGER_FLOAT, 0x30);
	if (kernel.GetThreadContext(thread, ptr(context))) {
		const rip = context.readBigUInt64LE(0xf8);
		const rsp = context.readBigUInt64LE(0x98);
		log(`rip ${where(rip) ?? hex(rip)}, rsp ${hex(rsp)}`);
		const stack = Buffer.alloc(16384);
		const read = Buffer.alloc(8);
		kernel.ReadProcessMemory(process_, rsp, ptr(stack), BigInt(stack.length), ptr(read));
		const frames: string[] = [];
		for (let offset = 0; offset + 8 <= Number(read.readBigUInt64LE(0)) && frames.length < 60; offset += 8) {
			const frame = where(stack.readBigUInt64LE(offset));
			if (frame) frames.push(`  [rsp+${hex(offset)}] ${frame}`);
		}
		log(`stack scan (return address candidates, innermost first):\n${frames.join("\n")}`);
	}
	const file = path.join(values.out, `crash-${pid}-${Date.now()}.dmp`);
	const dump = kernel.CreateFileW(ptr(wide(file)), 0x40000000, 0, 0n, 2, 0x80, 0n);
	const written = dbghelp.MiniDumpWriteDump(
		process_,
		pid,
		dump,
		MINIDUMP_WITH_FULL_MEMORY_AND_THREAD_INFO,
		null,
		null,
		null,
	);
	kernel.CloseHandle(dump);
	log(`dump ${file}: ${written ? "written" : `failed, error ${kernel.GetLastError()}`}`);
	kernel.CloseHandle(thread);
	kernel.CloseHandle(process_);
}

const helper = path.join(import.meta.dirname, "..", "e2e", "win-processes.ts");
const listing = (): WinProcess[] => JSON.parse(execFileSync("bun", [helper], { encoding: "utf8", maxBuffer: 1 << 28 }));

kernel.DebugSetProcessKillOnExit(0);
const attached = new Set<number>();
const seen = new Set<number>();
const event = Buffer.alloc(512);
const stopAt = Date.now() + Number(values.minutes) * 60_000;
let nextScan = 0;
log(`watching processes whose command line holds "${values.match}"`);
while (Date.now() < stopAt) {
	if (Date.now() >= nextScan) {
		nextScan = Date.now() + 2000;
		for (const entry of listing()) {
			const mine = entry.pid === process.pid;
			if (
				mine ||
				seen.has(entry.pid) ||
				!/^(node|bun)(\.exe)?$/i.test(entry.name) ||
				!entry.commandLine?.includes(values.match)
			)
				continue;
			seen.add(entry.pid);
			if (kernel.DebugActiveProcess(entry.pid)) {
				attached.add(entry.pid);
				log(`attached to ${entry.pid}`);
			} else log(`cannot attach to ${entry.pid}: error ${kernel.GetLastError()}`);
		}
	}
	if (!kernel.WaitForDebugEvent(ptr(event), 500)) continue;
	const kind = event.readUInt32LE(0);
	const pid = event.readUInt32LE(4);
	const tid = event.readUInt32LE(8);
	let status = DBG_CONTINUE;
	if (kind === EXCEPTION_DEBUG_EVENT) {
		status = DBG_EXCEPTION_NOT_HANDLED;
		if (event.readUInt32LE(16) === STATUS_STACK_BUFFER_OVERRUN) reportFastFail(pid, tid, event);
	} else if (kind === CREATE_PROCESS_DEBUG_EVENT || kind === LOAD_DLL_DEBUG_EVENT) {
		kernel.CloseHandle(event.readBigUInt64LE(16));
	} else if (kind === EXIT_PROCESS_DEBUG_EVENT) {
		log(`process ${pid} exited with code ${hex(event.readUInt32LE(16))}`);
		attached.delete(pid);
	}
	kernel.ContinueDebugEvent(pid, tid, status);
}
for (const pid of attached) kernel.DebugActiveProcessStop(pid);
