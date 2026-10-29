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
 * `.bak-<timestamp>` backups never pile up inside the root. OMPdesk adds two things to the generated MCP entry
 * (`ai-memory mcp-bridge …`). It is named `ompdesk-memory`, not the generator's `ai-memory`: omp dedupes MCP servers
 * by name and ranks the agent dir over a package root, so an `ai-memory` entry the person wired there would take
 * the name and OMPdesk's own would never mount (the tools are `mcp__ompdesk_memory_*` as a result; every tool's own
 * name and schema stay the server's). And it is started through `memory-relay.mjs`
 * (`resources/omp-builtin/ai-memory/`, copied into the root), which adds route summaries without changing tool names,
 * schemas or metadata. The upstream scope and trust instructions stay intact. The entry's own command and arguments
 * follow the relay's, unchanged.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readMcp } from "./terminal";

export const ROOT_ENTRY = "index.ts";
export const ROOT_MCP = ".mcp.json";
export const ROOT_SKILLS = "skills";
export const ROOT_RELAY = "memory-relay.mjs";
/** The root's MCP server name (see the header); the generator's own is `ai-memory`. */
export const ROOT_SERVER = "ompdesk-memory";
const GENERATED_SERVER = "ai-memory";
/** omp substitutes this in a package root's `.mcp.json` (as `resources/omp-builtin/rea/.mcp.json` relies on). */
const RELAY_ARG = `\${OMP_PLUGIN_ROOT}/${ROOT_RELAY}`;

/** The relay OMPdesk starts the generated MCP entry through: its source file and the runtime that runs it. */
export interface MemoryRelay {
	source: string;
	command: string;
}
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

/**
 * The root holds all three generated parts: the extension, an `ai-memory` MCP entry and at least one skill. An entry
 * that starts through the relay needs the relay's file beside it, or the server would never come up.
 */
export async function rootComplete(root: string): Promise<boolean> {
	const present = await Promise.all([
		stat(join(root, ROOT_ENTRY)).then(
			info => info.isFile(),
			() => false,
		),
		readMcp(join(root, ROOT_MCP)).then(async config => {
			if (config?.mcpServers === undefined || !(ROOT_SERVER in config.mcpServers)) return false;
			const args = (config.mcpServers[ROOT_SERVER] as { args?: unknown } | null)?.args;
			if (!Array.isArray(args) || args[0] !== RELAY_ARG) return true;
			return stat(join(root, ROOT_RELAY)).then(
				info => info.isFile(),
				() => false,
			);
		}),
		readdir(join(root, ROOT_SKILLS)).then(
			names => names.length > 0,
			() => false,
		),
	]);
	return present.every(Boolean);
}

/** Give the generated MCP entry OMPdesk's own server name. */
async function nameServer(next: string): Promise<void> {
	const file = join(next, ROOT_MCP);
	const config = await readMcp(file);
	if (!config?.mcpServers || !(GENERATED_SERVER in config.mcpServers)) return;
	const { [GENERATED_SERVER]: entry, ...others } = config.mcpServers;
	config.mcpServers = { [ROOT_SERVER]: entry, ...others };
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Start the MCP entry through the relay: `<runtime> <root>/memory-relay.mjs <command> <args…>`. An entry that is not a
 * stdio command (a future generator writing a URL) is left as it is, with no relay file.
 */
async function mountRelay(next: string, relay: MemoryRelay): Promise<void> {
	const file = join(next, ROOT_MCP);
	const config = await readMcp(file);
	const entry = config?.mcpServers?.[ROOT_SERVER] as { command?: unknown; args?: unknown } | undefined;
	if (!config?.mcpServers || typeof entry?.command !== "string") return;
	const args = Array.isArray(entry.args) ? entry.args : [];
	config.mcpServers[ROOT_SERVER] = { ...entry, command: relay.command, args: [RELAY_ARG, entry.command, ...args] };
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
	await copyFile(relay.source, join(next, ROOT_RELAY));
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
	relay?: MemoryRelay,
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
		await nameServer(next);
		if (relay) await mountRelay(next, relay);
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
