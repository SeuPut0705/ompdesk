/**
 * OMPdesk's own ai-memory wiring for omp: an extension package root that the sessions OMPdesk spawns load with `-e`
 * (`<userData>/ai-memory/omp-ext/`, like `resources/omp-builtin/rea`). omp reads a package root's `index.ts` as an
 * extension, its `.mcp.json` as MCP servers and its `skills/` as skills, so the root holds exactly what
 * `ai-memory setup --agent omp` would put into omp's agent dir:
 *
 *   index.ts     `ai-memory install-hooks --agent omp --apply --config-file <root>/index.ts`
 *   .mcp.json    `ai-memory install-mcp  --client omp --apply --config-file <root>/.mcp.json`
 *   skills/      `ai-memory install-skills --target-dir <root>/skills`
 *
 * Every byte is ai-memory's own generator output, produced next to the root and swapped in only when it differs, so
 * a launch that changed nothing touches nothing (a running omp keeps its files open on Windows) and ai-memory's
 * `.bak-<timestamp>` backups never pile up inside the root. OMPdesk changes one thing: the generated MCP entry
 * (`ai-memory mcp-bridge …`) becomes the `ompdesk-memory` http entry of OMPdesk's MCP hub
 * (resources/gui-bridge/mcp-hub.ts, one process per app, see mcp-hub-memory.ts), so no omp starts a relay or a bridge
 * of its own. It is named `ompdesk-memory`, not the generator's `ai-memory`: omp dedupes MCP servers by name and ranks
 * the agent dir over a package root, so an `ai-memory` entry the person wired there would take the name and OMPdesk's
 * own would never mount (the tools are `mcp__ompdesk_memory_*` as a result; every tool's own name and schema stay the
 * server's; the hub adds route summaries to the descriptions and passes the instructions through unchanged).
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MEMORY_HUB_ENTRY } from "../../../resources/gui-bridge/mcp-hub-contracts";
import { readMcp } from "./terminal";

export const ROOT_ENTRY = "index.ts";
export const ROOT_MCP = ".mcp.json";
export const ROOT_SKILLS = "skills";
/** The root's MCP server name (see the header); the generator's own is `ai-memory`. */
export const ROOT_SERVER = "ompdesk-memory";
const GENERATED_SERVER = "ai-memory";
const SWAP_ATTEMPTS = 6;
const SWAP_WAIT_MS = 250;

/** Runs `ai-memory <args>`; `ok` is a zero exit. */
export type RunAiMemory = (args: string[]) => Promise<{ ok: boolean; cancelled: boolean; output: string }>;

/** Every file below `dir` with a digest of its bytes, as `relative/path → sha256`. */
async function digest(dir: string, prefix = ""): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const name = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) Object.assign(out, await digest(join(dir, entry.name), name));
		else if (entry.isFile()) {
			out[name] = createHash("sha256")
				.update(await readFile(join(dir, entry.name)))
				.digest("hex");
		}
	}
	return out;
}

/** The root holds all three generated parts: the extension, the memory MCP entry and at least one skill. */
export async function rootComplete(root: string): Promise<boolean> {
	const present = await Promise.all([
		stat(join(root, ROOT_ENTRY)).then(
			info => info.isFile(),
			() => false,
		),
		readMcp(join(root, ROOT_MCP)).then(
			config => config?.mcpServers !== undefined && ROOT_SERVER in config.mcpServers,
		),
		readdir(join(root, ROOT_SKILLS)).then(
			names => names.length > 0,
			() => false,
		),
	]);
	return present.every(Boolean);
}

/** The generated MCP entry, under OMPdesk's own server name, as the hub's memory route. */
async function mountHub(next: string): Promise<void> {
	const file = join(next, ROOT_MCP);
	const config = await readMcp(file);
	if (!config?.mcpServers || !(GENERATED_SERVER in config.mcpServers)) return;
	const others = { ...config.mcpServers };
	Reflect.deleteProperty(others, GENERATED_SERVER);
	config.mcpServers = { [ROOT_SERVER]: MEMORY_HUB_ENTRY, ...others };
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

async function replaceDir(next: string, root: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rm(root, { recursive: true, force: true });
			await rename(next, root);
			return;
		} catch (error) {
			// Windows: an omp that just started may still hold a file of the old root for a moment.
			if (attempt >= SWAP_ATTEMPTS) throw error;
			await sleep(SWAP_WAIT_MS);
		}
	}
}

/**
 * Generate the root with ai-memory's own commands and put it in place. Returns false when the run was cancelled.
 * Throws with the failing command's last output when a generator fails or leaves the root incomplete.
 */
export async function generateRoot(
	root: string,
	run: RunAiMemory,
	describe: (output: string) => string,
): Promise<boolean> {
	const next = `${root}.next`;
	await rm(next, { recursive: true, force: true });
	await mkdir(next, { recursive: true });
	try {
		const steps: [string, string[]][] = [
			["install-hooks", ["install-hooks", "--agent", "omp", "--apply", "--config-file", join(next, ROOT_ENTRY)]],
			["install-mcp", ["install-mcp", "--client", "omp", "--apply", "--config-file", join(next, ROOT_MCP)]],
			["install-skills", ["install-skills", "--target-dir", join(next, ROOT_SKILLS)]],
		];
		for (const [name, args] of steps) {
			const result = await run(args);
			if (result.cancelled) return false;
			if (!result.ok) throw new Error(`${name} failed: ${describe(result.output) || "no output"}`);
		}
		// Neither command's backups nor anything else but the three parts may end up in the root.
		for (const entry of await readdir(next)) {
			if (entry !== ROOT_ENTRY && entry !== ROOT_MCP && entry !== ROOT_SKILLS) {
				await rm(join(next, entry), { recursive: true, force: true });
			}
		}
		await mountHub(next);
		if (!(await rootComplete(next))) throw new Error("ai-memory's generators left the extension root incomplete");
		const [fresh, current] = await Promise.all([digest(next), digest(root)]);
		if (JSON.stringify(Object.entries(fresh).sort()) === JSON.stringify(Object.entries(current).sort())) return true;
		await mkdir(join(root, ".."), { recursive: true });
		await replaceDir(next, root);
		return true;
	} finally {
		await rm(next, { recursive: true, force: true }).catch(() => undefined);
	}
}
