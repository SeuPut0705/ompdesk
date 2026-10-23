import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeErrorReport, RuntimeErrorSource } from "../shared/ipc-types";

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 8_192;
const MAX_STACK_LENGTH = 32_768;
const MAX_URL_LENGTH = 4_096;
const MAX_DETAIL_KEYS = 24;
const MAX_DETAIL_VALUE_LENGTH = 4_096;

/** Every source, keyed by the union: a source added to `RuntimeErrorSource` without a row here fails tsc. */
const RUNTIME_ERROR_SOURCE_TABLE: Record<RuntimeErrorSource, true> = {
	"react-render": true,
	"react-uncaught": true,
	"react-recoverable": true,
	"window-error": true,
	"unhandled-rejection": true,
	"renderer-console": true,
	"renderer-load": true,
	preload: true,
	"renderer-process": true,
	"renderer-unresponsive": true,
	"application-resources": true,
	"child-process": true,
	"main-uncaught": true,
	"main-unhandled-rejection": true,
	"error-toast": true,
	"background-task": true,
	"startup-timing": true,
	"turn-resume": true,
	"tab-layout": true,
	autopilot: true,
	"app-update": true,
	"ai-memory": true,
	"disk-care": true,
	"main-thread-hang": true,
	"web-reload": true,
	"remote-tab": true,
	"session-delete": true,
	"turn-stop": true,
	"remote-link": true,
	"gpu-fallback": true,
	"launch-guard": true,
	"user-data-migration": true,
	setup: true,
	"keep-awake": true,
	remote: true,
	"memory-sync": true,
	"settle-watch": true,
	"sidecar-restart": true,
	"session-owner": true,
	"goal-time-limit": true,
	"slow-bridge-call": true,
	unknown: true,
};

/** What main writes: the source is checked by the compiler; `details` values are bounded when written. */
export type RuntimeLogReport = Omit<RuntimeErrorReport, "details"> & { details?: object };

export interface RuntimeLogContext {
	appVersion: string;
	platform: string;
	pid: number;
	windowId?: number;
	cwd?: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Untrusted input only (a renderer's IPC payload): a name outside the union becomes "unknown". */
function source(value: unknown): RuntimeErrorSource {
	return typeof value === "string" && Object.hasOwn(RUNTIME_ERROR_SOURCE_TABLE, value)
		? (value as RuntimeErrorSource)
		: "unknown";
}

function details(value: unknown): Record<string, string | number | boolean | null> | undefined {
	const input = record(value);
	if (!input) return undefined;
	const output: Record<string, string | number | boolean | null> = {};
	for (const [key, detail] of Object.entries(input).slice(0, MAX_DETAIL_KEYS)) {
		if (detail === null || typeof detail === "number" || typeof detail === "boolean") {
			output[key] = detail;
		} else {
			const text = boundedString(detail, MAX_DETAIL_VALUE_LENGTH);
			if (text !== undefined) output[key] = text;
		}
	}
	return Object.keys(output).length > 0 ? output : undefined;
}

/** Validate and bound an IPC payload before it reaches disk. */
export function normalizeRuntimeErrorReport(value: unknown): RuntimeErrorReport {
	const input = record(value);
	const message = boundedString(input?.message, MAX_MESSAGE_LENGTH) ?? "Unknown runtime error";
	return {
		source: source(input?.source),
		message,
		stack: boundedString(input?.stack, MAX_STACK_LENGTH),
		componentStack: boundedString(input?.componentStack, MAX_STACK_LENGTH),
		url: boundedString(input?.url, MAX_URL_LENGTH),
		line: finiteNumber(input?.line),
		column: finiteNumber(input?.column),
		details: details(input?.details),
	};
}

/**
 * Crash logging intentionally uses synchronous file I/O: renderer/process-gone
 * events may be the last useful callback before shutdown, so queued async writes
 * are not reliable enough here. Each write is a single bounded JSON line.
 */
export function appendRuntimeLogAtPath(filePath: string, report: RuntimeLogReport, context: RuntimeLogContext): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		try {
			if (fs.statSync(filePath).size >= MAX_LOG_BYTES) {
				const archivePath = `${filePath}.1`;
				fs.rmSync(archivePath, { force: true });
				fs.renameSync(filePath, archivePath);
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}

		const entry = {
			timestamp: new Date().toISOString(),
			...context,
			...normalizeRuntimeErrorReport(report),
		};
		fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// A crash logger must never trigger a second failure path.
	}
}

/**
 * The last `maxLines` complete lines of a log, read from its end (`maxBytes` at most), so a large log
 * is never parsed end to end. A read that starts mid-line drops that first fragment; a missing file is `[]`.
 */
export async function tailLogLines(filePath: string, maxLines: number, maxBytes = 256 * 1024): Promise<string[]> {
	try {
		const handle = await fs.promises.open(filePath, "r");
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, maxBytes);
			const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
			const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
			if (size > length) lines.shift();
			return lines.filter(Boolean).slice(-maxLines);
		} finally {
			await handle.close();
		}
	} catch {
		return [];
	}
}
