import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_HUB_ENTRY } from "../../../resources/gui-bridge/mcp-hub-contracts";
import { RM_TEMP } from "../test-fake-omp";
import { generateRoot, ROOT_SERVER, type RunAiMemory, rootComplete } from "./root";

let base: string;
let root: string;
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "ai-memory-root-"));
	root = join(base, "ai-memory", "omp-ext");
});
afterEach(async () => {
	await rm(base, RM_TEMP);
});

const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";

/** Stands in for ai-memory's three generators: each writes only the file its flag names, as the real ones do. */
function generators(options: { skip?: string; stray?: boolean; version?: string; entry?: object } = {}): {
	run: RunAiMemory;
	calls: string[][];
} {
	const calls: string[][] = [];
	const run: RunAiMemory = async args => {
		calls.push(args);
		const write = async (file: string, text: string) => {
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, text);
		};
		if (args[0] === options.skip) return { ok: false, cancelled: false, output: "boom" };
		if (args[0] === "install-hooks") {
			await write(arg(args, "--config-file"), `// ext ${options.version ?? "1"}\n`);
			if (options.stray) await write(`${arg(args, "--config-file")}.bak-123`, "backup");
		}
		if (args[0] === "install-mcp") {
			const entry = options.entry ?? {};
			await write(arg(args, "--config-file"), JSON.stringify({ mcpServers: { "ai-memory": entry } }));
		}
		if (args[0] === "install-skills")
			await write(join(arg(args, "--target-dir"), "ai-memory-handoff", "SKILL.md"), "s");
		return { ok: true, cancelled: false, output: "" };
	};
	return { run, calls };
}

describe("generateRoot", () => {
	it("runs ai-memory's three generators into a sibling folder and swaps it in", async () => {
		const { run, calls } = generators();
		expect(await generateRoot(root, run, text => text)).toBe(true);
		expect(calls.map(call => call[0])).toEqual(["install-hooks", "install-mcp", "install-skills"]);
		for (const call of calls) expect(call.join(" ")).toContain(`${root}.next`);
		expect(await readdir(root)).toEqual([".mcp.json", "index.ts", "skills"].sort());
		expect(await rootComplete(root)).toBe(true);
		expect(existsSync(`${root}.next`)).toBe(false);
	});

	it("an unchanged result leaves the files where they are (no churn, no backups)", async () => {
		const { run } = generators();
		await generateRoot(root, run, text => text);
		const first = (await stat(join(root, "index.ts"))).ino;
		await generateRoot(root, run, text => text);
		expect((await stat(join(root, "index.ts"))).ino).toBe(first);
	});

	it("a changed result replaces the root whole", async () => {
		await generateRoot(root, generators({ version: "1" }).run, text => text);
		await generateRoot(root, generators({ version: "2" }).run, text => text);
		expect(await readFile(join(root, "index.ts"), "utf8")).toBe("// ext 2\n");
	});

	it("keeps nothing but the three parts: ai-memory's backups never reach the root", async () => {
		await generateRoot(root, generators({ stray: true }).run, text => text);
		expect(await readdir(root)).toEqual([".mcp.json", "index.ts", "skills"].sort());
	});

	it("a failing generator throws with its name and output and leaves an earlier root alone", async () => {
		await generateRoot(root, generators({ version: "1" }).run, text => text);
		await expect(generateRoot(root, generators({ skip: "install-skills" }).run, text => `<${text}>`)).rejects.toThrow(
			"install-skills failed: <boom>",
		);
		expect(await readFile(join(root, "index.ts"), "utf8")).toBe("// ext 1\n");
		expect(existsSync(`${root}.next`)).toBe(false);
	});

	it("a cancelled command returns false and writes nothing", async () => {
		const run: RunAiMemory = async () => ({ ok: false, cancelled: true, output: "" });
		expect(await generateRoot(root, run, text => text)).toBe(false);
		expect(existsSync(root)).toBe(false);
		expect(existsSync(`${root}.next`)).toBe(false);
	});

	it("names the MCP server ompdesk-memory, so an ai-memory entry in omp's agent dir cannot take the name", async () => {
		await generateRoot(
			root,
			generators({ entry: { command: "/bin/ai-memory", args: ["mcp-bridge"] } }).run,
			text => text,
		);
		const servers = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers;
		expect(Object.keys(servers)).toEqual([ROOT_SERVER]);
		expect(ROOT_SERVER).toBe("ompdesk-memory");
	});

	it("serves the entry from OMPdesk's MCP hub, whatever the generator wrote, and starts no helper of its own", async () => {
		for (const entry of [
			{ type: "stdio", command: "/bin/ai-memory", args: ["mcp-bridge", "--no-session-id"], enabled: true },
			{ url: "http://127.0.0.1:1/mcp" },
		]) {
			await generateRoot(root, generators({ entry }).run, text => text);
			const servers = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers;
			// The names stock expands from every omp's env (`expandEnvVarsDeep`); main sets them at each spawn.
			expect(servers[ROOT_SERVER]).toEqual({
				type: "http",
				url: `${"$"}{OMP_GUI_MCP_HUB}/memory`,
				headers: { Authorization: `${"$"}{OMP_GUI_MCP_AUTH}` },
			});
			expect(servers[ROOT_SERVER]).toEqual(MEMORY_HUB_ENTRY);
			expect((await readdir(root)).sort()).toEqual([".mcp.json", "index.ts", "skills"]);
			expect(await rootComplete(root)).toBe(true);
		}
	});

	it("an unchanged generator output leaves the hub entry's file where it is", async () => {
		const { run } = generators({ entry: { command: "/bin/ai-memory", args: ["mcp-bridge"] } });
		await generateRoot(root, run, text => text);
		const first = (await stat(join(root, ".mcp.json"))).ino;
		await generateRoot(root, run, text => text);
		expect((await stat(join(root, ".mcp.json"))).ino).toBe(first);
	});
});
