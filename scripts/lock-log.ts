/**
 * The lock's usage log (`scripts/build-lock.ts` writes it, `bun run
 * lock-stats` reads it): one JSON line per slot hold, written when the
 * holder releases the lock, so it carries both the wait and the hold. It sits
 * next to the lock, `/tmp/ompdesk-build.log` (Windows: the temp directory), and
 * is trimmed to the newest entries once it passes `MAX_LINES`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LOCK_LOG =
	process.env.OMPDESK_LOCK_LOG ||
	(process.platform === "win32" ? path.join(os.tmpdir(), "ompdesk-build.log") : "/tmp/ompdesk-build.log");

/** Past this many lines the log keeps only its newest `KEEP_LINES`. */
const MAX_LINES = 5_000;
const KEEP_LINES = 4_000;
/** Lines run about 250 bytes; below this size the log cannot be over `MAX_LINES`. */
const TRIM_CHECK_BYTES = MAX_LINES * 100;

export type LockKind = "build" | "playwright" | "vitest" | "gate" | "other";

export interface LockLogEntry {
	/** ISO time the lock was taken. */
	time: string;
	owner: string;
	command: string;
	kind: LockKind;
	cwd: string;
	waitedMs: number;
	/** Which slot of its kind the hold used; absent in entries from the single-lock days. */
	slot?: number;
	/** The orchestrating command (`gate`, `check:changed`) that took this hold as one of its phases. */
	via?: string;
	heldMs: number;
	exit: number;
}

/** What a locked command is, from its command line. */
export function commandKind(command: string): LockKind {
	// The gate and check:changed hold no lock themselves: each phase takes its own slot.
	if (/(^|[\s/])gate(\.ts)?(\s|$)|check[:-]changed/.test(command)) return "gate";
	if (/playwright|\btest:e2e\b/.test(command)) return "playwright";
	if (/vitest|\brun test(:platform)?(\s|$)/.test(command)) return "vitest";
	if (/electron-vite|electron-builder|\brun (build|package)/.test(command)) return "build";
	return "other";
}

/** Append one entry, then trim the log if it grew past `MAX_LINES`. */
export function appendLockLog(entry: LockLogEntry, file = LOCK_LOG): void {
	fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
	if (fs.statSync(file).size < TRIM_CHECK_BYTES) return;
	const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	if (lines.length <= MAX_LINES) return;
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
	fs.renameSync(temp, file);
}

/** Every well-formed entry in the log; a missing log has none. */
export function readLockLog(file = LOCK_LOG): LockLogEntry[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries: LockLogEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as LockLogEntry;
			if (typeof entry.time === "string" && typeof entry.waitedMs === "number") entries.push(entry);
		} catch {
			// A line cut short by a crash; skip it.
		}
	}
	return entries;
}
