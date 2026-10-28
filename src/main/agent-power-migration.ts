import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_FULL_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
} from "../shared/agent-control";
import { AI_MEMORY_LEARN_PREF, AI_MEMORY_PREF } from "../shared/ai-memory";
import { ECC_PREF } from "../shared/ecc";
import { PSTACK_PREF } from "../shared/pstack";

/** Prefs key holding the version of the agent-power migration that already ran; absent on a fresh profile until the first launch. */
export const AGENT_POWERS_MIGRATION_PREF = "agentPowersMigrated";
/** Bump only for another one-time "turn every power on" decision. */
export const AGENT_POWERS_MIGRATION_VERSION = 1;

interface PrefsLike {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	delete(key: string): void;
}

/** Switches that default on (only a stored `false` is off): the migration drops an old explicit off. */
const POWER_PREFS: readonly string[] = [
	AGENT_CONTROL_PREF,
	AGENT_CONTROL_FULL_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_APPROVE_PREF,
	PSTACK_PREF,
	ECC_PREF,
	AI_MEMORY_PREF,
	AI_MEMORY_LEARN_PREF,
];

/**
 * Stock settings in config.yml that gate an agent's power. A value that is not the on one is removed so stock's
 * default (`tools.approvalMode` yolo) and OMPdesk's held default (`computer.enabled` on) apply again.
 */
const STOCK_POWERS: readonly { path: readonly string[]; on: (value: unknown) => boolean }[] = [
	{ path: ["computer", "enabled"], on: value => value === true },
	{ path: ["tools", "approvalMode"], on: value => value === "yolo" },
];

export interface AgentPowersReport {
	/** Prefs that were stored off and are on again. */
	prefs: string[];
	/** Dotted config.yml keys that were off (or stricter) and were removed. */
	stock: string[];
	/** Why config.yml was left alone (unreadable, malformed, not writable); the prefs part still ran. */
	error?: string;
}

/**
 * The user's decision, 29 Oct 2026: agents have every power by default, no setup. Runs once per profile
 * ({@link AGENT_POWERS_MIGRATION_VERSION}): every power an older build or the person had stored off is on again.
 * Later changes in Settings are the person's and are never touched, because the stored version stops a rerun.
 * Returns what it changed, or null when it had already run.
 */
export function migrateAgentPowers(store: PrefsLike, agentDir: string): AgentPowersReport | null {
	const done = store.get(AGENT_POWERS_MIGRATION_PREF);
	if (typeof done === "number" && done >= AGENT_POWERS_MIGRATION_VERSION) return null;
	const report: AgentPowersReport = { prefs: [], stock: [] };
	for (const key of POWER_PREFS) {
		if (store.get(key) !== false) continue;
		store.delete(key);
		report.prefs.push(key);
	}
	try {
		report.stock = resetStockPowers(join(agentDir, "config.yml"));
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
	}
	store.set(AGENT_POWERS_MIGRATION_PREF, AGENT_POWERS_MIGRATION_VERSION);
	return report;
}

function resetStockPowers(file: string): string[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const doc = parseDocument(text);
	if (doc.errors.length > 0) throw new Error(`config.yml is not valid YAML: ${doc.errors[0]?.message}`);
	const removed: string[] = [];
	for (const { path, on } of STOCK_POWERS) {
		const value = doc.getIn([...path]);
		if (value === undefined || on(value)) continue;
		doc.deleteIn([...path]);
		const parentPath = path.slice(0, -1);
		const parent = doc.getIn(parentPath, true);
		if (isMap(parent) && parent.items.length === 0) doc.deleteIn(parentPath);
		removed.push(path.join("."));
	}
	if (removed.length === 0) return [];
	const next = `${file}.ompdesk-tmp`;
	writeFileSync(next, doc.toString(), { mode: statSync(file).mode & 0o777 });
	renameSync(next, file);
	return removed;
}
