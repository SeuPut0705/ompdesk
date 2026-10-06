import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeErrorReport, RuntimeErrorSource } from "../shared/ipc-types";

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 8_192;
const MAX_STACK_LENGTH = 32_768;
const MAX_URL_LENGTH = 4_096;
const MAX_DETAIL_KEYS = 24;
const MAX_DETAIL_VALUE_LENGTH = 4_096;

const RUNTIME_ERROR_SOURCES = new Set<RuntimeErrorSource>([
	"react-render",
	"react-uncaught",
	"react-recoverable",
	"window-error",
	"unhandled-rejection",
	"renderer-console",
	"renderer-load",
	"preload",
	"renderer-process",
	"renderer-unresponsive",
	"application-resources",
	"child-process",
	"main-uncaught",
	"main-unhandled-rejection",
	"unknown",
]);

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

function source(value: unknown): RuntimeErrorSource {
	return typeof value === "string" && RUNTIME_ERROR_SOURCES.has(value as RuntimeErrorSource)
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
export function appendRuntimeLogAtPath(filePath: string, report: unknown, context: RuntimeLogContext): void {
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
