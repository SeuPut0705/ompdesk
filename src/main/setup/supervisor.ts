/**
 * Installers (curl | bash, PowerShell, winget, brew) neither watch stdin nor
 * die with the app. Each one therefore runs under a tiny supervisor: this
 * script, run by the app's own binary as Node (`ELECTRON_RUN_AS_NODE=1`; the
 * plain `node`/`bun` binary in tests and scripts). It starts the installer in
 * its own process group, passes its output through, and kills the installer's
 * whole tree when its stdin closes — a cancel (main ends stdin), an app quit,
 * or a crash of the app that skips every quit handler.
 *
 * The installer command comes from `OMPDESK_SETUP_SPEC` (`{file, args, shell,
 * inputFile?, log?}` JSON), never from argv, so runtimes that parse argv differently
 * agree. `inputFile` becomes the child's stdin (else it gets none). `log` is the
 * output file of an isolated command (`SpawnSpec.isolated`, see `isolatedLaunch`):
 * with `redirect` the supervisor hands it to the child as stdout/stderr; either
 * way its text becomes the supervisor's own output once the child exited.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { findOnPath } from "../spawn";
import { bunInstallDir } from "./paths";
import type { SpawnSpec } from "./plans";

export const SUPERVISOR_SPEC_ENV = "OMPDESK_SETUP_SPEC";

/** Exit code the supervisor reports after it killed the installer for a stdin close. */
export const SUPERVISOR_STOPPED_CODE = 130;

/**
 * Ends a process and everything below it without WMI (Toolhelp's process snapshot, which names each process's parent),
 * for a Windows whose WMI answers "call cancelled" when loaded: `taskkill /T` then kills nothing. `ROOT` is the pid.
 */
const TREE_KILL_SCRIPT = [
	'Add-Type -TypeDefinition @"',
	"using System;",
	"using System.Collections.Generic;",
	"using System.Runtime.InteropServices;",
	"public static class Tree {",
	"  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
	"  struct Entry { public uint size, usage, pid; public IntPtr heap; public uint module, threads, ppid; public int priority; public uint flags;",
	"    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }",
	'  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);',
	'  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);',
	'  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);',
	'  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);',
	'  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);',
	'  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);',
	"  public static void Kill(uint root) {",
	"    var parents = new Dictionary<uint, List<uint>>();",
	"    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);",
	"    var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(entry);",
	"    for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {",
	"      if (!parents.ContainsKey(entry.ppid)) parents[entry.ppid] = new List<uint>();",
	"      parents[entry.ppid].Add(entry.pid);",
	"    }",
	"    CloseHandle(snapshot);",
	"    var tree = new List<uint> { root };",
	"    for (int i = 0; i < tree.Count; i++) if (parents.ContainsKey(tree[i])) foreach (uint child in parents[tree[i]]) if (!tree.Contains(child)) tree.Add(child);",
	"    foreach (uint pid in tree) { IntPtr handle = OpenProcess(1, false, pid); if (handle != IntPtr.Zero) { TerminateProcess(handle, 1); CloseHandle(handle); } }",
	"  }",
	"}",
	'"@',
	"[Tree]::Kill(ROOT)",
].join("\n");

export const SUPERVISOR_SOURCE = `
const { spawn } = require("node:child_process");
const TREE_KILL_SCRIPT = ${JSON.stringify(TREE_KILL_SCRIPT)};
const fs = require("node:fs");
const spec = JSON.parse(process.env.${SUPERVISOR_SPEC_ENV});
delete process.env.${SUPERVISOR_SPEC_ENV};
delete process.env.ELECTRON_RUN_AS_NODE;
const windows = process.platform === "win32";
const log = spec.log || null;
let stopping = false;
let exited = false;
let child;
function dropLog() {
	if (log) try { fs.unlinkSync(log.path); } catch {}
}
try {
	const output = log && log.redirect ? fs.openSync(log.path, "w") : "inherit";
	child = spawn(spec.file, spec.args, {
		stdio: [spec.inputFile ? fs.openSync(spec.inputFile, "r") : "ignore", output, output],
		detached: !windows,
		shell: spec.shell === true,
		windowsHide: true,
	});
} catch (error) {
	dropLog();
	process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
	process.exit(127);
}
function killTree(signal) {
	if (!child.pid) return;
	if (windows) {
		if (exited) return;
		// taskkill walks the tree through WMI and, with WMI down, exits 1 and kills nothing: the shim dies at best and
		// the omp under it runs on, holding its folder. A failed taskkill falls back to a walk that needs no WMI.
		const fallBack = () => {
			if (exited) return;
			const script = TREE_KILL_SCRIPT.replace("ROOT", String(child.pid));
			const encoded = Buffer.from(script, "utf16le").toString("base64");
			const walker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true });
			walker.on("error", () => child.kill());
			walker.on("exit", code => { if (code !== 0) child.kill(); });
		};
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		killer.on("error", fallBack);
		killer.on("exit", code => { if (code !== 0) fallBack(); });
		return;
	}
	try { process.kill(-child.pid, signal); } catch {}
}
function stop() {
	if (stopping) return;
	stopping = true;
	killTree("SIGTERM");
	setTimeout(() => killTree("SIGKILL"), 2000).unref();
}
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.on("error", stop);
process.stdin.resume();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", error => {
	dropLog();
	process.stderr.write(error.message + "\\n");
	process.exit(127);
});
child.on("exit", (code, signal) => {
	exited = true;
	// A descendant that outlived the installer goes with its group.
	if (!windows) killTree("SIGKILL");
	const status = stopping ? ${SUPERVISOR_STOPPED_CODE} : code === null ? 1 : code;
	let text = "";
	if (log) try { text = fs.readFileSync(log.path, "utf8"); } catch {}
	dropLog();
	if (text) process.stdout.write(text, () => process.exit(status));
	else process.exit(status);
});
`;

/**
 * Quote one argument for a Windows command line so the C runtime's parser (every `.exe` OMPdesk starts) reads it back
 * unchanged: libuv's rule for `child_process.spawn`.
 */
export function quoteWindowsArg(arg: string): string {
	if (arg === "") return '""';
	if (!/[\s"]/.test(arg)) return arg;
	let quoted = '"';
	let backslashes = 0;
	for (const char of arg) {
		if (char === "\\") {
			backslashes++;
			continue;
		}
		quoted += char === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${char}`;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * Windows' isolated launch, run by Bun (`bun -e`, `bun:ffi` calling kernel32; no compiler, no PowerShell): it starts
 * the command with `CreateProcessW` and an explicit handle list (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), so it inherits
 * NUL and the log file and nothing else, with no window (`CREATE_NO_WINDOW`) and the environment it was given, then
 * waits and exits with its code (127 when it could not start). A plain spawn cannot do this: libuv (Node's `spawn`)
 * creates every child with `bInheritHandles`, so it inherits every inheritable handle of its parent, and Electron keeps
 * its main process's stdio inheritable — a launcher's pipes (Playwright's, a script's) reach the supervisor as stray
 * handles no API names, and through it any command it starts. A descendant that outlives the app (ai-memory's service
 * host, started by `setup` with Rust's `Command`, also `bInheritHandles`) would hold them, and the app's own pipes to
 * the supervisor, open for as long as it runs. The command comes from `OMPDESK_ISOLATED` (`{application,
 * commandLine, log}` JSON), which the command's own environment leaves out.
 */
const ISOLATED_LAUNCHER = `
const { writeSync } = require("node:fs");
const { dlopen, FFIType: T, ptr } = require("bun:ffi");
const spec = JSON.parse(process.env.OMPDESK_ISOLATED);
const kernel32 = dlopen("kernel32.dll", {
	CreateFileW: { args: [T.ptr, T.u32, T.u32, T.ptr, T.u32, T.u32, T.ptr], returns: T.i64_fast },
	InitializeProcThreadAttributeList: { args: [T.ptr, T.u32, T.u32, T.ptr], returns: T.i32 },
	UpdateProcThreadAttribute: { args: [T.ptr, T.u32, T.u64, T.ptr, T.u64, T.ptr, T.ptr], returns: T.i32 },
	DeleteProcThreadAttributeList: { args: [T.ptr], returns: T.void },
	CreateProcessW: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.i32, T.u32, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
	WaitForSingleObject: { args: [T.i64, T.u32], returns: T.u32 },
	GetExitCodeProcess: { args: [T.i64, T.ptr], returns: T.i32 },
	CloseHandle: { args: [T.i64], returns: T.i32 },
	GetLastError: { args: [], returns: T.u32 },
}).symbols;
function fail(what) {
	writeSync(2, what + " failed (Windows error " + kernel32.GetLastError() + ")\\n");
	process.exit(127);
}
const wide = text => Buffer.from(text + "\\0", "utf16le");
// SECURITY_ATTRIBUTES { nLength, lpSecurityDescriptor, bInheritHandle = TRUE }
const inheritable = Buffer.alloc(24);
inheritable.writeUInt32LE(24, 0);
inheritable.writeUInt32LE(1, 16);
function open(name, access, disposition) {
	// Shared for reading, writing and deleting: the supervisor reads and removes the log while a descendant holds it.
	const path = wide(name);
	const handle = kernel32.CreateFileW(ptr(path), access, 7, ptr(inheritable), disposition, 0x80, null);
	if (handle === -1 || handle === -1n) fail("opening " + name);
	return BigInt(handle);
}
const input = open("NUL", 0x80000000, 3);
const output = open(spec.log, 0x40000000, 2);
const size = Buffer.alloc(8);
kernel32.InitializeProcThreadAttributeList(null, 1, 0, ptr(size));
const list = Buffer.alloc(Number(size.readBigUInt64LE(0)));
if (!kernel32.InitializeProcThreadAttributeList(ptr(list), 1, 0, ptr(size))) fail("InitializeProcThreadAttributeList");
const handles = Buffer.alloc(16);
handles.writeBigInt64LE(input, 0);
handles.writeBigInt64LE(output, 8);
// PROC_THREAD_ATTRIBUTE_HANDLE_LIST: of every inheritable handle, the command gets these two.
if (!kernel32.UpdateProcThreadAttribute(ptr(list), 0, 0x20002, ptr(handles), 16, null, null)) fail("UpdateProcThreadAttribute");
// STARTUPINFOEXW: cb, dwFlags = STARTF_USESTDHANDLES, hStdInput, hStdOutput, hStdError, lpAttributeList.
const startup = Buffer.alloc(112);
startup.writeUInt32LE(112, 0);
startup.writeUInt32LE(0x100, 60);
startup.writeBigInt64LE(input, 80);
startup.writeBigInt64LE(output, 88);
startup.writeBigInt64LE(output, 96);
startup.writeBigUInt64LE(BigInt(ptr(list)), 104);
// The command's environment: this one without the launch spec, as a sorted UTF-16 block.
const key = name => name.toUpperCase();
const environment = Buffer.from(
	Object.entries(process.env)
		.filter(([name, value]) => name !== "OMPDESK_ISOLATED" && value !== undefined)
		.sort(([a], [b]) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
		.map(([name, value]) => name + "=" + value + "\\0")
		.join("") + "\\0",
	"utf16le",
);
const application = wide(spec.application);
const commandLine = wide(spec.commandLine);
const information = Buffer.alloc(24);
// EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
const flags = 0x00080000 | 0x08000000 | 0x400;
if (!kernel32.CreateProcessW(ptr(application), ptr(commandLine), null, null, 1, flags, ptr(environment), null, ptr(startup), ptr(information))) {
	fail("starting " + spec.application);
}
kernel32.DeleteProcThreadAttributeList(ptr(list));
kernel32.CloseHandle(input);
kernel32.CloseHandle(output);
const child = information.readBigInt64LE(0);
kernel32.CloseHandle(information.readBigInt64LE(8));
kernel32.WaitForSingleObject(child, 0xffffffff);
const code = Buffer.alloc(4);
kernel32.GetExitCodeProcess(child, ptr(code));
kernel32.CloseHandle(child);
process.exit(code.readInt32LE(0));
`;

interface Launch {
	spec: SpawnSpec & { log?: { path: string; redirect: boolean } };
	env: NodeJS.ProcessEnv;
}

interface LaunchOptions {
	platform?: NodeJS.Platform;
	log?: string;
	/** Bun, which runs Windows' launcher; looked up on PATH, then in Bun's own install dir, when not given. */
	bun?: string | null;
}

/** Bun on `env`'s PATH (whatever its case on Windows), else in `BUN_INSTALL` or `%USERPROFILE%\.bun`. */
export function findBun(env: NodeJS.ProcessEnv): string | null {
	const pathEnv = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
	const installed = win32.join(bunInstallDir(env, env.USERPROFILE || homedir()), "bin", "bun.exe");
	return findOnPath(["bun.exe"], pathEnv, "win32", [installed]);
}

/** What the supervisor runs for an isolated `spec` (see `SpawnSpec.isolated`). */
export function isolatedLaunch(spec: SpawnSpec, env: NodeJS.ProcessEnv, options: LaunchOptions = {}): Launch {
	const log = options.log ?? join(tmpdir(), `ompdesk-isolated-${randomUUID()}.log`);
	// POSIX: the supervisor's spawn passes the child its stdio and nothing else (libuv closes every other descriptor on
	// exec), so the log file in place of the supervisor's pipes is all it takes.
	if ((options.platform ?? process.platform) !== "win32") {
		return { spec: { ...spec, log: { path: log, redirect: true } }, env };
	}
	const bun = options.bun === undefined ? findBun(env) : options.bun;
	if (!bun)
		throw new Error("Bun was not found: on Windows OMPdesk starts this command through it (setup installs Bun)");
	const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
	// A `.cmd` shim runs the way Node's `shell: true` runs it: `file` and `args` are already quoted for cmd.exe.
	const [application, commandLine] = spec.shell
		? [win32.join(systemRoot, "System32", "cmd.exe"), `cmd.exe /d /s /c "${[spec.file, ...spec.args].join(" ")}"`]
		: [spec.file, [spec.file, ...spec.args].map(quoteWindowsArg).join(" ")];
	return {
		spec: { file: bun, args: ["-e", ISOLATED_LAUNCHER], shell: false, log: { path: log, redirect: false } },
		env: { ...env, OMPDESK_ISOLATED: JSON.stringify({ application, commandLine, log }) },
	};
}

/** Start `spec` under the supervisor with `env` (in `cwd`, else main's); stdin stays open until a cancel. */
export function spawnSupervised(spec: SpawnSpec, env: NodeJS.ProcessEnv, cwd?: string): ChildProcess {
	const launch = spec.isolated ? isolatedLaunch(spec, env) : { spec, env };
	return spawn(process.execPath, ["-e", SUPERVISOR_SOURCE], {
		env: { ...launch.env, ELECTRON_RUN_AS_NODE: "1", [SUPERVISOR_SPEC_ENV]: JSON.stringify(launch.spec) },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		...(cwd ? { cwd } : {}),
	});
}
