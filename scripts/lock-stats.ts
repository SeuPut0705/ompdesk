/**
 * Summarize the lock's log (`scripts/lock-log.ts`): how long locked commands
 * waited for a slot and held it, per owner, per command kind and per slot
 * (with how busy each slot was), the holds past the 15-minute limit (gate
 * exempt), and the slots held right now.
 *
 *   bun run lock-stats [--since 2h]     (s, m, h or d; default 24h; `all` for everything)
 */
import { LOCK_LOG, type LockLogEntry, readLockLog } from "./lock-log";
import { defaultLocks, inspectSlots, MAX_HOLD_MS } from "./lock-slots";

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `2h` → milliseconds; `all` → Infinity. */
export function parseSince(value: string): number {
	if (value === "all") return Number.POSITIVE_INFINITY;
	const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value);
	if (!match?.[1] || !match[2])
		throw new Error(`--since takes a duration like 30m, 2h or 7d, or "all"; got "${value}"`);
	return Number(match[1]) * (UNIT_MS[match[2]] ?? 0);
}

/** Nearest-rank percentile of ascending `sorted`; 0 for no values. */
export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
}

export interface StatsRow {
	key: string;
	runs: number;
	waitTotal: number;
	waitP50: number;
	waitP90: number;
	holdTotal: number;
	holdP50: number;
	holdP90: number;
}

/** One row per distinct `key(entry)`, longest total wait first. */
export function summarize(entries: readonly LockLogEntry[], key: (entry: LockLogEntry) => string): StatsRow[] {
	const groups = new Map<string, LockLogEntry[]>();
	for (const entry of entries) {
		const name = key(entry);
		const group = groups.get(name);
		if (group) group.push(entry);
		else groups.set(name, [entry]);
	}
	const rows: StatsRow[] = [];
	for (const [name, group] of groups) {
		const waits = group.map(entry => entry.waitedMs).sort((a, b) => a - b);
		const holds = group.map(entry => entry.heldMs).sort((a, b) => a - b);
		rows.push({
			key: name,
			runs: group.length,
			waitTotal: waits.reduce((sum, ms) => sum + ms, 0),
			waitP50: percentile(waits, 50),
			waitP90: percentile(waits, 90),
			holdTotal: holds.reduce((sum, ms) => sum + ms, 0),
			holdP50: percentile(holds, 50),
			holdP90: percentile(holds, 90),
		});
	}
	return rows.sort((a, b) => b.waitTotal - a.waitTotal || b.holdTotal - a.holdTotal);
}

/** A non-gate hold longer than `MAX_HOLD_MS`. */
export function isLongHold(entry: LockLogEntry): boolean {
	return entry.kind !== "gate" && entry.via !== "gate" && entry.heldMs > MAX_HOLD_MS;
}

export interface SlotRow {
	key: string;
	runs: number;
	holdTotal: number;
	/** Share of `spanMs` the slot was held. */
	busy: number;
}

/** One row per `kind#slot` (entries from before the slots count as `kind (single lock)`), by name. */
export function slotRows(entries: readonly LockLogEntry[], spanMs: number): SlotRow[] {
	const key = (entry: LockLogEntry) =>
		entry.slot === undefined ? `${entry.kind} (single lock)` : `${entry.kind}#${entry.slot}`;
	return summarize(entries, key)
		.map(row => ({ key: row.key, runs: row.runs, holdTotal: row.holdTotal, busy: row.holdTotal / spanMs }))
		.sort((a, b) => (a.key < b.key ? -1 : 1));
}

function slotTable(entries: readonly LockLogEntry[], spanMs: number): string {
	const rows = slotRows(entries, spanMs).map(row => [
		row.key,
		String(row.runs),
		duration(row.holdTotal),
		`${Math.round(row.busy * 100)}%`,
	]);
	const header = ["slot", "runs", "hold total", `busy of ${duration(spanMs)}`];
	const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map(row => row[i]?.length ?? 0)));
	return [header, ...rows]
		.map(row =>
			row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  "),
		)
		.join("\n");
}

function duration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	return minutes < 60
		? `${minutes}m${Math.round((ms % 60_000) / 1000)}s`
		: `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function table(title: string, rows: readonly StatsRow[]): string {
	const header = [
		title,
		"runs",
		"wait total",
		"wait avg",
		"wait p50",
		"wait p90",
		"hold total",
		"hold p50",
		"hold p90",
	];
	const cells = rows.map(row => [
		row.key,
		String(row.runs),
		duration(row.waitTotal),
		duration(row.waitTotal / row.runs),
		duration(row.waitP50),
		duration(row.waitP90),
		duration(row.holdTotal),
		duration(row.holdP50),
		duration(row.holdP90),
	]);
	const widths = header.map((cell, i) => Math.max(cell.length, ...cells.map(row => row[i]?.length ?? 0)));
	return [header, ...cells]
		.map(row =>
			row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  "),
		)
		.join("\n");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const sinceArg = args[args.indexOf("--since") + 1];
	const since = args.includes("--since") && sinceArg ? sinceArg : "24h";
	const windowMs = parseSince(since);
	const from = Date.now() - windowMs;
	const entries = readLockLog().filter(entry => Date.parse(entry.time) >= from);
	const live = inspectSlots(defaultLocks());
	if (entries.length === 0) {
		console.log(`[lock-stats] no locked runs in ${LOCK_LOG} over the last ${since}`);
	} else {
		const [total] = summarize(entries, () => "all");
		if (total) {
			console.log(
				`[lock-stats] ${total.runs} locked runs over the last ${since}: waited ${duration(total.waitTotal)} (avg ${duration(total.waitTotal / total.runs)}), held ${duration(total.holdTotal)} (${LOCK_LOG})\n`,
			);
		}
		console.log(
			`${table(
				"owner",
				summarize(entries, entry => entry.owner),
			)}\n`,
		);
		console.log(
			`${table(
				"kind",
				summarize(entries, entry => entry.kind),
			)}\n`,
		);
		const first = Math.min(...entries.map(entry => Date.parse(entry.time)));
		const span = Math.max(1, Math.min(windowMs, Date.now() - first));
		console.log(slotTable(entries, span));
		const long = entries.filter(isLongHold);
		if (long.length > 0) {
			console.log(
				`\n[lock-stats] ${long.length} hold(s) over the ${duration(MAX_HOLD_MS)} limit (gate exempt); split them with \`bun run locked -- --chunk <n> -- <command>\`:`,
			);
			for (const entry of long) {
				console.log(`  ${entry.owner}  ${entry.kind}  held ${duration(entry.heldMs)}  ${entry.command}`);
			}
		}
	}
	const busy = live.filter(view => view.holder);
	console.log(
		busy.length === 0
			? "\n[lock-stats] no slot held right now"
			: `\n[lock-stats] held right now:\n${busy
					.map(
						view =>
							`  ${view.kind}#${view.slot}  ${view.holder}${view.heldMs === undefined ? "" : `  ${duration(view.heldMs)}`}${view.heldMs !== undefined && view.heldMs > MAX_HOLD_MS && !/gate/.test(view.command ?? "") ? "  OVER THE LIMIT" : ""}${view.stale ? "  (stale)" : ""}`,
					)
					.join("\n")}`,
	);
}
