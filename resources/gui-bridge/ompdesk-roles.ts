/**
 * OMPdesk's own model roles and agent tiers held on stock's settings
 * (contracts and the role list: ompdesk-role-contracts.ts).
 *
 * - Each `OMPDESK_ROLES` id is stock's `modelRoles.<id>` held as a runtime
 *   override: merged in per key (`Settings.overrideModelRoles`, so `--smol`
 *   and the like keep their runtime values), never persisted (stock's
 *   override layer has no save), and left alone while config.yml or a project
 *   config sets the id (`getGlobalModelRole` / `getProjectModelRole`) or a
 *   runtime value OMPdesk did not write is there. Stock lists it with its
 *   custom roles and resolves `@<id>` everywhere, subagents included (their
 *   overlay settings read the parent live).
 * - `AGENT_TIERS` fill `task.agentModelOverrides` per agent the same way, only
 *   while stock's bundled agent of that name has no `model:` line. Overrides
 *   outrank an agent file's own `model:`, so a user's own agent file of that
 *   name with a model line gets it back at spawn (`before_subagent_spawn`).
 * - The user's picks are a JSON file every omp of this computer shares
 *   (`OMP_GUI_OMPDESK_ROLES`); `settleOmpdeskRoles` re-reads it before every
 *   turn and around the Settings reads and writes.
 * - Stock's `/modelpreset save` snapshots `getModelRoles()` (runtime layer
 *   included) into config.yml and `switch` rewrites every role it lists, so
 *   the held roles step aside for those two commands (the `input` hook runs
 *   before stock's builtin slash commands over RPC) and come back once the
 *   preset is saved, at the next input or turn, or after `PRESET_GRACE_MS`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { AGENT_TIERS, heldRoleValue, OMPDESK_ROLES, OMPDESK_ROLES_ENV, parseRolePicks } from "./ompdesk-role-contracts";

export const methods = {};

/** The slice of stock's `Settings` this module reads and writes. */
export interface RoleSettings {
	getGlobalModelRole(role: string): string | undefined;
	getProjectModelRole(role: string): string | undefined;
	getGlobalSettings(): unknown;
	getProjectSettings(): unknown;
	overlayLayers(): { overrides: unknown };
	overrideModelRoles(roles: Record<string, string>): void;
}

/** What OMPdesk wrote into each Settings' runtime layer: `role:<id>` / `agent:<name>` → value. */
const held = new WeakMap<object, Map<string, string>>();

function heldIn(scope: object): Map<string, string> {
	let map = held.get(scope);
	if (!map) {
		map = new Map();
		held.set(scope, map);
	}
	return map;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** The user's picks (role id → model); nothing when the file is missing or unreadable. */
export function readRolePicks(): Record<string, string> {
	const file = process.env[OMPDESK_ROLES_ENV];
	if (!file) return {};
	try {
		return parseRolePicks(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return {};
	}
}

/** Store (or clear) the pick for an OMPdesk role; every omp of this computer takes it up at its next settle. */
export function writeRolePick(id: string, pick: string | undefined): void {
	const file = process.env[OMPDESK_ROLES_ENV];
	if (!file) throw new Error("OMPdesk roles need OMP_GUI_OMPDESK_ROLES");
	const picks = readRolePicks();
	if (pick) picks[id] = pick;
	else delete picks[id];
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(picks, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
}

/** Whether config.yml or a project config sets OMPdesk role `id` (the user's own value wins). */
export function roleConfigured(settings: RoleSettings, id: string): boolean {
	return Boolean(settings.getGlobalModelRole(id)?.trim() || settings.getProjectModelRole(id)?.trim());
}

/** Drop key `key` of the record setting `id` from the runtime layer (the rest of that layer stays). */
function dropRuntimeEntry(settings: RoleSettings, id: string, segments: readonly string[], key: string): void {
	const handle = lookup(id) as { override(scope: object, value: unknown): void; clearOverride(scope: object): void };
	let layer: unknown = settings.overlayLayers().overrides;
	for (const segment of segments) layer = record(layer)[segment];
	const next = { ...record(layer) };
	delete next[key];
	if (Object.keys(next).length > 0) handle.override(settings, next);
	else handle.clearOverride(settings);
}

/** Settings whose held roles stepped aside for a `/modelpreset save` or `switch` that has not finished yet. */
const steppedAside = new WeakSet<object>();
/** The longest a `/modelpreset` command keeps the held roles away (it runs within milliseconds of its input). */
const PRESET_GRACE_MS = 2000;
const PRESET_COMMAND = /^\s*\/modelpreset\s+(save|switch)\b/;

/** Take the held roles out of the runtime layer, so a preset neither saves nor clears them. */
function stepAside(settings: RoleSettings): void {
	const mine = heldIn(settings);
	for (const role of OMPDESK_ROLES) {
		if (mine.delete(`role:${role.id}`)) dropRuntimeEntry(settings, "modelRoles", ["modelRoles"], role.id);
	}
	steppedAside.add(settings);
}

function stepBack(settings: RoleSettings): void {
	if (steppedAside.delete(settings)) settleOmpdeskRoles(settings);
}

function settleRoles(settings: RoleSettings, mine: Map<string, string>): void {
	if (steppedAside.has(settings)) return;
	const picks = readRolePicks();
	const runtime = record(record(settings.overlayLayers().overrides).modelRoles);
	for (const role of OMPDESK_ROLES) {
		const key = `role:${role.id}`;
		const current = runtime[role.id];
		const ours = mine.get(key);
		// A runtime value OMPdesk did not write (a `--config` flag, stock's own setter) is not ours to touch.
		if (current !== undefined && current !== ours) {
			mine.delete(key);
			continue;
		}
		if (roleConfigured(settings, role.id)) {
			if (ours !== undefined) dropRuntimeEntry(settings, "modelRoles", ["modelRoles"], role.id);
			mine.delete(key);
			continue;
		}
		const want = heldRoleValue(role, picks[role.id]);
		if (current !== want) settings.overrideModelRoles({ [role.id]: want });
		mine.set(key, want);
	}
}

function persistedAgentModel(settings: RoleSettings, agent: string): boolean {
	return [settings.getGlobalSettings(), settings.getProjectSettings()].some(
		layer => record(record(record(layer).task).agentModelOverrides)[agent] !== undefined,
	);
}

function settleAgentTiers(settings: RoleSettings, mine: Map<string, string>): void {
	const handle = lookup("task.agentModelOverrides") as { override(scope: object, value: unknown): void } | undefined;
	if (!handle) return;
	for (const [agent, tier] of Object.entries(AGENT_TIERS)) {
		const key = `agent:${agent}`;
		const runtime = record(record(record(settings.overlayLayers().overrides).task).agentModelOverrides);
		const current = runtime[agent];
		const ours = mine.get(key);
		const want = tier.join(",");
		if (current !== undefined && current !== ours) {
			mine.delete(key);
			continue;
		}
		// Only the hole stock leaves: its bundled agent without a model line, and nothing the user set.
		const bundled = getBundledAgent(agent);
		if (!bundled || (bundled.model?.length ?? 0) > 0 || persistedAgentModel(settings, agent)) {
			if (ours !== undefined)
				dropRuntimeEntry(settings, "task.agentModelOverrides", ["task", "agentModelOverrides"], agent);
			mine.delete(key);
			continue;
		}
		if (current !== want) handle.override(settings, { ...runtime, [agent]: want });
		mine.set(key, want);
	}
}

/** Bring the held roles and agent tiers in line with the picks file and the user's persisted layers. */
export function settleOmpdeskRoles(settings: RoleSettings): void {
	const mine = heldIn(settings);
	settleRoles(settings, mine);
	settleAgentTiers(settings, mine);
}

/** Settings whose `modelPresets` changes are watched (one listener per instance, whatever the rebinds). */
const watched = new WeakSet<object>();

export function install(pi: ExtensionAPI): void {
	const settings = (): RoleSettings => pi.pi.Settings.instance as unknown as RoleSettings;
	const scope = settings();
	if (!watched.has(scope)) {
		watched.add(scope);
		// A saved preset is the save command done: the held roles come back right after it.
		const presets = lookup("modelPresets") as { listen?(scope: object, onChange: () => void): unknown } | undefined;
		presets?.listen?.(scope, () => stepBack(scope));
	}
	pi.on("input", event => {
		const current = settings();
		if (PRESET_COMMAND.test(event.text)) {
			stepAside(current);
			setTimeout(() => stepBack(current), PRESET_GRACE_MS).unref?.();
		} else {
			stepBack(current);
		}
		return undefined;
	});
	// A pick made on another tab, or a config.yml edit, applies from this session's next turn.
	pi.on("before_agent_start", () => {
		steppedAside.delete(settings());
		settleOmpdeskRoles(settings());
		return undefined;
	});
	// The held tier outranks an agent file's own `model:` line; a user's own agent of that name keeps its line.
	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (!(event.agent in AGENT_TIERS) || !held.get(settings())?.has(`agent:${event.agent}`)) return undefined;
		const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
		const { agents } = await discoverAgents(ctx.cwd, undefined, session?.effectiveExtensionRoots);
		const own = getAgent(agents, event.agent);
		if (!own || own.source === "bundled" || !own.model?.length) return undefined;
		return { model: own.model };
	});
}
