import { describe, expect, it } from "vitest";
import type {
	HelperInventory,
	HelperMcpServer,
	HelperPlugin,
} from "../../../resources/gui-bridge/stock-helper/extensions-contracts";
import { REA_VERSION } from "../../shared/builtin-mcp";
import { classifyInventory, projectHash } from "./classify";
import type { McpBinary, McpOwner } from "./mcp-owner";

const REA_ROOT = "/app/resources/omp-builtin";

const empty = (over: Partial<HelperInventory> = {}): HelperInventory => ({
	marketplaces: [],
	plugins: [],
	registrySkills: [],
	pluginSkills: 0,
	localSkills: 0,
	mcpServers: [],
	...over,
});

const plugin = (over: Partial<HelperPlugin>): HelperPlugin => ({
	channel: "marketplace",
	id: "tools@official",
	scope: "user",
	cwd: null,
	installed: "1.0.0",
	spec: null,
	enabled: true,
	...over,
});

const server = (
	name: string,
	command: string | null,
	args: string[] = [],
	over: Partial<HelperMcpServer> = {},
): HelperMcpServer => ({
	name,
	type: "stdio",
	command,
	args,
	url: null,
	enabled: true,
	sourcePath: "/home/u/.omp/agent/mcp.json",
	origin: "user",
	...over,
});

function binary(owner: McpOwner | null, over: Partial<McpBinary> = {}): McpBinary {
	return {
		command: "thing",
		path: "/p/bin/thing",
		real: "/p/lib/thing",
		owner,
		skip: null,
		installed: "1.0.0",
		script: true,
		...over,
	};
}

const classify = (inventory: HelperInventory, binaries: Record<string, McpBinary | null> = {}, reaEnabled = false) =>
	classifyInventory(inventory, { reaRoot: REA_ROOT, reaEnabled, binaries: new Map(Object.entries(binaries)) });

describe("marketplaces", () => {
	it("every marketplace is a catalog row, listed first", () => {
		const seeds = classify(
			empty({
				marketplaces: [{ name: "official", source: "owner/repo", updatedAt: "2026-01-01T00:00:00Z" }],
				plugins: [plugin({})],
			}),
		);
		expect(seeds.map(seed => seed.row.key)).toEqual(["marketplace:official", "plugin:tools@official:user"]);
		expect(seeds[0]).toEqual({
			row: {
				key: "marketplace:official",
				kind: "marketplace",
				name: "official",
				detail: "owner/repo",
				count: null,
				installed: null,
				method: "catalog",
				skip: null,
			},
			target: { kind: "marketplace", name: "official" },
		});
	});
});

describe("plugins", () => {
	it("the channel picks the method; linked plugins are skipped and never checked", () => {
		const inventory = empty({
			plugins: [
				plugin({ id: "a@official" }),
				plugin({ channel: "npm", id: "npm-plug", spec: "^1.0.0" }),
				plugin({ channel: "git", id: "git-plug", installed: null, spec: "github:o/r" }),
				plugin({ channel: "linked", id: "dev-plug" }),
			],
		});
		const seeds = classify(inventory);
		const by = (id: string) => seeds.find(seed => seed.row.name === id);
		expect(by("a@official")?.row).toMatchObject({
			method: "marketplace",
			skip: null,
			installed: "1.0.0",
			detail: "user",
		});
		expect(by("npm-plug")?.row).toMatchObject({ method: "npm-plugin", skip: null });
		expect(by("git-plug")?.row).toMatchObject({ method: "git-plugin", installed: null });
		expect(by("npm-plug")?.target).toEqual({
			kind: "plugin",
			selector: { channel: "npm", id: "npm-plug", scope: "user", cwd: null },
		});
		expect(by("dev-plug")).toEqual({
			row: expect.objectContaining({ key: "plugin:dev-plug:user", method: null, skip: "linked" }),
			target: { kind: "none" },
		});
	});

	it("a project plugin's key holds a short hash of its folder, never the path", () => {
		const cwd = "/Users/u/work/my-app";
		const seeds = classify(
			empty({
				plugins: [plugin({ scope: "project", cwd }), plugin({ scope: "project", cwd: "C:\\work\\other-app" })],
			}),
		);
		const keys = seeds.map(seed => seed.row.key);
		expect(keys).toContain(`plugin:tools@official:project:${projectHash(cwd)}`);
		expect(keys.some(key => key.includes("work"))).toBe(false);
		expect(seeds.map(seed => seed.row.detail).sort()).toEqual(["my-app", "other-app"]);
		expect(projectHash(cwd)).toMatch(/^[0-9a-f]{8}$/);
		expect(projectHash(cwd)).not.toBe(projectHash("/Users/u/work/other"));
	});
});

describe("skills", () => {
	it("registry skills are rows; an exact range is pinned", () => {
		const seeds = classify(
			empty({
				registrySkills: [
					{ id: "@s/a", scope: "user", cwd: null, range: "^1.0.0", installed: "1.0.1" },
					{ id: "@s/b", scope: "user", cwd: null, range: "2.0.0", installed: "2.0.0" },
					{ id: "@s/c", scope: "project", cwd: "/w/proj", range: "latest", installed: null },
				],
			}),
		);
		expect(seeds.find(seed => seed.row.name === "@s/a")).toMatchObject({
			row: { key: "skill:@s/a:user", method: "registry", skip: null, installed: "1.0.1" },
			target: { kind: "skill", selector: { id: "@s/a", scope: "user", cwd: null } },
		});
		expect(seeds.find(seed => seed.row.name === "@s/b")?.row).toMatchObject({ method: "registry", skip: "pinned" });
		expect(seeds.find(seed => seed.row.name === "@s/c")?.row).toMatchObject({
			key: `skill:@s/c:project:${projectHash("/w/proj")}`,
			detail: "proj",
		});
	});

	it("plugin skills and local skills are two grouped rows with their counts", () => {
		const seeds = classify(empty({ pluginSkills: 4, localSkills: 2 }));
		expect(seeds.map(seed => seed.row)).toEqual([
			expect.objectContaining({ key: "skill:local", count: 2, method: null, skip: "local" }),
			expect.objectContaining({ key: "skill:plugin", count: 4, method: null, skip: "follows-plugin" }),
		]);
		expect(classify(empty())).toEqual([]);
	});
});

describe("MCP servers", () => {
	const mcp = (servers: HelperMcpServer[], binaries: Record<string, McpBinary | null> = {}) =>
		classify(empty({ mcpServers: servers }), binaries);

	it("the built-in REA, in the helper's list or added from the app's own knowledge", () => {
		const fromHelper = mcp([server("rea", "node", ["x"], { sourcePath: `${REA_ROOT}/.mcp.json` })]);
		expect(fromHelper[0]?.row).toMatchObject({
			key: "mcp:rea",
			skip: "builtin",
			method: null,
			installed: REA_VERSION,
		});
		expect(classify(empty(), {}, true).map(seed => seed.row)).toEqual([
			expect.objectContaining({ key: "mcp:rea", skip: "builtin", installed: REA_VERSION }),
		]);
		// Off in this app: not listed. Also named by the user's own server: not doubled.
		expect(classify(empty(), {}, false)).toEqual([]);
		const named = classify(empty({ mcpServers: [server("rea", "my-rea")] }), { rea: null }, true);
		expect(named.map(seed => seed.row.key)).toEqual(["mcp:rea"]);
		expect(named[0]?.row.skip).toBe("unknown-install");
	});

	it("a remote URL is skipped and its URL is never shown", () => {
		const seeds = mcp([server("hosted", null, [], { type: "http", url: "https://x.test/mcp?token=secret" })]);
		expect(seeds[0]).toEqual({
			row: expect.objectContaining({ key: "mcp:hosted", skip: "remote", method: null, detail: null }),
			target: { kind: "none" },
		});
	});

	it("an unpinned runner follows latest: no method, no check", () => {
		for (const [command, args] of [
			["npx", ["-y", "pkg"]],
			["npx", ["-y", "pkg@latest"]],
			["bunx", ["pkg"]],
			["uvx", ["pkg"]],
			["pnpm", ["dlx", "pkg"]],
		] as const) {
			const [seed] = mcp([server("s", command, [...args])]);
			expect(seed?.row, command).toMatchObject({ skip: "follows-latest", method: null });
			expect(seed?.target).toEqual({ kind: "none" });
		}
	});

	it("a pinned runner keeps its method for the check and is skipped as pinned", () => {
		const [npx] = mcp([server("s", "npx", ["-y", "@scope/pkg@1.2.3"])]);
		expect(npx?.row).toEqual({
			key: "mcp:s",
			kind: "mcp",
			name: "s",
			detail: "@scope/pkg@1.2.3",
			count: null,
			installed: "1.2.3",
			method: "npm",
			skip: "pinned",
		});
		expect(npx?.target).toMatchObject({ kind: "runner", runner: { pkg: "@scope/pkg", version: "1.2.3" } });
		expect(mcp([server("s", "bunx", ["pkg@2.0.0"])])[0]?.row).toMatchObject({ method: "bun", skip: "pinned" });
		expect(mcp([server("s", "uvx", ["pkg==3.0.0"])])[0]?.row).toMatchObject({
			method: "uv",
			installed: "3.0.0",
			skip: "pinned",
		});
		expect(mcp([server("s", "pipx", ["run", "pkg==3.0.0"])])[0]?.row).toMatchObject({ method: "pipx" });
		// A range or a tag is the user's pin too, with no exact version to show.
		const [range] = mcp([server("s", "npx", ["pkg@^1.2.0"])]);
		expect(range?.row).toMatchObject({ skip: "pinned", installed: null, detail: "pkg@^1.2.0" });
		// Nothing to ask for a git URL: listed pinned, never checked.
		expect(mcp([server("s", "npx", ["github:o/r#v1"])])[0]).toMatchObject({
			row: { skip: "pinned" },
			target: { kind: "none" },
		});
	});

	it("a direct command is owned by what its binary resolves to", () => {
		const owners: Exclude<McpOwner, { method: "winget" | "managed" | "self" }>[] = [
			{ method: "npm", name: "@s/pkg", prefix: "/p", root: "/p/lib/node_modules/@s/pkg" },
			{ method: "bun", name: "pkg", bunRoot: "/b", root: "/b/install/global/node_modules/pkg" },
			{ method: "brew", name: "thing", brew: "/opt/homebrew/bin/brew" },
			{ method: "pipx", name: "thing", venv: "/h/pipx/venvs/thing" },
			{ method: "uv", name: "thing", dir: "/h/uv/tools/thing" },
			{ method: "pip", name: "dist", python: "/py/python3" },
		];
		for (const owner of owners) {
			const found = binary(owner);
			const [seed] = mcp([server("s", "thing")], { s: found });
			expect(seed?.row, owner.method).toMatchObject({
				method: owner.method,
				skip: null,
				installed: "1.0.0",
				detail: owner.name,
			});
			expect(seed?.target).toEqual({ kind: "binary", command: "thing", binary: found, owner });
		}
	});

	it("system, bundled, admin-only, unknown and missing binaries are skipped with their reason", () => {
		for (const skip of ["system", "bundled", "not-writable", "unknown-install"] as const) {
			const [seed] = mcp([server("s", "/x/thing")], { s: binary(null, { skip }) });
			expect(seed, skip).toEqual({
				row: expect.objectContaining({ skip, method: null, detail: "thing", installed: "1.0.0" }),
				target: { kind: "none" },
			});
		}
		expect(mcp([server("s", "gone")], { s: null })[0]?.row).toMatchObject({
			skip: "unknown-install",
			detail: "gone",
		});
		expect(mcp([server("s", "gone")])[0]?.row).toMatchObject({ skip: "unknown-install" });
		// An interpreter running a script is not a package.
		expect(mcp([server("s", "node", ["server.js"])])[0]?.row).toMatchObject({
			skip: "unknown-install",
			detail: "node",
		});
	});

	it("a disabled server is listed but not checked", () => {
		const owner: McpOwner = { method: "npm", name: "pkg", prefix: "/p", root: "/p/lib/node_modules/pkg" };
		const [direct] = mcp([server("s", "thing", [], { enabled: false })], { s: binary(owner) });
		expect(direct).toMatchObject({ row: { method: "npm", skip: null }, target: { kind: "none" } });
		const [runner] = mcp([server("s", "npx", ["pkg@1.0.0"], { enabled: false })]);
		expect(runner).toMatchObject({ row: { skip: "pinned" }, target: { kind: "none" } });
	});
});

describe("order", () => {
	it("kinds in display order, then by name", () => {
		const seeds = classify(
			empty({
				marketplaces: [{ name: "m", source: "s", updatedAt: "" }],
				plugins: [plugin({ id: "z@m" }), plugin({ id: "a@m" })],
				registrySkills: [{ id: "@s/k", scope: "user", cwd: null, range: null, installed: null }],
				mcpServers: [server("b", "npx", ["p@1.0.0"]), server("a", "npx", ["p"])],
			}),
		);
		expect(seeds.map(seed => seed.row.key)).toEqual([
			"marketplace:m",
			"plugin:a@m:user",
			"plugin:z@m:user",
			"skill:@s/k:user",
			"mcp:a",
			"mcp:b",
		]);
	});
});
