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
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { SpawnSpec } from "./plans";

export const SUPERVISOR_SPEC_ENV = "OMPDESK_SETUP_SPEC";

/** Exit code the supervisor reports after it killed the installer for a stdin close. */
export const SUPERVISOR_STOPPED_CODE = 130;

export const SUPERVISOR_SOURCE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const spec = JSON.parse(process.env.${SUPERVISOR_SPEC_ENV});
delete process.env.${SUPERVISOR_SPEC_ENV};
delete process.env.ELECTRON_RUN_AS_NODE;
const windows = process.platform === "win32";
const log = spec.log || null;
let stopping = false;
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
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		killer.on("error", () => child.kill());
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
 * Windows' isolated launch: PowerShell starts the command with `CreateProcess` and an explicit handle list
 * (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), so it inherits NUL and the log file and nothing else, no window
 * (`CREATE_NO_WINDOW`), then waits and exits with its code (127 when it could not start). A plain spawn cannot do
 * this: libuv (Node's `spawn`) creates every child with `bInheritHandles`, so it inherits every inheritable handle of
 * its parent, and Electron keeps its main process's stdio inheritable — a launcher's pipes (Playwright's, a
 * script's) reach the supervisor and through it any command it starts. A descendant that outlives the app (ai-memory's
 * service host, started by `setup` with Rust's `Command`, also `bInheritHandles`) would hold them, and the app's own
 * pipes to the supervisor, open for as long as it runs.
 */
const ISOLATED_LAUNCHER = [
	"$ErrorActionPreference = 'Stop'",
	"try {",
	"$application = $env:OMPDESK_ISOLATED_APP",
	"$commandLine = $env:OMPDESK_ISOLATED_COMMAND_LINE",
	"$log = $env:OMPDESK_ISOLATED_LOG",
	"Remove-Item -Path Env:OMPDESK_ISOLATED_APP, Env:OMPDESK_ISOLATED_COMMAND_LINE, Env:OMPDESK_ISOLATED_LOG",
	"Add-Type -TypeDefinition @'",
	"using System;",
	"using System.ComponentModel;",
	"using System.Runtime.InteropServices;",
	"using System.Text;",
	"public static class OmpdeskIsolatedLaunch {",
	"	[StructLayout(LayoutKind.Sequential)]",
	"	struct StartupInfo {",
	"		public int cb;",
	"		public IntPtr reserved, desktop, title;",
	"		public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;",
	"		public short showWindow, reserved2Size;",
	"		public IntPtr reserved2, stdInput, stdOutput, stdError;",
	"	}",
	"	[StructLayout(LayoutKind.Sequential)]",
	"	struct StartupInfoEx { public StartupInfo startupInfo; public IntPtr attributeList; }",
	"	[StructLayout(LayoutKind.Sequential)]",
	"	struct ProcessInformation { public IntPtr process, thread; public int processId, threadId; }",
	"	[StructLayout(LayoutKind.Sequential)]",
	"	struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }",
	'	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
	"	static extern IntPtr CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);",
	'	[DllImport("kernel32.dll", SetLastError = true)]',
	"	static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);",
	'	[DllImport("kernel32.dll", SetLastError = true)]',
	"	static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);",
	'	[DllImport("kernel32.dll")]',
	"	static extern void DeleteProcThreadAttributeList(IntPtr list);",
	'	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
	"	static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startupInfo, out ProcessInformation information);",
	'	[DllImport("kernel32.dll", SetLastError = true)]',
	"	static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);",
	'	[DllImport("kernel32.dll", SetLastError = true)]',
	"	static extern bool GetExitCodeProcess(IntPtr process, out uint code);",
	'	[DllImport("kernel32.dll", SetLastError = true)]',
	"	static extern bool CloseHandle(IntPtr handle);",
	"	static IntPtr Open(string name, uint access, uint disposition) {",
	"		SecurityAttributes attributes = new SecurityAttributes();",
	"		attributes.length = Marshal.SizeOf(typeof(SecurityAttributes));",
	"		attributes.inherit = 1;",
	"		// Shared for reading, writing and deleting: the supervisor reads and removes the log while a descendant holds it.",
	"		IntPtr handle = CreateFileW(name, access, 7, ref attributes, disposition, 0x80, IntPtr.Zero);",
	"		if (handle == new IntPtr(-1)) throw new Win32Exception();",
	"		return handle;",
	"	}",
	"	public static int Run(string application, string commandLine, string log) {",
	'		IntPtr input = Open("NUL", 0x80000000, 3);',
	"		IntPtr output = Open(log, 0x40000000, 2);",
	"		IntPtr size = IntPtr.Zero;",
	"		InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);",
	"		IntPtr list = Marshal.AllocHGlobal(size);",
	"		IntPtr handles = Marshal.AllocHGlobal(2 * IntPtr.Size);",
	"		bool initialized = false;",
	"		try {",
	"			if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception();",
	"			initialized = true;",
	"			Marshal.WriteIntPtr(handles, 0, input);",
	"			Marshal.WriteIntPtr(handles, IntPtr.Size, output);",
	"			// PROC_THREAD_ATTRIBUTE_HANDLE_LIST: of every inheritable handle, the child gets these two.",
	"			if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();",
	"			StartupInfoEx info = new StartupInfoEx();",
	"			info.startupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));",
	"			info.startupInfo.flags = 0x100;",
	"			info.startupInfo.stdInput = input;",
	"			info.startupInfo.stdOutput = output;",
	"			info.startupInfo.stdError = output;",
	"			info.attributeList = list;",
	"			ProcessInformation process;",
	"			// EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW",
	"			if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x08000000, IntPtr.Zero, null, ref info, out process)) throw new Win32Exception();",
	"			CloseHandle(process.thread);",
	"			WaitForSingleObject(process.process, 0xFFFFFFFF);",
	"			uint code;",
	"			GetExitCodeProcess(process.process, out code);",
	"			CloseHandle(process.process);",
	"			return unchecked((int)code);",
	"		} finally {",
	"			if (initialized) DeleteProcThreadAttributeList(list);",
	"			Marshal.FreeHGlobal(handles);",
	"			Marshal.FreeHGlobal(list);",
	"			CloseHandle(input);",
	"			CloseHandle(output);",
	"		}",
	"	}",
	"}",
	"'@",
	"$code = [OmpdeskIsolatedLaunch]::Run($application, $commandLine, $log)",
	"} catch {",
	"[Console]::Error.WriteLine($_.Exception.GetBaseException().Message)",
	"exit 127",
	"}",
	"exit $code",
].join("\n");

interface Launch {
	spec: SpawnSpec & { log?: { path: string; redirect: boolean } };
	env: NodeJS.ProcessEnv;
}

/** What the supervisor runs for an isolated `spec` (see `SpawnSpec.isolated`). */
export function isolatedLaunch(
	spec: SpawnSpec,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	log = join(tmpdir(), `ompdesk-isolated-${randomUUID()}.log`),
): Launch {
	// POSIX: the supervisor's spawn passes the child its stdio and nothing else (libuv closes every other descriptor on
	// exec), so the log file in place of the supervisor's pipes is all it takes.
	if (platform !== "win32") return { spec: { ...spec, log: { path: log, redirect: true } }, env };
	const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
	// A `.cmd` shim runs the way Node's `shell: true` runs it: `file` and `args` are already quoted for cmd.exe.
	const [application, commandLine] = spec.shell
		? [win32.join(systemRoot, "System32", "cmd.exe"), `cmd.exe /d /s /c "${[spec.file, ...spec.args].join(" ")}"`]
		: [spec.file, [spec.file, ...spec.args].map(quoteWindowsArg).join(" ")];
	return {
		spec: {
			file: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			args: ["-NoProfile", "-NonInteractive", "-Command", ISOLATED_LAUNCHER],
			shell: false,
			log: { path: log, redirect: false },
		},
		env: {
			...env,
			OMPDESK_ISOLATED_APP: application,
			OMPDESK_ISOLATED_COMMAND_LINE: commandLine,
			OMPDESK_ISOLATED_LOG: log,
		},
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
