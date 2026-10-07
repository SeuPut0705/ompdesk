import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyAgentDraft, parseAgentMarkdown, serializeAgentMarkdown } from "../../shared/agent-definition";
import { AGENT_TEMPLATES } from "../../shared/agent-templates";
import {
	type AgentDirs,
	deleteAgentFile,
	installAgentTemplates,
	locateAgentFile,
	readAgentFile,
	writeAgentFile,
} from "./agent-files";

function agent(name: string, body = "Do the thing."): string {
	return serializeAgentMarkdown({ ...emptyAgentDraft(), name, description: `${name} agent`, instructions: body });
}

let root: string;
let dirs: AgentDirs;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "seucode-agent-files-"));
	dirs = {
		user: path.join(root, "home", ".omp", "agent", "agents"),
		project: path.join(root, "repo", ".omp", "agents"),
	};
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("writeAgentFile", () => {
	it("creates <dir>/<name>.md (and the directory) without temp leftovers", async () => {
		const result = await writeAgentFile(dirs, { scope: "project", name: "helper", content: agent("helper") });
		expect(result.filePath).toBe(path.join(dirs.project, "helper.md"));
		expect(await readFile(result.filePath, "utf8")).toBe(agent("helper"));
		expect(await readdir(dirs.project)).toEqual(["helper.md"]);
	});

	it("never replaces another agent's file", async () => {
		await writeAgentFile(dirs, { scope: "user", name: "helper", content: agent("helper", "first") });
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "helper", content: agent("helper", "second") }),
		).rejects.toMatchObject({ code: "exists" });
		expect(await readFile(path.join(dirs.user, "helper.md"), "utf8")).toContain("first");
		expect(await readdir(dirs.user)).toEqual(["helper.md"]);
	});

	it("overwrites the file being edited in place", async () => {
		const { filePath } = await writeAgentFile(dirs, { scope: "user", name: "helper", content: agent("helper") });
		await writeAgentFile(dirs, {
			scope: "user",
			name: "helper",
			content: agent("helper", "edited"),
			replacePath: filePath,
		});
		expect(await readFile(filePath, "utf8")).toContain("edited");
	});

	it("renames and moves between scopes by writing the new file, then removing the old one", async () => {
		const { filePath } = await writeAgentFile(dirs, { scope: "user", name: "helper", content: agent("helper") });
		const renamed = await writeAgentFile(dirs, {
			scope: "project",
			name: "helper2",
			content: agent("helper2"),
			replacePath: filePath,
		});
		expect(renamed.filePath).toBe(path.join(dirs.project, "helper2.md"));
		expect(await readdir(dirs.user)).toEqual([]);
	});

	it("refuses names that are reserved, malformed or traverse paths", async () => {
		for (const name of ["main", "../escape", "a/b", "", ".hidden"]) {
			await expect(writeAgentFile(dirs, { scope: "user", name, content: agent("x") })).rejects.toMatchObject({
				code: "invalid_name",
			});
		}
		await expect(writeAgentFile(dirs, { scope: "elsewhere", name: "x", content: agent("x") })).rejects.toMatchObject({
			code: "invalid_scope",
		});
	});

	it("refuses content omp would not load as this agent", async () => {
		await expect(writeAgentFile(dirs, { scope: "user", name: "x", content: agent("y") })).rejects.toMatchObject({
			code: "invalid_content",
		});
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "x", content: "---\nname: x\n---\nno description" }),
		).rejects.toMatchObject({ code: "invalid_content" });
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "x", content: "---\nname: [x\n---\nbroken" }),
		).rejects.toMatchObject({ code: "invalid_content" });
	});

	it("refuses a replacePath outside the agent directories", async () => {
		const outside = path.join(root, "outside.md");
		await writeFile(outside, agent("x"));
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "x", content: agent("x"), replacePath: outside }),
		).rejects.toMatchObject({ code: "path_outside" });
		expect(await readFile(outside, "utf8")).toBe(agent("x"));
	});
});

describe("locate / read / delete", () => {
	it("accepts only direct *.md children of the two directories", async () => {
		await mkdir(path.join(dirs.user, "nested"), { recursive: true });
		const cases = [
			path.join(dirs.user, "nested", "a.md"),
			path.join(dirs.user, "..", "agents-evil", "a.md"),
			path.join(dirs.user, "a.txt"),
			"relative/a.md",
			path.join(root, "a.md"),
		];
		for (const filePath of cases) {
			await expect(locateAgentFile(dirs, filePath)).rejects.toMatchObject({ code: "path_outside" });
		}
		expect(await locateAgentFile(dirs, path.join(dirs.project, "a.md"))).toEqual({
			file: path.join(dirs.project, "a.md"),
			scope: "project",
		});
	});

	it("resolves a symlinked agents directory to its real path", async () => {
		const real = path.join(root, "dotfiles", "agents");
		await mkdir(real, { recursive: true });
		await mkdir(path.dirname(dirs.user), { recursive: true });
		await symlink(real, dirs.user);
		await writeFile(path.join(real, "a.md"), agent("a"));
		const file = await readAgentFile(dirs, path.join(real, "a.md"));
		expect(file.scope).toBe("user");
	});

	it("reads and deletes inside, refuses outside", async () => {
		const { filePath } = await writeAgentFile(dirs, { scope: "project", name: "gone", content: agent("gone") });
		expect((await readAgentFile(dirs, filePath)).content).toBe(agent("gone"));
		await deleteAgentFile(dirs, filePath);
		expect(await readdir(dirs.project)).toEqual([]);
		const outside = path.join(root, "keep.md");
		await writeFile(outside, "keep");
		await expect(deleteAgentFile(dirs, outside)).rejects.toMatchObject({ code: "path_outside" });
		expect(await readFile(outside, "utf8")).toBe("keep");
	});
});

describe("installAgentTemplates", () => {
	it("writes every template once and leaves existing files untouched", async () => {
		await mkdir(dirs.user, { recursive: true });
		const mine = path.join(dirs.user, "debugger.md");
		await writeFile(mine, agent("debugger", "my own debugger"));

		const first = await installAgentTemplates(dirs.user);
		expect(first.skipped).toEqual(["debugger"]);
		expect(first.installed).toHaveLength(AGENT_TEMPLATES.length - 1);
		expect(await readFile(mine, "utf8")).toContain("my own debugger");

		const second = await installAgentTemplates(dirs.user);
		expect(second.installed).toEqual([]);
		expect(second.skipped).toHaveLength(AGENT_TEMPLATES.length);

		for (const template of AGENT_TEMPLATES.filter(entry => entry.name !== "debugger")) {
			const { draft, error } = parseAgentMarkdown(
				await readFile(path.join(dirs.user, `${template.name}.md`), "utf8"),
			);
			expect(error).toBeUndefined();
			expect(draft.name).toBe(template.name);
			expect(draft.tools).toEqual(template.tools);
		}
	});

	it("installs a named subset", async () => {
		const result = await installAgentTemplates(dirs.project, ["frontend", "nope"]);
		expect(result.installed).toEqual(["frontend"]);
		expect(await readdir(dirs.project)).toEqual(["frontend.md"]);
	});
});
