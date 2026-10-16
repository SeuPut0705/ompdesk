/**
 * The helper's inventory of what this computer's omp has installed → one row seed per marketplace, plugin,
 * skill group and MCP server, with the method that keeps it current or the reason it is left alone. Pure:
 * the one thing it cannot know, which binary a direct MCP command resolves to, comes in as `binaries`
 * (mcp-owner.ts, resolved by the updater).
 *
 * Row keys are opaque handles, stable across scans: `marketplace:<name>`, `plugin:<id>:<scope>[:<project>]`,
 * `skill:<id>:<scope>[:<project>]`, `skill:plugin`, `skill:local`, `mcp:<name>`. A project is a short hash of
 * its folder, so no path is in a key; `detail` shows `user` or the folder's name.
 */
import { createHash } from "node:crypto";
import type {
	HelperInventory,
	HelperMcpServer,
	PluginSelector,
	SkillSelector,
} from "../../../resources/gui-bridge/stock-helper/extensions-contracts";
import { REA_VERSION } from "../../shared/builtin-mcp";
import {
	EXTENSION_KINDS,
	type ExtensionKind,
	type ExtensionMethod,
	type ExtensionRow,
	type ExtensionSkipReason,
} from "../../shared/extension-update";
import { classifyMcpServer, commandName, type McpRunner } from "./mcp";
import type { McpBinary, McpOwner } from "./mcp-owner";
import type { RunnerPackage } from "./mcp-plans";
import { isExactVersion } from "./versions";

/** The fields of a row that classification decides; the updater adds the live ones (latest, phase, last…). */
export type SeedRow = Pick<
	ExtensionRow,
	"key" | "kind" | "name" | "detail" | "count" | "installed" | "method" | "skip"
>;

/** What a check or update of the row acts on. */
export type SeedTarget =
	| { kind: "none" }
	| { kind: "marketplace"; name: string }
	| { kind: "plugin"; selector: PluginSelector }
	| { kind: "skill"; selector: SkillSelector }
	/** A pinned runner package: checked against its registry, never changed. */
	| { kind: "runner"; runner: RunnerPackage }
	/** A direct command's binary, updated by its owner. */
	| { kind: "binary"; command: string; binary: McpBinary; owner: McpOwner };

export interface ExtensionSeed {
	row: SeedRow;
	target: SeedTarget;
}

export interface ClassifyOptions {
	/** The built-in REA's root (a server whose source is under it is the built-in). */
	reaRoot: string | null;
	/** The built-in REA is on in this app: it is listed even though stock never reports it (it is an extension root). */
	reaEnabled: boolean;
	/** The resolved binary of each direct MCP command, by server name; null when it resolves to nothing. */
	binaries: ReadonlyMap<string, McpBinary | null>;
}

/** The server name the built-in REA has in stock's MCP manager. */
export const BUILTIN_MCP_NAME = "rea";

export function projectHash(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 8);
}

function scopeKey(scope: "user" | "project", cwd: string | null): string {
	return scope === "project" && cwd ? `${scope}:${projectHash(cwd)}` : scope;
}

function scopeDetail(scope: "user" | "project", cwd: string | null): string {
	if (scope === "user" || !cwd) return "user";
	return (
		cwd
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.at(-1) || cwd
	);
}

const RUNNER_METHOD: Record<McpRunner, ExtensionMethod> = {
	npx: "npm",
	"pnpm-dlx": "npm",
	"npm-exec": "npm",
	bunx: "bun",
	"bun-x": "bun",
	uvx: "uv",
	"uv-tool-run": "uv",
	"pipx-run": "pipx",
};

const PLUGIN_METHOD = { marketplace: "marketplace", npm: "npm-plugin", git: "git-plugin" } as const;

function mcpSeed(server: HelperMcpServer, options: ClassifyOptions): ExtensionSeed {
	const base = { key: `mcp:${server.name}`, kind: "mcp", name: server.name, count: null } as const;
	const skipped = (
		skip: ExtensionSkipReason,
		fields: { detail?: string | null; installed?: string | null; method?: ExtensionMethod | null } = {},
	): ExtensionSeed => ({
		row: { ...base, detail: null, installed: null, method: null, ...fields, skip },
		target: { kind: "none" },
	});
	const cls = classifyMcpServer(server, { reaRoot: options.reaRoot });
	switch (cls.kind) {
		case "builtin":
			return skipped("builtin", { installed: REA_VERSION });
		case "remote":
			// The URL can carry a token: it is never shown.
			return skipped("remote");
		case "unsupported":
			return skipped("unknown-install", { detail: server.command ? commandName(server.command) : null });
		case "runner": {
			if (!cls.pinned) return skipped("follows-latest", { detail: cls.spec });
			const method = RUNNER_METHOD[cls.runner];
			const installed = cls.version && isExactVersion(cls.version) ? cls.version : null;
			const row: SeedRow = { ...base, detail: cls.spec, installed, method, skip: "pinned" };
			return { row, target: server.enabled && cls.checkable ? { kind: "runner", runner: cls } : { kind: "none" } };
		}
		case "direct": {
			const binary = options.binaries.get(server.name) ?? null;
			const name = commandName(cls.command);
			if (!binary) return skipped("unknown-install", { detail: name });
			const owner = binary.owner;
			if (!owner) return skipped(binary.skip ?? "unknown-install", { detail: name, installed: binary.installed });
			const detail = "name" in owner ? owner.name : name;
			const row: SeedRow = { ...base, detail, installed: binary.installed, method: owner.method, skip: null };
			return {
				row,
				target: server.enabled ? { kind: "binary", command: cls.command, binary, owner } : { kind: "none" },
			};
		}
	}
}

export function classifyInventory(inventory: HelperInventory, options: ClassifyOptions): ExtensionSeed[] {
	const seeds: ExtensionSeed[] = [];

	for (const marketplace of inventory.marketplaces) {
		seeds.push({
			row: {
				key: `marketplace:${marketplace.name}`,
				kind: "marketplace",
				name: marketplace.name,
				detail: marketplace.source,
				count: null,
				installed: null,
				method: "catalog",
				skip: null,
			},
			target: { kind: "marketplace", name: marketplace.name },
		});
	}

	for (const plugin of inventory.plugins) {
		const key = `plugin:${plugin.id}:${scopeKey(plugin.scope, plugin.cwd)}`;
		const fields = {
			key,
			kind: "plugin",
			name: plugin.id,
			detail: scopeDetail(plugin.scope, plugin.cwd),
			count: null,
		} as const;
		if (plugin.channel === "linked") {
			seeds.push({
				row: { ...fields, installed: plugin.installed, method: null, skip: "linked" },
				target: { kind: "none" },
			});
			continue;
		}
		seeds.push({
			row: { ...fields, installed: plugin.installed, method: PLUGIN_METHOD[plugin.channel], skip: null },
			target: {
				kind: "plugin",
				selector: { channel: plugin.channel, id: plugin.id, scope: plugin.scope, cwd: plugin.cwd },
			},
		});
	}

	for (const skill of inventory.registrySkills) {
		seeds.push({
			row: {
				key: `skill:${skill.id}:${scopeKey(skill.scope, skill.cwd)}`,
				kind: "skill",
				name: skill.id,
				detail: scopeDetail(skill.scope, skill.cwd),
				count: null,
				installed: skill.installed,
				method: "registry",
				// An exact manifest range is the user's pin; the check still shows a newer version.
				skip: skill.range && isExactVersion(skill.range) ? "pinned" : null,
			},
			target: { kind: "skill", selector: { id: skill.id, scope: skill.scope, cwd: skill.cwd } },
		});
	}
	if (inventory.pluginSkills > 0) {
		seeds.push({
			row: {
				key: "skill:plugin",
				kind: "skill",
				name: "plugin",
				detail: null,
				count: inventory.pluginSkills,
				installed: null,
				method: null,
				skip: "follows-plugin",
			},
			target: { kind: "none" },
		});
	}
	if (inventory.localSkills > 0) {
		seeds.push({
			row: {
				key: "skill:local",
				kind: "skill",
				name: "local",
				detail: null,
				count: inventory.localSkills,
				installed: null,
				method: null,
				skip: "local",
			},
			target: { kind: "none" },
		});
	}

	for (const server of inventory.mcpServers) seeds.push(mcpSeed(server, options));
	if (options.reaEnabled && !inventory.mcpServers.some(server => server.name === BUILTIN_MCP_NAME)) {
		seeds.push({
			row: {
				key: `mcp:${BUILTIN_MCP_NAME}`,
				kind: "mcp",
				name: BUILTIN_MCP_NAME,
				detail: null,
				count: null,
				installed: REA_VERSION,
				method: null,
				skip: "builtin",
			},
			target: { kind: "none" },
		});
	}

	const order = (kind: ExtensionKind) => EXTENSION_KINDS.indexOf(kind);
	const unique = new Map<string, ExtensionSeed>();
	for (const seed of seeds) if (!unique.has(seed.row.key)) unique.set(seed.row.key, seed);
	return [...unique.values()].sort(
		(a, b) =>
			order(a.row.kind) - order(b.row.kind) ||
			a.row.name.localeCompare(b.row.name) ||
			a.row.key.localeCompare(b.row.key),
	);
}
