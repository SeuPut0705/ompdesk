import { execFile, execFileSync } from "node:child_process";
import * as path from "node:path";

/** A Windows process as `win-processes.ts` lists it; `created` (FILETIME) tells a reused pid apart. */
export interface WinProcess {
	pid: number;
	ppid: number;
	threads: number;
	name: string;
	exe: string | null;
	commandLine: string | null;
	created: string;
}

/**
 * Every process, listed by `win-processes.ts` under bun through Toolhelp32 and `NtQueryInformationProcess`. WMI
 * (`Get-CimInstance Win32_Process`) answers "call cancelled" (0x80041032) while the machine is loaded, so no e2e
 * process check asks it; see docs/windows-dev.md.
 */
export function windowsProcesses(): WinProcess[] {
	const json = execFileSync("bun", [path.join(import.meta.dirname, "win-processes.ts")], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 30_000,
		windowsHide: true,
	});
	return JSON.parse(json) as WinProcess[];
}

export const describeProcess = (process: WinProcess) =>
	`${process.pid} (parent ${process.ppid}) ${process.name}: ${process.commandLine ?? process.exe ?? "?"}`;

/**
 * Processes whose command line names `root`: what a killed app left running there. Children get an open stdin pipe
 * and end when it closes (AGENTS.md), because a SIGKILL runs no quit handler.
 */
export function survivors(root: string): string[] {
	if (process.platform === "win32") {
		return windowsProcesses()
			.filter(entry => entry.commandLine?.includes(root))
			.map(entry => `${entry.pid} ppid=${entry.ppid} threads=${entry.threads} ${entry.name} ${entry.commandLine}`);
	}
	return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter(line => line.includes(root));
}

/** One process across listings: a pid alone is handed on to unrelated processes. */
export const processKey = (process: WinProcess) => `${process.pid}@${process.created}`;

/**
 * The processes of `all` that are one of `seeds` or descend from one. `seeds` may come from an earlier listing than
 * `all`: a seed that has exited is still the parent of what it left running (the child keeps its `ppid`). A child is
 * never older than its parent, and one older than a later process that holds the parent's pid belongs to that one
 * (Windows reuses pids, and a reused pid must not pull in its new owner's children).
 */
export function descendantsIn(all: WinProcess[], seeds: WinProcess[]): WinProcess[] {
	const seedKeys = new Set(seeds.map(processKey));
	const found = new Map(
		all.filter(process => seedKeys.has(processKey(process))).map(process => [processKey(process), process]),
	);
	const parents = [...seeds];
	for (let i = 0; i < parents.length; i++) {
		const parent = parents[i];
		if (!parent) continue;
		for (const process of all) {
			if (
				process.ppid === parent.pid &&
				BigInt(process.created) >= BigInt(parent.created) &&
				!all.some(
					holder =>
						holder.pid === parent.pid &&
						BigInt(holder.created) > BigInt(parent.created) &&
						BigInt(holder.created) <= BigInt(process.created),
				) &&
				!found.has(processKey(process))
			) {
				found.set(processKey(process), process);
				parents.push(process);
			}
		}
	}
	return [...found.values()];
}

/** `root` and everything below it in one listing. */
export const processTree = (all: WinProcess[], root: number): WinProcess[] =>
	descendantsIn(
		all,
		all.filter(process => process.pid === root),
	);

/** ai-memory's own per-user service (`service-host`, its `--supervise` copy and the `serve` it runs). */
export const isAiMemoryService = (process: WinProcess) =>
	/^ai-memory(\.exe)?$/i.test(process.name) && /\s(service-host|serve)(\s|$)/.test(process.commandLine ?? "");

/**
 * What the app below `launcher` started and left to wind down (never ai-memory's service, which is meant to outlive
 * it); none off Windows, where a process does not hold its folder.
 */
export function processesBelow(launcher: number): WinProcess[] {
	if (process.platform !== "win32") return [];
	return processTree(windowsProcesses(), launcher).filter(
		entry => entry.pid !== launcher && !isAiMemoryService(entry),
	);
}

/**
 * Resolves once every one of `processes` has exited; the ones still running after `timeoutMs` are killed. Each is
 * opened by pid and creation time, so a pid Windows has since handed to another process is never waited on.
 */
export function waitForProcessesToExit(processes: WinProcess[], timeoutMs: number): Promise<void> {
	const created = processes.filter(process => process.created !== "");
	if (created.length === 0) return Promise.resolve();
	const script = [
		`$want = @{ ${created.map(process => `${process.pid} = ${process.created}`).join("; ")} }`,
		"$mine = @(Get-Process -Id @($want.Keys) -ErrorAction SilentlyContinue | Where-Object { [math]::Abs($_.StartTime.ToFileTimeUtc() - $want[$_.Id]) -lt 10000 })",
		`if ($mine.Count -gt 0) { $mine | Wait-Process -Timeout ${Math.ceil(timeoutMs / 1000)} -ErrorAction SilentlyContinue; $mine | Where-Object { -not $_.HasExited } | Stop-Process -Force -ErrorAction SilentlyContinue }`,
	].join("; ");
	const done = Promise.withResolvers<void>();
	execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, () =>
		done.resolve(),
	);
	return done.promise;
}
