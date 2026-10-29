/**
 * Keeping ai-memory's wiring in omp's agent dir out of the sessions OMPdesk spawns. omp loads every extension and MCP
 * server of the agent dir into every process it starts, so wiring the person made themselves (`ai-memory setup
 * --agent omp`, which writes `extensions/ai-memory-omp.ts` and an `ai-memory` entry in `mcp.json`) would capture a
 * session and serve memory tools next to OMPdesk's own root, which `-e` adds: two captures and two memory servers,
 * one of each from a build that is not OMPdesk's. OMPdesk never edits the agent dir for this (that is the terminal
 * button's job, and only the button's). Stock's own switch is the one it has: the ids (`extension-module:<name>`,
 * `mcp:<server name>`) in `disabledExtensions`, here through a `--config` overlay that only the spawn carries. The
 * root's own MCP server is named `ompdesk-memory` (root.ts), so disabling the agent dir's `mcp:ai-memory` cannot
 * disable it.
 *
 * An overlay replaces a list setting whole, so the overlay's list is the one omp would have used (the project's when
 * the folder's own config sets one, else the agent dir's) plus those ids, and a person's other disabled skills, hooks
 * and extensions stay disabled. The overlay's value is what omp reads for the whole session, so a switch the person
 * flips in the extension dashboard after the spawn takes effect with the next spawn (the write itself goes to their
 * own config, which this never touches).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/** omp's id for `<agent dir>/extensions/ai-memory-omp.ts` (`extension-module:<file name without its extension>`). */
export const TERMINAL_EXTENSION_ID = "extension-module:ai-memory-omp";
/** omp's id for the `ai-memory` server of `<agent dir>/mcp.json` (`mcp:<server name>`); OMPdesk's own is `ompdesk-memory`. */
export const TERMINAL_MCP_ID = "mcp:ai-memory";
/** Stock reads the first of these that exists as the agent dir's config. */
const AGENT_CONFIGS = ["config.yml", "config.yaml"];
/** The folder's own settings, lowest to highest precedence (stock's `#configWatchTargets` order). */
const PROJECT_CONFIGS = [join(".omp", "config.yml"), join(".omp", "settings.json"), join(".claude", "settings.json")];

/** `disabledExtensions` of one config file: undefined when the file is absent, unreadable or does not set it. */
async function disabledIn(file: string): Promise<string[] | undefined> {
	let parsed: unknown;
	try {
		parsed = parse(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || !("disabledExtensions" in parsed)) return undefined;
	const list = parsed.disabledExtensions;
	return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : undefined;
}

/** The ids omp would hold disabled for a session in `cwd`: the project's list replaces the agent dir's, as in stock. */
async function effectiveDisabled(agentDir: string, cwd: string | undefined): Promise<string[]> {
	let list: string[] | undefined;
	for (const name of AGENT_CONFIGS) {
		const found = await disabledIn(join(agentDir, name));
		if (found) {
			list = found;
			break;
		}
	}
	if (cwd) {
		for (const name of PROJECT_CONFIGS) list = (await disabledIn(join(cwd, name))) ?? list;
	}
	return list ?? [];
}

/**
 * The overlay file for a spawn in `cwd`, written under `dir` and named by its content, so concurrent spawns write the
 * same bytes and a spawn whose lists did not change finds its file in place. A running omp watches its overlay, so a
 * file is never removed or rewritten; one a few bytes long exists per distinct list a person has had.
 */
export async function suppressionOverlay(options: {
	agentDir: string;
	cwd: string | undefined;
	dir: string;
	/** The agent dir's own ai-memory ids to hold disabled: `TERMINAL_EXTENSION_ID`, `TERMINAL_MCP_ID`. */
	ids: readonly string[];
}): Promise<string> {
	const { agentDir, cwd, dir, ids } = options;
	const disabledExtensions = [...new Set([...(await effectiveDisabled(agentDir, cwd)), ...ids])];
	// JSON is YAML, which is what omp parses an overlay as.
	const text = `${JSON.stringify({ disabledExtensions }, null, 2)}\n`;
	const name = `suppress-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.yml`;
	const file = join(dir, name);
	await mkdir(dir, { recursive: true });
	const present = await readFile(file, "utf8").catch(() => null);
	if (present !== text) {
		const part = `${file}.${process.pid}.${Date.now()}.part`;
		await writeFile(part, text);
		await rename(part, file);
	}
	return file;
}
