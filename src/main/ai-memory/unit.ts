/**
 * ai-memory's per-user service as the operating system sees it: the launchd LaunchAgent (macOS) or the HKCU `Run` logon
 * entry (Windows) that `ai-memory setup` installs. ai-memory has no command that stops or removes only its service
 * (`uninstall` also removes every agent's wiring), so turning memory off asks the OS, and only about a unit that runs
 * the binary OMPdesk staged (`<tools>/ai-memory/…`): that is the ownership check. A unit that runs someone else's
 * ai-memory (their own install, Homebrew) is never touched.
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { withinPath } from "./terminal";

export const LAUNCHD_LABEL = "com.github.akitaonrails.ai-memory";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "ai-memory";

export interface ServiceUnit {
	/** ai-memory's unit exists for this user. */
	installed: boolean;
	/** ...and runs a binary OMPdesk staged. */
	ours: boolean;
}

export interface ServiceControl {
	inspect(): Promise<ServiceUnit>;
	/** Stop the server and remove the unit (it comes back with the next `setup`). */
	remove(): Promise<void>;
}

export interface ExecResult {
	code: number;
	stdout: string;
}
export type ExecFile = (file: string, args: string[]) => Promise<ExecResult>;

/** `execFile` without a shell or a console window; a failure is a result, never a throw. */
export const runFile: ExecFile = (file, args) => {
	const { promise, resolve } = Promise.withResolvers<ExecResult>();
	execFile(file, args, { windowsHide: true, timeout: 15_000, encoding: "utf8" }, (error, stdout) => {
		const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
		resolve({ code, stdout: String(stdout ?? "") });
	});
	return promise;
};

export interface LaunchdOptions {
	home: string;
	/** Paths whose binaries OMPdesk runs (`<tools>/ai-memory`, the binary in use): a unit running one is OMPdesk's. */
	owned: () => string[];
	uid: number;
	exec?: ExecFile;
}

export function launchdControl(options: LaunchdOptions): ServiceControl {
	const exec = options.exec ?? runFile;
	const plist = join(options.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
	return {
		async inspect() {
			const text = await readFile(plist, "utf8").catch(() => null);
			if (text === null) return { installed: false, ours: false };
			return { installed: true, ours: options.owned().some(path => text.includes(path)) };
		},
		async remove() {
			await exec("launchctl", ["bootout", `gui/${options.uid}/${LAUNCHD_LABEL}`]);
			await rm(plist, { force: true });
		},
	};
}

export interface LogonOptions {
	/** As `LaunchdOptions.owned`. */
	owned: () => string[];
	/** ai-memory's data directory (`service-host.json` names the supervisor and server it started). */
	dataDir: () => string | null;
	exec?: ExecFile;
}

/** The entry's command line from `reg query` (`    ai-memory    REG_SZ    "C:\…\ai-memory.exe" service-host`). */
export function runEntryCommand(output: string): string | null {
	const line = output.split(/\r?\n/).find(row => /^\s*ai-memory\s+REG_(EXPAND_)?SZ\s/i.test(row));
	return line?.replace(/^\s*ai-memory\s+REG_(?:EXPAND_)?SZ\s+/i, "").trim() ?? null;
}

export function logonControl(options: LogonOptions): ServiceControl {
	const exec = options.exec ?? runFile;
	return {
		async inspect() {
			const result = await exec("reg", ["query", RUN_KEY, "/v", RUN_VALUE]);
			const command = result.code === 0 ? runEntryCommand(result.stdout) : null;
			if (command === null) return { installed: false, ours: false };
			return { installed: true, ours: options.owned().some(path => withinPath(command.replace(/^"/, ""), path)) };
		},
		async remove() {
			await exec("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
			// The supervisor (`service-host`) restarts the server, so it goes first; both are named by the file it keeps.
			const dir = options.dataDir();
			const host = dir ? await readFile(join(dir, "service-host.json"), "utf8").catch(() => null) : null;
			if (host === null) return;
			let pids: unknown[] = [];
			try {
				const parsed: unknown = JSON.parse(host);
				if (parsed !== null && typeof parsed === "object") {
					pids = [Reflect.get(parsed, "supervisor_pid"), Reflect.get(parsed, "server_pid")];
				}
			} catch {
				return;
			}
			for (const pid of pids) {
				if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
					await exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
				}
			}
		},
	};
}

/**
 * Test seam (`OMP_GUI_AI_MEMORY_UNIT_PIDFILE`): the fake ai-memory of the e2e specs keeps its "service" as a detached
 * process whose pid is in a file. That file is the unit; the fake is OMPdesk's own by construction.
 */
export function pidFileControl(file: string): ServiceControl {
	return {
		async inspect() {
			const installed = (await readFile(file, "utf8").catch(() => "")).trim() !== "";
			return { installed, ours: installed };
		},
		async remove() {
			const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
			if (Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(pid);
				} catch {
					// already gone
				}
			}
			await rm(file, { force: true });
		},
	};
}
