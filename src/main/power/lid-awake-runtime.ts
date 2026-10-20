/** The lid policy (lid-awake.ts) over this platform's real tools; null where no backend exists. */

import { execFile, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { LidAwake, type LidAwakeLog, type LidBackend } from "./lid-awake";
import { MacLidBackend } from "./lid-backend-mac";
import { WindowsLidBackend } from "./lid-backend-windows";

const run = promisify(execFile);

function backendFor(userData: string): LidBackend | null {
	if (process.platform === "darwin") {
		return new MacLidBackend({
			caffeinate: () => {
				const child = spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" });
				child.on("error", () => {});
				child.unref();
				return { stop: () => child.kill() };
			},
			batteryReport: async () => (await run("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8" })).stdout,
		});
	}
	if (process.platform === "win32") {
		const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
		const powercfg = join(system32, "powercfg.exe");
		return new WindowsLidBackend({
			powercfg: {
				run: async args => (await run(powercfg, [...args], { encoding: "utf8", windowsHide: true })).stdout,
				runSync: args => execFileSync(powercfg, [...args], { encoding: "utf8", windowsHide: true, timeout: 5000 }),
			},
			hasBattery: async () => {
				const { stdout } = await run(
					join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"(Get-CimInstance -ClassName Win32_Battery | Measure-Object).Count",
					],
					{ encoding: "utf8", windowsHide: true, timeout: 30_000 },
				);
				return Number.parseInt(stdout.trim(), 10) > 0;
			},
			markerFile: join(userData, "lid-awake.json"),
			now: Date.now,
		});
	}
	return null;
}

export function createLidAwake(options: { userData: string; onAc: boolean; log: LidAwakeLog }): LidAwake | null {
	const backend = backendFor(options.userData);
	return backend ? new LidAwake({ backend, onAc: options.onAc, log: options.log }) : null;
}
