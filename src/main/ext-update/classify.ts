/**
 * The helper's inventory of what this computer's omp has installed → one row seed per marketplace, plugin,
 * skill group and MCP server, with the method that keeps it current or the reason it is left alone. The rules
 * are the core process's (`native/ompdesk/crates/core/src/ext/seeds.rs`); this file is their contract and
 * client. The one thing they cannot know, which binary a direct MCP command resolves to, comes in as `binaries`
 * (mcp-owner.ts, resolved by the updater).
 *
 * Row keys are opaque handles, stable across scans: `marketplace:<name>`, `plugin:<id>:<scope>[:<project>]`,
 * `skill:<id>:<scope>[:<project>]`, `skill:plugin`, `skill:local`, `mcp:<name>`. A project is a short hash of
 * its folder, so no path is in a key; `detail` shows `user` or the folder's name.
 */
import { createHash } from "node:crypto";
import type {
	HelperInventory,
	PluginSelector,
	SkillSelector,
} from "../../../resources/gui-bridge/stock-helper/extensions-contracts";
import { REA_VERSION } from "../../shared/builtin-mcp";
import { EXTENSION_KINDS, type ExtensionRow } from "../../shared/extension-update";
import { extRule } from "./core";
import type { McpBinary, McpOwner } from "./mcp-owner";
import type { RunnerPackage } from "./mcp-plans";

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

/** A seed as the core answers it: a binary's target names the command, and the binary is joined here. */
interface CoreSeed {
	row: SeedRow;
	target: Exclude<SeedTarget, { kind: "binary" }> | { kind: "binary"; command: string };
}

export function projectHash(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 8);
}

export async function classifyInventory(
	inventory: HelperInventory,
	options: ClassifyOptions,
): Promise<ExtensionSeed[]> {
	const projects = new Map<string, string>();
	for (const entry of [...inventory.plugins, ...inventory.registrySkills])
		if (entry.scope === "project" && entry.cwd) projects.set(entry.cwd, projectHash(entry.cwd));
	const seeds = await extRule<CoreSeed[]>("ext.seeds", {
		inventory,
		reaRoot: options.reaRoot,
		reaEnabled: options.reaEnabled,
		reaVersion: REA_VERSION,
		kinds: EXTENSION_KINDS,
		// Names sort as `localeCompare` sorts them here.
		locale: new Intl.Collator().resolvedOptions().locale,
		projects: [...projects],
		binaries: [...options.binaries],
	});
	return seeds.map(({ row, target }): ExtensionSeed => {
		if (target.kind !== "binary") return { row, target };
		const binary = options.binaries.get(row.name);
		return {
			row,
			target: binary?.owner ? { ...target, binary, owner: binary.owner } : { kind: "none" },
		};
	});
}
