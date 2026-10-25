import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import { generateRoot, ROOT_RELAY, type RunAiMemory, rootComplete } from "./root";

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

	describe("with the relay", () => {
		const entry = {
			type: "stdio",
			command: "/bin/ai-memory",
			args: ["mcp-bridge", "--no-session-id"],
			enabled: true,
		};
		let relay: { source: string; command: string };
		beforeEach(async () => {
			relay = { source: join(base, "memory-relay.mjs"), command: "bun" };
			await writeFile(relay.source, "// relay 1\n");
		});
		const mcp = async () => JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers["ai-memory"];

		it("starts ai-memory's own entry through the relay, keeping its command, arguments and other keys", async () => {
			await generateRoot(root, generators({ entry }).run, text => text, relay);
			expect(await mcp()).toEqual({
				type: "stdio",
				command: "bun",
				args: ["$" + "{OMP_PLUGIN_ROOT}/memory-relay.mjs", "/bin/ai-memory", "mcp-bridge", "--no-session-id"],
				enabled: true,
			});
			expect(await readFile(join(root, ROOT_RELAY), "utf8")).toBe("// relay 1\n");
			expect(await readdir(root)).toEqual([".mcp.json", "index.ts", "memory-relay.mjs", "skills"].sort());
		});

		it("is complete only while the relay file is there", async () => {
			await generateRoot(root, generators({ entry }).run, text => text, relay);
			expect(await rootComplete(root)).toBe(true);
			await rm(join(root, ROOT_RELAY));
			expect(await rootComplete(root)).toBe(false);
		});

		it("leaves an unchanged root alone and swaps in a new relay", async () => {
			const { run } = generators({ entry });
			await generateRoot(root, run, text => text, relay);
			const first = (await stat(join(root, ROOT_RELAY))).ino;
			await generateRoot(root, run, text => text, relay);
			expect((await stat(join(root, ROOT_RELAY))).ino).toBe(first);
			await writeFile(relay.source, "// relay 2\n");
			await generateRoot(root, run, text => text, relay);
			expect(await readFile(join(root, ROOT_RELAY), "utf8")).toBe("// relay 2\n");
		});

		it("takes the runtime from the caller, so a missing Bun on Windows is a path, not a PATH lookup", async () => {
			await generateRoot(root, generators({ entry }).run, text => text, { ...relay, command: "C:\\Bun\\bun.exe" });
			expect((await mcp()).command).toBe("C:\\Bun\\bun.exe");
		});

		it("leaves an entry that is not a stdio command as ai-memory wrote it, with no relay file", async () => {
			await generateRoot(root, generators({ entry: { url: "http://127.0.0.1:1/mcp" } }).run, text => text, relay);
			expect(await mcp()).toEqual({ url: "http://127.0.0.1:1/mcp" });
			expect(existsSync(join(root, ROOT_RELAY))).toBe(false);
			expect(await rootComplete(root)).toBe(true);
		});
	});
});
