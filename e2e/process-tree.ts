import { execFile, execFileSync } from "node:child_process";

/** A Windows process as Win32_Process lists it; `created` (FILETIME) tells a reused pid apart. */
export interface WinProcess {
	pid: number;
	ppid: number;
	name: string;
	exe: string | null;
	commandLine: string | null;
	created: string;
}

export function windowsProcesses(): WinProcess[] {
	const script = [
		"Get-CimInstance Win32_Process | ForEach-Object {",
		"[pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath;",
		"commandLine = $_.CommandLine; created = $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { '' }) }",
		"} | ConvertTo-Json -Compress",
	].join(" ");
	const json = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 30_000,
		windowsHide: true,
	});
	return JSON.parse(json) as WinProcess[];
}

export const describeProcess = (process: WinProcess) =>
	`${process.pid} (parent ${process.ppid}) ${process.name}: ${process.commandLine ?? process.exe ?? "?"}`;

/** `root` and everything below it; a child is never older than its parent (Windows reuses pids). */
export function processTree(all: WinProcess[], root: number): WinProcess[] {
	const tree = all.filter(process => process.pid === root);
	for (let i = 0; i < tree.length; i++) {
		const parent = tree[i];
		if (!parent) continue;
		for (const process of all) {
			if (
				process.ppid === parent.pid &&
				Number(process.created) >= Number(parent.created) &&
				!tree.includes(process)
			) {
				tree.push(process);
			}
		}
	}
	return tree;
}

/** ai-memory's own per-user service (`service-host`, its `--supervise` copy and the `serve` it runs). */
export const isAiMemoryService = (process: WinProcess) =>
	/^ai-memory(\.exe)?$/i.test(process.name) && /\s(service-host|serve)(\s|$)/.test(process.commandLine ?? "");

/**
 * What the app below `launcher` started and left to wind down (never ai-memory's service, which is meant to outlive
 * it); none off Windows, where a process does not hold its folder. WMI answers "call cancelled" when it is loaded
 * (measured here under repeated listings), so a listing that fails is none: the exit then waits for the launcher
 * only, which is all it did before.
 */
export function processesBelow(launcher: number): WinProcess[] {
	if (process.platform !== "win32") return [];
	try {
		return processTree(windowsProcesses(), launcher).filter(
			entry => entry.pid !== launcher && !isAiMemoryService(entry),
		);
	} catch (error) {
		console.warn(
			`exitApp: the app's processes could not be listed, so none is waited for: ${String(error).slice(0, 160)}`,
		);
		return [];
	}
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
