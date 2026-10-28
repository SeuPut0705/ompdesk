import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_FULL_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
	agentControlApproveEnabled,
	agentControlEnabled,
	agentControlFullEnabled,
	agentControlManageEnabled,
} from "../shared/agent-control";
import { AI_MEMORY_LEARN_PREF, AI_MEMORY_PREF, aiMemoryEnabled } from "../shared/ai-memory";
import { ECC_PREF, eccEnabled } from "../shared/ecc";
import { PSTACK_PREF, pstackEnabled } from "../shared/pstack";
import {
	AGENT_POWERS_MIGRATION_PREF,
	AGENT_POWERS_MIGRATION_VERSION,
	migrateAgentPowers,
} from "./agent-power-migration";

function memoryStore(initial: Record<string, unknown> = {}) {
	const data: Record<string, unknown> = structuredClone(initial);
	return {
		data,
		get: (key: string) => data[key],
		set: (key: string, value: unknown) => {
			data[key] = value;
		},
		delete: (key: string) => {
			delete data[key];
		},
	};
}

/** Every switch as the app resolves it from the stored prefs, the way each consumer reads it. */
function resolved(data: Record<string, unknown>) {
	return {
		control: agentControlEnabled(data[AGENT_CONTROL_PREF]),
		full: agentControlFullEnabled(data[AGENT_CONTROL_FULL_PREF]),
		manage: agentControlManageEnabled(data[AGENT_CONTROL_MANAGE_PREF]),
		approve: agentControlApproveEnabled(data[AGENT_CONTROL_APPROVE_PREF]),
		pstack: pstackEnabled(data[PSTACK_PREF]),
		ecc: eccEnabled(data[ECC_PREF]),
		memory: aiMemoryEnabled(data[AI_MEMORY_PREF]),
		learn: data[AI_MEMORY_LEARN_PREF] !== false,
	};
}

const ALL_ON = {
	control: true,
	full: true,
	manage: true,
	approve: true,
	pstack: true,
	ecc: true,
	memory: true,
	learn: true,
};

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "ompdesk-powers-"));
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("migrateAgentPowers", () => {
	it("leaves a fresh profile with every power on and records that it ran", () => {
		const store = memoryStore();
		const report = migrateAgentPowers(store, agentDir);
		expect(report).toEqual({ prefs: [], stock: [] });
		expect(resolved(store.data)).toEqual(ALL_ON);
		expect(store.data[AGENT_POWERS_MIGRATION_PREF]).toBe(AGENT_POWERS_MIGRATION_VERSION);
	});

	it("turns an old explicit off back on once, and a later off stays off", () => {
		const store = memoryStore({
			[AGENT_CONTROL_PREF]: false,
			[AGENT_CONTROL_FULL_PREF]: false,
			[AGENT_CONTROL_MANAGE_PREF]: false,
			[AGENT_CONTROL_APPROVE_PREF]: false,
			[PSTACK_PREF]: false,
			[ECC_PREF]: false,
			[AI_MEMORY_PREF]: false,
			[AI_MEMORY_LEARN_PREF]: false,
			language: "ko",
		});
		expect(resolved(store.data)).toEqual({
			control: false,
			full: false,
			manage: false,
			approve: false,
			pstack: false,
			ecc: false,
			memory: false,
			learn: false,
		});

		const report = migrateAgentPowers(store, agentDir);
		expect(report?.prefs).toHaveLength(8);
		expect(resolved(store.data)).toEqual(ALL_ON);
		expect(store.data.language).toBe("ko");

		// The person turns two off after the migration: the next launch keeps them off.
		store.set(AGENT_CONTROL_FULL_PREF, false);
		store.set(PSTACK_PREF, false);
		expect(migrateAgentPowers(store, agentDir)).toBeNull();
		expect(resolved(store.data)).toMatchObject({ full: false, pstack: false, control: true });
	});

	it("keeps a stored true and an unrelated pref untouched", () => {
		const store = memoryStore({ [ECC_PREF]: true, [AGENT_CONTROL_APPROVE_PREF]: true, proxyUrl: "x" });
		const report = migrateAgentPowers(store, agentDir);
		expect(report?.prefs).toEqual([]);
		expect(store.data).toMatchObject({ [ECC_PREF]: true, [AGENT_CONTROL_APPROVE_PREF]: true, proxyUrl: "x" });
	});

	it("removes an off computer setting and a stricter approval mode from config.yml once, keeping the rest", () => {
		const file = join(agentDir, "config.yml");
		writeFileSync(
			file,
			"theme: dark\ncomputer:\n  enabled: false\ntools:\n  approvalMode: always-ask\n  approval:\n    bash: prompt\n",
			{ mode: 0o600 },
		);
		const store = memoryStore();
		const report = migrateAgentPowers(store, agentDir);
		expect(report?.stock).toEqual(["computer.enabled", "tools.approvalMode"]);
		expect(readFileSync(file, "utf8")).toBe("theme: dark\ntools:\n  approval:\n    bash: prompt\n");
		expect(statSync(file).mode & 0o777).toBe(0o600);

		// Turned off again after the migration: not touched.
		writeFileSync(file, "computer:\n  enabled: false\ntools:\n  approvalMode: always-ask\n");
		expect(migrateAgentPowers(store, agentDir)).toBeNull();
		expect(readFileSync(file, "utf8")).toBe("computer:\n  enabled: false\ntools:\n  approvalMode: always-ask\n");
	});

	it("leaves an on computer setting and a yolo approval mode alone, and a missing config.yml", () => {
		const file = join(agentDir, "config.yml");
		const text = "computer:\n  enabled: true\ntools:\n  approvalMode: yolo\n";
		writeFileSync(file, text);
		expect(migrateAgentPowers(memoryStore(), agentDir)?.stock).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(text);
		expect(migrateAgentPowers(memoryStore(), join(agentDir, "absent"))).toEqual({ prefs: [], stock: [] });
	});

	it("still migrates the prefs when config.yml is not valid YAML, and reports why", () => {
		const file = join(agentDir, "config.yml");
		writeFileSync(file, "a: [unclosed\n");
		const store = memoryStore({ [PSTACK_PREF]: false });
		const report = migrateAgentPowers(store, agentDir);
		expect(report?.prefs).toEqual([PSTACK_PREF]);
		expect(report?.error).toContain("config.yml is not valid YAML");
		expect(readFileSync(file, "utf8")).toBe("a: [unclosed\n");
		expect(store.data[AGENT_POWERS_MIGRATION_PREF]).toBe(AGENT_POWERS_MIGRATION_VERSION);
	});
});
