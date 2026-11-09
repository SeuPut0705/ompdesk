/**
 * The last lines one omp process wrote to its own log, for a start that stays silent on stderr. Stock writes one log
 * per process, `<logs>/omp.<local YYYY-MM-DD>.<pid>.log` (pi-utils `getLogPath`, named by the local day like its
 * rotating sink), as JSON lines. An omp whose stderr says nothing while it starts still logs there: on 9 Nov 2026 every
 * stalled omp of a MacBook had empty stderr and 4-5 log lines.
 *
 * The pid is the spawned process's; on Windows a `.cmd` launcher's shell is not omp, so its log is not found there.
 */
import { open } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./agent-paths";
import { localDay } from "./remote/peer-quota";

/** Lines of the log kept: enough for the startup lines before a stall, short enough for the banner. */
const TAIL_LINES = 8;
/** Bytes read from the end of the log; a starting omp's log is a few KB. */
const TAIL_BYTES = 16_384;
/** One shown line at most, past which it is cut with an ellipsis. */
const LINE_CHARS = 240;

/** Stock's log entry fields that every line has and the compact form shows in place. */
const SHOWN_IN_PLACE: Record<string, true> = { timestamp: true, level: true, pid: true, message: true };

/** `HH:MM:SS level message key=value …` for a stock JSON log line; any other line as it is. */
function compact(line: string): string {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return line;
	}
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return line;
	const fields = entry as Record<string, unknown>;
	const time = typeof fields.timestamp === "string" ? fields.timestamp.slice(11, 19) : "";
	const parts = [time, String(fields.level ?? ""), String(fields.message ?? "")];
	for (const [key, value] of Object.entries(fields)) {
		if (SHOWN_IN_PLACE[key] === true) continue;
		parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	const text = parts.filter(Boolean).join(" ");
	return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text;
}

async function readTail(path: string): Promise<string | undefined> {
	const file = await open(path, "r").catch(() => undefined);
	if (!file) return undefined;
	try {
		const { size } = await file.stat();
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		await file.read(buffer, 0, buffer.length, start);
		const text = buffer.toString("utf8");
		// A read from the middle starts inside a line: drop that partial one.
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		await file.close();
	}
}

/**
 * The last `TAIL_LINES` lines omp `pid` logged, compacted; empty when it has logged nothing (yet). A start that
 * crossed midnight has a log under each day; the newer is read.
 */
export async function ompLogTail(
	pid: number,
	spawnedAt: Date,
	options: { logsDir?: string; now?: Date } = {},
): Promise<string[]> {
	const logsDir = options.logsDir ?? join(agentDir(), "..", "logs");
	const days = [...new Set([localDay(options.now ?? new Date()), localDay(spawnedAt)])];
	for (const day of days) {
		const text = await readTail(join(logsDir, `omp.${day}.${pid}.log`));
		if (text === undefined) continue;
		return text
			.split("\n")
			.filter(line => line.trim())
			.slice(-TAIL_LINES)
			.map(compact);
	}
	return [];
}
