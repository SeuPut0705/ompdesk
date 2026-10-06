import * as path from "node:path";
import { app } from "electron";
import { appendRuntimeLogAtPath } from "./runtime-log-core";

export function runtimeLogPath(): string {
	return path.join(app.getPath("userData"), "logs", "gui-runtime.jsonl");
}

export function writeRuntimeLog(report: unknown, context: { windowId?: number; cwd?: string } = {}): void {
	appendRuntimeLogAtPath(runtimeLogPath(), report, {
		appVersion: app.getVersion(),
		platform: process.platform,
		pid: process.pid,
		...context,
	});
}
