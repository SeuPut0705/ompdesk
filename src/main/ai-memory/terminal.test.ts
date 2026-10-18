import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import {
	EXTENSION_FILE,
	GENERATED_HEADER,
	legacyOwned,
	listSharedSkills,
	MCP_FILE,
	readTerminalWiring,
	removeNewSharedSkills,
	removeTerminalWiring,
	withinPath,
} from "./terminal";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ai-memory-terminal-"));
});
afterEach(async () => {
	await rm(root, RM_TEMP);
});

describe("readTerminalWiring", () => {
	it("an empty dir has nothing", async () => {
		expect(await readTerminalWiring(root)).toEqual({ extension: false, mcp: false, command: null });
	});

	it("reads the generated extension by its header and the ai-memory entry by its command", async () => {
		await mkdir(join(root, "extensions"), { recursive: true });
		await writeFile(join(root, EXTENSION_FILE), `${GENERATED_HEADER} --apply\`.\n`);
		await writeFile(
			join(root, MCP_FILE),
			JSON.stringify({ mcpServers: { "ai-memory": { command: "/x/ai-memory.exe", args: ["mcp-bridge"] } } }),
		);
		expect(await readTerminalWiring(root)).toEqual({ extension: true, mcp: true, command: "/x/ai-memory.exe" });
	});

	it("a same-named file or entry that is not ai-memory's does not count", async () => {
		await mkdir(join(root, "extensions"), { recursive: true });
		await writeFile(join(root, EXTENSION_FILE), "// mine\n");
		await writeFile(join(root, MCP_FILE), JSON.stringify({ mcpServers: { "ai-memory": { command: "node" } } }));
		expect(await readTerminalWiring(root)).toEqual({ extension: false, mcp: false, command: null });
	});

	it("an http entry on the /mcp endpoint is ai-memory's", async () => {
		await writeFile(
			join(root, MCP_FILE),
			JSON.stringify({ mcpServers: { "ai-memory": { url: "http://127.0.0.1:49374/mcp" } } }),
		);
		expect(await readTerminalWiring(root)).toMatchObject({ mcp: true, command: null });
	});

	it("a broken mcp.json is read as no entry and never rewritten", async () => {
		await writeFile(join(root, MCP_FILE), "{broken");
		expect((await readTerminalWiring(root)).mcp).toBe(false);
		await removeTerminalWiring(root);
		expect(await readFile(join(root, MCP_FILE), "utf8")).toBe("{broken");
	});
});

describe("withinPath and legacyOwned", () => {
	it("is the path itself or inside it, in either separator and any case", () => {
		expect(withinPath("/t/ai-memory/3.1.1/ai-memory", "/t/ai-memory")).toBe(true);
		expect(withinPath("/t/ai-memory", "/t/ai-memory")).toBe(true);
		expect(withinPath("/t/ai-memory-other/x", "/t/ai-memory")).toBe(false);
		expect(withinPath(String.raw`C:\Tools\AI-Memory\3.1.1\ai-memory.exe`, "c:/tools/ai-memory")).toBe(true);
	});

	it("needs an MCP entry whose command lies in an owned path", () => {
		const wiring = { extension: true, mcp: true, command: "/t/ai-memory/3.1.1/ai-memory" };
		expect(legacyOwned(wiring, ["/t/ai-memory"])).toBe(true);
		expect(legacyOwned(wiring, ["/elsewhere"])).toBe(false);
		expect(legacyOwned({ ...wiring, mcp: false }, ["/t/ai-memory"])).toBe(false);
		expect(legacyOwned({ ...wiring, command: null }, ["/t/ai-memory"])).toBe(false);
	});
});

describe("removeNewSharedSkills", () => {
	it("removes only the managed skills that were not there before, and the folders it leaves empty", async () => {
		const skills = join(root, ".agents", "skills");
		const managed = (name: string) => writeFile(join(skills, name, "SKILL.md"), "<!-- ai-memory-managed: x -->\n");
		await mkdir(join(skills, "ai-memory-old"), { recursive: true });
		await managed("ai-memory-old");
		const before = await listSharedSkills(root);
		await mkdir(join(skills, "ai-memory-new"), { recursive: true });
		await managed("ai-memory-new");
		await mkdir(join(skills, "ai-memory-theirs"), { recursive: true });
		await writeFile(join(skills, "ai-memory-theirs", "SKILL.md"), "no marker: a user's own skill\n");
		await removeNewSharedSkills(root, before);
		expect(existsSync(join(skills, "ai-memory-old"))).toBe(true);
		expect(existsSync(join(skills, "ai-memory-new"))).toBe(false);
		expect(existsSync(join(skills, "ai-memory-theirs"))).toBe(true);
	});

	it("an .agents/skills that ai-memory created and nothing else uses goes away", async () => {
		const before = await listSharedSkills(root);
		const skill = join(root, ".agents", "skills", "ai-memory-new");
		await mkdir(skill, { recursive: true });
		await writeFile(join(skill, "SKILL.md"), "<!-- ai-memory-managed: x -->\n");
		await removeNewSharedSkills(root, before);
		expect(existsSync(join(root, ".agents"))).toBe(false);
	});
});
