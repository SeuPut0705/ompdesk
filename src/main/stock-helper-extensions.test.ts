/**
 * The stock helper's `extensions` worker (resources/gui-bridge/stock-helper/extensions.ts), spawned the way
 * main spawns it (`host.ts extensions` with OMP_PACKAGE_ROOT). A fake install (stand-in modules at the
 * specifiers the worker imports) checks the shaping and the decisions OMPdesk adds on top of stock: what the
 * inventory leaves out, which plugins and skills count as pinned, what an upgrade refuses, how the activation
 * and a skill that needs approval reach the answer. The real omp, when this machine has one, runs the whole
 * path in a throwaway HOME / agent dir against a local-path marketplace, a fake npm registry and a fake skills
 * registry: nothing of the user's own omp is read or written.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type {
	HelperInventory,
	PluginCheckResult,
	PluginSelector,
	PluginUpgradeResult,
	SkillCheckResult,
	SkillUpdateResult,
} from "../../resources/gui-bridge/stock-helper/extensions-contracts";
import { type NpmRegistry, npmRegistry } from "./test-npm-registry";
import { type SkillsRegistry, skillsRegistry } from "./test-skills-registry";

const HOST = path.resolve("resources/gui-bridge/stock-helper/host.ts");
const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
const registries: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
	// Windows keeps a running worker's files (the loaded natives addon) locked: wait for the exit before the rm.
	await Promise.all(
		children.splice(0).map(child => {
			if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			child.once("exit", () => resolve());
			child.kill();
			return promise;
		}),
	);
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
	await Promise.all(registries.splice(0).map(registry => registry.close()));
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

interface Answer<T> {
	result?: T;
	error?: string;
}

/** One `host.ts extensions` worker; requests go out one at a time, as main's serial lane sends them. */
function startWorker(root: string, env: Record<string, string> = {}) {
	const child = spawn("bun", [HOST, "extensions"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env, OMP_PACKAGE_ROOT: root },
	});
	children.push(child);
	child.stderr.resume();
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	let sequence = 0;
	return {
		async ask<T>(method: string, params: unknown = {}): Promise<Answer<T>> {
			const id = ++sequence;
			child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
			const { value } = await lines.next();
			const answer = JSON.parse(value as string) as { id: number } & Answer<T>;
			expect(answer.id).toBe(id);
			return answer;
		},
	};
}

async function ok<T>(answer: Promise<Answer<T>>): Promise<T> {
	const { result, error } = await answer;
	if (error !== undefined) throw new Error(error);
	return result as T;
}

// ─── The fake install ───────────────────────────────────────────────────────────────────────────────────────

/** What the stand-in modules answer; each test overrides the fields it exercises. Read at call time. */
interface FakeConfig {
	marketplaces: Array<{ name: string; sourceUri: string; updatedAt: string }>;
	userRegistry: string;
	/** Folder → the project registry stock resolves for it (and for everything below it). */
	projectRegistries: Record<string, string>;
	/** Registry path (or `user`) → installed marketplace plugins. */
	installed: Record<string, Array<{ id: string; version: string; enabled?: boolean }>>;
	updates: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>;
	upgradeTo: string;
	/** `PluginManager.list()` and `plugins/package.json` dependencies. */
	plugins: Array<{ name: string; version: string; enabled: boolean }>;
	deps: Record<string, string>;
	/** `getEnabledPlugins` answers, one per call (the last repeats). */
	enabledSnapshots: Array<Array<{ name: string; path: string; version: string; entries?: Record<string, string[]> }>>;
	registryUrl: string;
	skills: Array<{ filePath: string; _source?: { provider: string; pluginName?: string } }>;
	installedSkills: Array<{ id: string; scope: "user" | "project"; range?: string; version?: string }>;
	skillProjects: Record<string, string>;
	skill: { latest: string; within: string; missing?: boolean; scripts?: boolean; unchanged?: boolean };
	userMcpPath: string;
	mcpItems: Array<Record<string, unknown>>;
	mcpActive: Record<string, { type?: string }>;
}

const fakeSources = (dir: string): Record<string, string> => {
	const prelude = `import { appendFileSync, readFileSync } from "node:fs";
const DIR = ${JSON.stringify(dir)};
const cfg = () => JSON.parse(readFileSync(DIR + "/config.json", "utf8"));
const log = (...entry) => appendFileSync(DIR + "/calls.log", JSON.stringify(entry) + "\\n");
`;
	return {
		"extensibility/plugins/marketplace": `${prelude}
export const getInstalledPluginsRegistryPath = () => cfg().userRegistry;
export const getMarketplacesCacheDir = () => DIR + "/cache";
export const getMarketplacesRegistryPath = () => DIR + "/marketplaces.json";
export const getPluginsCacheDir = () => DIR + "/plugins-cache";
export class MarketplaceManager {
	#options;
	constructor(options) { this.#options = options; log("manager", options.projectInstalledRegistryPath ?? null); }
	async listMarketplaces() { return cfg().marketplaces; }
	async updateMarketplace(name) { log("updateMarketplace", name); return { name, updatedAt: "2026-02-02T00:00:00.000Z" }; }
	async listInstalledPlugins() {
		const installed = cfg().installed;
		const summaries = (installed.user ?? []).map(p => ({ id: p.id, scope: "user", entries: [{ version: p.version, enabled: p.enabled }] }));
		const project = this.#options.projectInstalledRegistryPath;
		if (project) summaries.push(...(installed[project] ?? []).map(p => ({ id: p.id, scope: "project", entries: [{ version: p.version, enabled: p.enabled }] })));
		return summaries;
	}
	async checkForUpdates() { return cfg().updates; }
	async upgradePlugin(id, scope) { log("upgradePlugin", id, scope, this.#options.projectInstalledRegistryPath ?? null); return { version: cfg().upgradeTo }; }
}
`,
		"discovery/helpers": `${prelude}
export const clearPluginRootsAndCaches = extra => log("clear", extra ?? null);
export const resolveActiveProjectRegistryPath = async cwd => {
	for (const [dir, registry] of Object.entries(cfg().projectRegistries)) if (cwd === dir || cwd.startsWith(dir + "/")) return registry;
	return null;
};
`,
		"extensibility/plugins/manager": `${prelude}
export class PluginManager {
	constructor(cwd) { log("pluginManager", cwd); }
	async list() { return cfg().plugins; }
	async upgrade(name) { log("upgrade", name); return { from: "1.0.0", plugin: { version: cfg().upgradeTo }, changed: true }; }
}
`,
		"extensibility/plugins/git-url": `export const parseGitUrl = spec => spec.startsWith("github:") ? { ref: spec.split("#")[1] } : null;
`,
		"extensibility/plugins/loader": `${prelude}
let calls = 0;
export const getEnabledPlugins = async cwd => {
	const snapshots = cfg().enabledSnapshots;
	const snapshot = snapshots[Math.min(calls++, snapshots.length - 1)] ?? [];
	log("enabled", cwd);
	return snapshot.map(p => ({ ...p, enabledFeatures: null, manifest: {} }));
};
export const resolvePluginManifestEntries = (plugin, key) => (plugin.entries?.[key] ?? []).map(entry => ({ entry, resolvedPath: entry }));
`,
		"cli/npm-registry": `${prelude}
export const loadNpmRegistryResolver = async () => pkg => ({ url: cfg().registryUrl, authorization: "Bearer TESTTOKEN" });
export const npmRegistryPackageUrl = (registry, pkg) => registry.url + pkg.replace("/", "%2f");
`,
		"config/settings": `${prelude}
export const Settings = { loadReadOnly: async options => { log("settings", options.cwd); return { extensionsSourceLevel: () => "user" }; } };
`,
		"extensibility/settings": `export const cfgSkills = { get: () => ({ customDirectories: ["rel-skills"], enabled: true }) };
export const cfgDisabledExtensions = { get: () => [] };
export const cfgExtensions = { get: () => [] };
`,
		"extensibility/skills": `${prelude}
export const loadSkills = async options => { log("loadSkills", options.cwd, options.customDirectories ?? null); return { skills: cfg().skills, warnings: [] }; };
`,
		discovery: `${prelude}
export const initializeWithSettings = () => { log("hold"); return () => log("release"); };
export const loadCapability = async (id, options) => ({ items: cfg().mcpItems.filter(item => !options.filter || options.filter(item)) });
`,
		"mcp/config": `${prelude}
export const loadAllMCPConfigs = async (cwd, options) => { log("loadAllMCPConfigs", cwd, options); return { configs: cfg().mcpActive }; };
`,
		"skillshare/client": `${prelude}
export const SkillshareClient = {
	create: async () => ({
		packument: async (scope, name) => {
			if (cfg().skill.missing) throw Object.assign(new Error("not found"), { status: 404 });
			return { distTags: { latest: cfg().skill.latest } };
		},
		close: () => log("clientClosed"),
	}),
};
`,
		"skillshare/installer": `${prelude}
export const listInstalledSkills = async cwd => cfg().installedSkills.filter(skill => skill.scope === "user" || cfg().skillProjects[cwd]);
export const resolveSkillVersion = (packument, request) => ({ version: request === "bad" ? (() => { throw new Error("No non-yanked version matches"); })() : cfg().skill.within });
export const updateSkillPackages = async (client, options, hooks) => {
	log("updateSkillPackages", options);
	const approved = await hooks.confirmScripts({ id: options.names[0], version: "2.0.0", files: [] });
	hooks.warn("ignored");
	if (cfg().skill.scripts && !approved) throw new Error("Installation of " + options.names[0] + "@2.0.0 was declined");
	if (cfg().skill.unchanged) return [];
	return [{ id: options.names[0], from: "1.0.0", to: "1.1.0" }];
};
`,
		"skillshare/manifest": `${prelude}
export const getProjectSkillsInstallPaths = async cwd => {
	const dir = cfg().skillProjects[cwd];
	if (!dir) throw new Error("This directory is not a project root");
	return { dir };
};
`,
	};
};

const packageJson = (exportsMap: Record<string, string>) =>
	JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", type: "module", exports: exportsMap });

async function fakeInstall(
	config: Partial<FakeConfig> = {},
	options: { omit?: string[] } = {},
): Promise<{
	root: string;
	dir: string;
	calls: () => unknown[][];
	setConfig: (patch: Partial<FakeConfig>) => void;
}> {
	const dir = await tempDir("omp-gui-extensions-fake-");
	const root = path.join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent");
	const utils = path.join(dir, "node_modules", "@oh-my-pi", "pi-utils");
	await fs.mkdir(root, { recursive: true });
	await fs.mkdir(utils, { recursive: true });
	const sources = fakeSources(dir);
	const exportsMap: Record<string, string> = {};
	for (const [specifier, source] of Object.entries(sources)) {
		if (options.omit?.includes(specifier)) continue;
		const file = `${specifier.replaceAll("/", "__")}.ts`;
		await fs.writeFile(path.join(root, file), source);
		exportsMap[`./${specifier}`] = `./${file}`;
	}
	await fs.writeFile(path.join(root, "package.json"), packageJson(exportsMap));
	const full: FakeConfig = {
		marketplaces: [],
		userRegistry: "/fake/user/installed_plugins.json",
		projectRegistries: {},
		installed: {},
		updates: [],
		upgradeTo: "1.1.0",
		plugins: [],
		deps: {},
		enabledSnapshots: [[]],
		registryUrl: "http://127.0.0.1:9/",
		skills: [],
		installedSkills: [],
		skillProjects: {},
		skill: { latest: "1.1.0", within: "1.1.0" },
		userMcpPath: path.join(dir, "agent", "mcp.json"),
		mcpItems: [],
		mcpActive: {},
		...config,
	};
	const write = () => writeFileSync(path.join(dir, "config.json"), JSON.stringify(full));
	write();
	// `plugins/package.json`, the file stock records npm/git/linked specs in.
	const pluginsJson = path.join(dir, "plugins-package.json");
	const writeDeps = () => writeFileSync(pluginsJson, JSON.stringify({ dependencies: full.deps }));
	writeDeps();
	await fs.writeFile(
		path.join(utils, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-utils", type: "module", exports: { ".": "./index.ts" } }),
	);
	await fs.writeFile(
		path.join(utils, "index.ts"),
		`import { readFileSync } from "node:fs";
const DIR = ${JSON.stringify(dir)};
export const getPluginsPackageJson = () => ${JSON.stringify(pluginsJson)};
export const getMCPConfigPath = () => JSON.parse(readFileSync(DIR + "/config.json", "utf8")).userMcpPath;
`,
	);
	return {
		root,
		dir,
		calls: () => {
			const log = path.join(dir, "calls.log");
			return existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line) as unknown[])
				: [];
		},
		setConfig: patch => {
			Object.assign(full, patch);
			write();
			writeDeps();
		},
	};
}

interface ExtensionsWorker {
	ask<T>(method: string, params?: unknown): Promise<Answer<T>>;
}

const userScope = (id: string, channel: PluginSelector["channel"] = "npm"): PluginSelector => ({
	channel,
	id,
	scope: "user",
	cwd: null,
});

describe("extensions worker on a fake install", () => {
	it("shapes the inventory: no credential or environment value, project registries deduplicated, specs classified", async () => {
		const dir = await tempDir("omp-gui-extensions-home-");
		const projectA = path.join(dir, "projA");
		const fake = await fakeInstall({
			marketplaces: [
				{
					name: "mk",
					sourceUri: "https://user:SECRETTOKEN@example.com/repo.git",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			projectRegistries: {
				[projectA]: "/fake/projA/installed_plugins.json",
				[dir]: "/fake/user/installed_plugins.json",
			},
			installed: {
				user: [{ id: "alpha@mk", version: "1.0.0" }],
				"/fake/projA/installed_plugins.json": [{ id: "proj@mk", version: "2.0.0", enabled: false }],
			},
			plugins: [
				{ name: "npm-a", version: "1.0.0", enabled: true },
				{ name: "git-a", version: "0.1.0", enabled: false },
				{ name: "link-a", version: "0.0.1", enabled: true },
				{ name: "link-b", version: "0.0.2", enabled: true },
			],
			deps: { "npm-a": "^1.0.0", "git-a": "github:o/r#main", "link-a": "file:../link-a" },
			skills: [
				{ filePath: "/s/registry/SKILL.md", _source: { provider: "skillshare" } },
				{ filePath: "/s/plugin/SKILL.md", _source: { provider: "claude-plugins", pluginName: "alpha" } },
				{ filePath: "/s/plugin/SKILL.md", _source: { provider: "claude-plugins", pluginName: "alpha" } },
				{ filePath: "/s/ext/SKILL.md", _source: { provider: "custom", pluginName: "ext" } },
				{ filePath: "/s/mine/SKILL.md", _source: { provider: "native" } },
				{ filePath: "/s/other/SKILL.md", _source: { provider: "claude" } },
				{ filePath: "/s/bare/SKILL.md" },
			],
			installedSkills: [
				{ id: "@me/user-skill", scope: "user", range: "^1.0.0", version: "1.0.0" },
				{ id: "@me/proj-skill", scope: "project", range: "1.0.0", version: "1.0.0" },
				{ id: "@me/never-installed", scope: "user", range: "^1.0.0" },
			],
			skillProjects: {
				[projectA]: path.join(projectA, ".omp"),
				[path.join(projectA, "sub")]: path.join(projectA, ".omp"),
			},
			userMcpPath: path.join(dir, "agent", "mcp.json"),
			mcpItems: [
				{
					name: "stdio-one",
					command: "npx",
					args: ["-y", "pkg@1.0.0"],
					env: { TOKEN: "SECRET-ENV" },
					_source: { provider: "mcp-json", path: path.join(dir, "agent", "mcp.json"), level: "user" },
				},
				{
					name: "remote",
					transport: "sse",
					url: "https://u:SECRETPW@example.com/mcp",
					headers: { Authorization: "Bearer SECRET-HEADER" },
					_source: { provider: "mcp-json", path: path.join(dir, "agent", "mcp.json"), level: "user" },
				},
				{
					name: "off",
					command: "uvx",
					args: ["x"],
					_source: { provider: "claude-plugins", path: "/plugins/p/.mcp.json", level: "user" },
				},
				{ name: "stdio-one", command: "other", _source: { provider: "claude", path: "/x", level: "user" } },
				{
					name: "project-only",
					command: "p",
					_source: { provider: "mcp-json", path: "/p/.omp/mcp.json", level: "project" },
				},
			],
			mcpActive: { "stdio-one": { type: "stdio" }, remote: { type: "sse" } },
		});
		const worker = startWorker(fake.root);
		const inventory = await ok(
			worker.ask<HelperInventory>("extensions.inventory", {
				cwds: [projectA, path.join(projectA, "sub"), dir, projectA],
			}),
		);

		expect(inventory.marketplaces).toEqual([
			{ name: "mk", source: "https://example.com/repo.git", updatedAt: "2026-01-01T00:00:00.000Z" },
		]);
		expect(inventory.plugins).toEqual([
			{
				channel: "marketplace",
				id: "alpha@mk",
				scope: "user",
				cwd: null,
				installed: "1.0.0",
				spec: null,
				enabled: true,
			},
			{
				channel: "marketplace",
				id: "proj@mk",
				scope: "project",
				cwd: projectA,
				installed: "2.0.0",
				spec: null,
				enabled: false,
			},
			{ channel: "npm", id: "npm-a", scope: "user", cwd: null, installed: "1.0.0", spec: "^1.0.0", enabled: true },
			{
				channel: "git",
				id: "git-a",
				scope: "user",
				cwd: null,
				installed: "0.1.0",
				spec: "github:o/r#main",
				enabled: false,
			},
			{
				channel: "linked",
				id: "link-a",
				scope: "user",
				cwd: null,
				installed: "0.0.1",
				spec: "file:../link-a",
				enabled: true,
			},
			{ channel: "linked", id: "link-b", scope: "user", cwd: null, installed: "0.0.2", spec: null, enabled: true },
		]);
		// The project registry is read once for projA and its subfolder; the user's own registry (the home) not at all.
		expect(fake.calls().filter(call => call[0] === "manager" && call[1] !== null)).toEqual([
			["manager", "/fake/projA/installed_plugins.json"],
		]);
		expect(inventory.registrySkills).toEqual([
			{ id: "@me/user-skill", scope: "user", cwd: null, range: "^1.0.0", installed: "1.0.0" },
			{ id: "@me/proj-skill", scope: "project", cwd: projectA, range: "1.0.0", installed: "1.0.0" },
			{ id: "@me/never-installed", scope: "user", cwd: null, range: "^1.0.0", installed: null },
		]);
		// Registry skills count in neither; a skill found twice counts once; a plugin name makes a skill plugin-provided.
		expect(inventory.pluginSkills).toBe(2);
		expect(inventory.localSkills).toBe(3);
		expect(inventory.mcpServers).toEqual([
			{
				name: "off",
				type: "stdio",
				command: "uvx",
				args: ["x"],
				url: null,
				enabled: false,
				sourcePath: "/plugins/p/.mcp.json",
				origin: "other",
			},
			{
				name: "remote",
				type: "sse",
				command: null,
				args: [],
				url: "https://example.com/mcp",
				enabled: true,
				sourcePath: path.join(dir, "agent", "mcp.json"),
				origin: "user",
			},
			{
				name: "stdio-one",
				type: "stdio",
				command: "npx",
				args: ["-y", "pkg@1.0.0"],
				url: null,
				enabled: true,
				sourcePath: path.join(dir, "agent", "mcp.json"),
				origin: "user",
			},
		]);
		expect(JSON.stringify(inventory)).not.toMatch(/SECRET/);
		// Skill discovery is read-only and per folder, the capability holds are released, relative custom directories resolved.
		const calls = fake.calls();
		expect(calls.filter(call => call[0] === "hold").length).toBe(calls.filter(call => call[0] === "release").length);
		expect(calls.find(call => call[0] === "loadSkills" && call[1] === projectA)?.[2]).toEqual([
			path.join(projectA, "rel-skills"),
		]);
		expect(calls.filter(call => call[0] === "loadAllMCPConfigs")[0]?.[2]).toEqual({
			enableProjectConfig: false,
			filterExa: false,
		});
	});

	it("lists an empty omp without any folder, probing the home instead", async () => {
		const fake = await fakeInstall();
		const inventory = await ok(startWorker(fake.root).ask<HelperInventory>("extensions.inventory", {}));
		expect(inventory).toEqual({
			marketplaces: [],
			plugins: [],
			registrySkills: [],
			pluginSkills: 0,
			localSkills: 0,
			mcpServers: [],
		});
		expect(fake.calls().find(call => call[0] === "loadSkills")?.[1]).toBe(os.homedir());
	});

	it("decides pinned for npm specs and git refs, and reads latest for npm from the registry stock resolves", async () => {
		const seen: Array<{ url: string | undefined; authorization: string | undefined; accept: string | undefined }> =
			[];
		const server = createServer((request, response) => {
			seen.push({ url: request.url, authorization: request.headers.authorization, accept: request.headers.accept });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ "dist-tags": { latest: "3.0.0", next: "4.0.0" } }));
		});
		servers.push(server);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		const registryUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
		const fake = await fakeInstall({
			registryUrl,
			plugins: [
				{ name: "bare", version: "1.2.3", enabled: true },
				{ name: "exact", version: "1.2.3", enabled: true },
				{ name: "caret-old", version: "1.2.3", enabled: true },
				{ name: "tagged", version: "1.2.3", enabled: true },
				{ name: "latest-tag", version: "1.2.3", enabled: true },
				{ name: "@sc/scoped", version: "1.2.3", enabled: true },
				{ name: "git-branch", version: "1.0.0", enabled: true },
				{ name: "git-bare", version: "1.0.0", enabled: true },
				{ name: "git-commit", version: "1.0.0", enabled: true },
				{ name: "git-tag", version: "1.0.0", enabled: true },
				{ name: "link", version: "1.0.0", enabled: true },
			],
			deps: {
				bare: "^1.2.3",
				exact: "1.2.3",
				"caret-old": "^1.0.0",
				tagged: "beta",
				"latest-tag": "latest",
				"@sc/scoped": "^1.2.3",
				"git-branch": "github:o/r#main",
				"git-bare": "github:o/r",
				"git-commit": "github:o/r#0123456789abcdef0123456789abcdef01234567",
				"git-tag": "github:o/r#v1.2.0",
				link: "link:../x",
			},
		});
		const worker = startWorker(fake.root);
		const check = (selector: PluginSelector) =>
			ok(worker.ask<PluginCheckResult>("extensions.plugin.check", selector));
		const expectNpm = (pinned: boolean) => ({ installed: "1.2.3", latest: "3.0.0", pinned, unversioned: false });

		expect(await check(userScope("bare"))).toEqual(expectNpm(false));
		expect(await check(userScope("exact"))).toEqual(expectNpm(true));
		expect(await check(userScope("caret-old"))).toEqual(expectNpm(true));
		expect(await check(userScope("tagged"))).toEqual(expectNpm(true));
		expect(await check(userScope("latest-tag"))).toEqual(expectNpm(false));
		expect(await check(userScope("@sc/scoped"))).toEqual(expectNpm(false));
		expect(seen.at(-1)).toEqual({
			url: "/@sc%2fscoped",
			authorization: "Bearer TESTTOKEN",
			accept: expect.stringContaining("application/json"),
		});
		const git = (id: string) => check(userScope(id, "git"));
		const expectGit = (pinned: boolean) => ({ installed: "1.0.0", latest: null, pinned, unversioned: false });
		expect(await git("git-branch")).toEqual(expectGit(false));
		expect(await git("git-bare")).toEqual(expectGit(false));
		expect(await git("git-commit")).toEqual(expectGit(true));
		expect(await git("git-tag")).toEqual(expectGit(true));
		// A git check never touches the registry.
		expect(seen).toHaveLength(6);
		expect((await worker.ask("extensions.plugin.check", userScope("link"))).error).toMatch(
			/linked from a local path/,
		);
		expect((await worker.ask("extensions.plugin.check", userScope("missing"))).error).toBe(
			'Plugin "missing" is not installed',
		);
	});

	it("fails a check cleanly when the registry does not answer", async () => {
		const server = createServer((_request, response) => response.writeHead(503).end());
		servers.push(server);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		const fake = await fakeInstall({
			registryUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`,
			plugins: [{ name: "bare", version: "1.0.0", enabled: true }],
			deps: { bare: "^1.0.0" },
		});
		const answer = await startWorker(fake.root).ask("extensions.plugin.check", userScope("bare"));
		expect(answer.error).toBe("npm registry answered 503 for bare");
	});

	it("reads a marketplace plugin's latest from the catalog check, and unversioned when the catalog gives none", async () => {
		const dir = await tempDir("omp-gui-extensions-home-");
		const project = path.join(dir, "proj");
		const fake = await fakeInstall({
			projectRegistries: { [project]: "/fake/proj/installed_plugins.json" },
			installed: {
				user: [
					{ id: "outdated@mk", version: "1.0.0" },
					{ id: "current@mk", version: "2.0.0" },
					{ id: "nover@mk", version: "0.0.0" },
				],
				"/fake/proj/installed_plugins.json": [{ id: "outdated@mk", version: "0.5.0" }],
			},
			updates: [
				{ pluginId: "outdated@mk", scope: "user", from: "1.0.0", to: "1.5.0" },
				{ pluginId: "outdated@mk", scope: "project", from: "0.5.0", to: "1.5.0" },
			],
		});
		const worker = startWorker(fake.root);
		const check = (id: string, scope: "user" | "project" = "user", cwd: string | null = null) =>
			ok(worker.ask<PluginCheckResult>("extensions.plugin.check", { channel: "marketplace", id, scope, cwd }));
		expect(await check("outdated@mk")).toEqual({
			installed: "1.0.0",
			latest: "1.5.0",
			pinned: false,
			unversioned: false,
		});
		expect(await check("outdated@mk", "project", project)).toEqual({
			installed: "0.5.0",
			latest: "1.5.0",
			pinned: false,
			unversioned: false,
		});
		expect(await check("current@mk")).toEqual({
			installed: "2.0.0",
			latest: "2.0.0",
			pinned: false,
			unversioned: false,
		});
		expect(await check("nover@mk")).toEqual({
			installed: "0.0.0",
			latest: "0.0.0",
			pinned: false,
			unversioned: true,
		});
		expect(
			(
				await worker.ask("extensions.plugin.check", {
					channel: "marketplace",
					id: "ghost@mk",
					scope: "user",
					cwd: null,
				})
			).error,
		).toBe('Plugin "ghost@mk" is not installed in user scope');
		expect(
			(
				await worker.ask("extensions.plugin.check", {
					channel: "marketplace",
					id: "x@mk",
					scope: "project",
					cwd: dir,
				})
			).error,
		).toBe("This project has no plugin registry");
	});

	it("refuses to upgrade a pinned, linked or project-scoped npm plugin, and never calls stock's upgrade for them", async () => {
		const fake = await fakeInstall({
			plugins: [
				{ name: "exact", version: "1.2.3", enabled: true },
				{ name: "commit", version: "1.0.0", enabled: true },
				{ name: "link", version: "1.0.0", enabled: true },
			],
			deps: { exact: "1.2.3", commit: "github:o/r#abcdef1", link: "workspace:*" },
		});
		const worker = startWorker(fake.root);
		const upgrade = (selector: PluginSelector) =>
			worker.ask<PluginUpgradeResult>("extensions.plugin.upgrade", selector);
		expect((await upgrade(userScope("exact"))).error).toBe("exact is pinned (1.2.3); it is not upgraded");
		expect((await upgrade(userScope("commit", "git"))).error).toBe(
			"commit is pinned (github:o/r#abcdef1); it is not upgraded",
		);
		expect((await upgrade(userScope("link"))).error).toBe("link is linked from a local path; nothing to upgrade");
		expect((await upgrade({ ...userScope("exact"), scope: "project", cwd: "/p" })).error).toBe(
			"npm and git plugins are installed for the user only",
		);
		expect(fake.calls().filter(call => call[0] === "upgrade" || call[0] === "upgradePlugin")).toEqual([]);
	});

	it("upgrades an npm plugin through stock and reports the activation of the effective plugin diff", async () => {
		const live = { name: "up", path: "/p/up", version: "1.0.0" };
		const fake = await fakeInstall({
			plugins: [{ name: "up", version: "1.0.0", enabled: true }],
			deps: { up: "^1.0.0" },
			upgradeTo: "1.1.0",
			enabledSnapshots: [[live], [{ ...live, version: "1.1.0" }]],
		});
		const worker = startWorker(fake.root);
		const first = await ok(worker.ask<PluginUpgradeResult>("extensions.plugin.upgrade", userScope("up")));
		expect(first).toEqual({ from: "1.0.0", to: "1.1.0", changed: true, activation: "live" });
		const calls = fake.calls();
		expect(calls.filter(call => call[0] === "upgrade")).toEqual([["upgrade", "up"]]);
		// Caches are cleared before each of the two effective-plugin reads, so neither is stale.
		const order = calls
			.map(call => call[0])
			.filter(name => name === "clear" || name === "enabled" || name === "upgrade");
		expect(order).toEqual(["clear", "enabled", "upgrade", "clear", "enabled"]);

		// The same upgrade of a plugin whose new version ships hooks needs a restart.
		fake.setConfig({
			enabledSnapshots: [[live], [{ ...live, version: "1.1.0", entries: { hooks: ["h.ts"] } }]],
		});
		const second = await ok(
			startWorker(fake.root).ask<PluginUpgradeResult>("extensions.plugin.upgrade", userScope("up")),
		);
		expect(second.activation).toBe("restart-required");
	});

	it("upgrades a marketplace plugin with the project registry for project scope", async () => {
		const dir = await tempDir("omp-gui-extensions-home-");
		const project = path.join(dir, "proj");
		const registry = "/fake/proj/installed_plugins.json";
		const fake = await fakeInstall({
			projectRegistries: { [project]: registry },
			installed: {
				"/fake/proj/installed_plugins.json": [{ id: "p@mk", version: "1.0.0" }],
				user: [{ id: "u@mk", version: "1.0.0" }],
			},
			upgradeTo: "1.0.0",
			enabledSnapshots: [[]],
		});
		const worker = startWorker(fake.root);
		const projectUpgrade = await ok(
			worker.ask<PluginUpgradeResult>("extensions.plugin.upgrade", {
				channel: "marketplace",
				id: "p@mk",
				scope: "project",
				cwd: project,
			}),
		);
		// Same version after the reinstall: nothing changed, and a plugin list that did not move is live.
		expect(projectUpgrade).toEqual({ from: "1.0.0", to: "1.0.0", changed: false, activation: "live" });
		fake.setConfig({ upgradeTo: "1.2.0" });
		const userUpgrade = await ok(
			worker.ask<PluginUpgradeResult>("extensions.plugin.upgrade", {
				channel: "marketplace",
				id: "u@mk",
				scope: "user",
				cwd: null,
			}),
		);
		expect(userUpgrade).toEqual({ from: "1.0.0", to: "1.2.0", changed: true, activation: "live" });
		const calls = fake.calls();
		expect(calls.filter(call => call[0] === "upgradePlugin")).toEqual([
			["upgradePlugin", "p@mk", "project", registry],
			["upgradePlugin", "u@mk", "user", null],
		]);
		expect(calls).toContainEqual(["clear", [registry]]);
	});

	it("refreshes a marketplace through stock", async () => {
		const fake = await fakeInstall();
		const refreshed = await ok(
			startWorker(fake.root).ask<{ updatedAt: string }>("extensions.marketplace.refresh", { name: "mk" }),
		);
		expect(refreshed).toEqual({ updatedAt: "2026-02-02T00:00:00.000Z" });
		expect(fake.calls()).toContainEqual(["updateMarketplace", "mk"]);
		expect((await startWorker(fake.root).ask("extensions.marketplace.refresh", {})).error).toBe("Missing name");
	});

	it("checks a registry skill against its packument and maps a skill that needs approval to a coded outcome", async () => {
		const dir = await tempDir("omp-gui-extensions-home-");
		const project = path.join(dir, "proj");
		const fake = await fakeInstall({
			installedSkills: [
				{ id: "@me/range", scope: "user", range: "^1.0.0", version: "1.0.0" },
				{ id: "@me/exact", scope: "user", range: "1.0.0", version: "1.0.0" },
				{ id: "@me/norange", scope: "user", version: "1.0.0" },
				{ id: "@me/inproject", scope: "project", range: "^1.0.0", version: "1.0.0" },
			],
			skillProjects: { [project]: path.join(project, ".omp") },
			skill: { latest: "2.0.0", within: "1.4.0", scripts: true },
		});
		const worker = startWorker(fake.root);
		const check = (id: string, scope: "user" | "project" = "user", cwd: string | null = null) =>
			ok(worker.ask<SkillCheckResult>("extensions.skill.check", { id, scope, cwd }));
		expect(await check("@me/range")).toEqual({ installed: "1.0.0", latest: "2.0.0", within: "1.4.0", pinned: false });
		expect(await check("@me/exact")).toEqual({ installed: "1.0.0", latest: "2.0.0", within: "1.4.0", pinned: true });
		expect(await check("@me/norange")).toEqual({ installed: "1.0.0", latest: "2.0.0", within: null, pinned: false });
		expect(await check("@me/inproject", "project", project)).toEqual({
			installed: "1.0.0",
			latest: "2.0.0",
			within: "1.4.0",
			pinned: false,
		});
		expect((await worker.ask("extensions.skill.check", { id: "@me/ghost", scope: "user", cwd: null })).error).toBe(
			"@me/ghost is not installed in user scope",
		);
		expect((await worker.ask("extensions.skill.check", { id: "nonsense", scope: "user", cwd: null })).error).toBe(
			"nonsense is not installed in user scope",
		);

		// stock asks a person before it installs a version that ships scripts; the worker answers no and says so.
		const blocked = await ok(
			worker.ask<SkillUpdateResult>("extensions.skill.update", { id: "@me/range", scope: "user", cwd: null }),
		);
		expect(blocked).toEqual({ blocked: "needs-approval", version: "2.0.0" });
		fake.setConfig({ skill: { latest: "1.1.0", within: "1.1.0" } });
		const updated = await ok(
			worker.ask<SkillUpdateResult>("extensions.skill.update", { id: "@me/range", scope: "user", cwd: null }),
		);
		expect(updated).toEqual({ blocked: null, from: "1.0.0", to: "1.1.0", changed: true });
		fake.setConfig({ skill: { latest: "1.0.0", within: "1.0.0", unchanged: true } });
		expect(
			await ok(
				worker.ask<SkillUpdateResult>("extensions.skill.update", { id: "@me/range", scope: "user", cwd: null }),
			),
		).toEqual({
			blocked: null,
			from: "1.0.0",
			to: "1.0.0",
			changed: false,
		});
		const updates = fake.calls().filter(call => call[0] === "updateSkillPackages");
		expect(updates[0]?.[1]).toEqual({ names: ["@me/range"], global: true, cwd: os.homedir(), yes: false });
		await ok(
			worker.ask<SkillUpdateResult>("extensions.skill.update", {
				id: "@me/inproject",
				scope: "project",
				cwd: project,
			}),
		);
		expect(
			fake
				.calls()
				.filter(call => call[0] === "updateSkillPackages")
				.at(-1)?.[1],
		).toEqual({
			names: ["@me/inproject"],
			global: false,
			cwd: project,
			yes: false,
		});
		// Every client the worker opened was closed again.
		const closed = fake.calls().filter(call => call[0] === "clientClosed").length;
		expect(closed).toBeGreaterThanOrEqual(5);
	});

	it("says a skill the registry does not know is not found", async () => {
		const fake = await fakeInstall({
			installedSkills: [{ id: "@me/gone", scope: "user", range: "^1.0.0", version: "1.0.0" }],
			skill: { latest: "1.0.0", within: "1.0.0", missing: true },
		});
		const worker = startWorker(fake.root);
		expect((await worker.ask("extensions.skill.check", { id: "@me/gone", scope: "user", cwd: null })).error).toBe(
			"@me/gone was not found in the registry",
		);
	});

	it("says what is missing when the omp lacks a module or its package root, and what it does not know", async () => {
		const fake = await fakeInstall(
			{ plugins: [{ name: "anything", version: "1.0.0", enabled: true }], deps: { anything: "github:o/r" } },
			{ omit: ["extensibility/plugins/git-url"] },
		);
		const worker = startWorker(fake.root);
		const missing = await worker.ask("extensions.plugin.check", userScope("anything", "git"));
		expect(missing.error).toBe("Installed omp has no @oh-my-pi/pi-coding-agent/extensibility/plugins/git-url");
		const healthy = await fakeInstall();
		expect((await startWorker(healthy.root).ask("extensions.nope")).error).toBe("Unknown stock helper method");

		const noRoot = spawn("bun", [HOST, "extensions"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, OMP_PACKAGE_ROOT: "" },
		});
		children.push(noRoot);
		noRoot.stderr.resume();
		const lines = createInterface({ input: noRoot.stdout })[Symbol.asyncIterator]();
		noRoot.stdin.write(`${JSON.stringify({ id: 1, method: "extensions.inventory", params: {} })}\n`);
		const { value } = await lines.next();
		expect(JSON.parse(value as string)).toEqual({ id: 1, error: "OMP_PACKAGE_ROOT is required" });
	});

	it("rejects malformed parameters before it touches stock", async () => {
		const fake = await fakeInstall();
		const worker = startWorker(fake.root);
		expect((await worker.ask("extensions.inventory", { cwds: "nope" })).error).toBe("Invalid cwds");
		expect((await worker.ask("extensions.plugin.check", { channel: "linked", id: "x", scope: "user" })).error).toBe(
			"Invalid plugin channel",
		);
		expect((await worker.ask("extensions.plugin.check", { channel: "npm", id: "x", scope: "team" })).error).toBe(
			"Invalid scope",
		);
		expect((await worker.ask("extensions.plugin.upgrade", { channel: "npm", scope: "user" })).error).toBe(
			"Missing id",
		);
		expect((await worker.ask("extensions.skill.update", { id: "@me/x", scope: "project" })).error).toBe(
			"A project scope needs its folder",
		);
		expect(fake.calls().filter(call => call[0] === "manager")).toEqual([]);
	});
});

// ─── The real omp ───────────────────────────────────────────────────────────────────────────────────────────

const realRoot = path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const REAL = existsSync(path.join(realRoot, "package.json"));
const STOCK_SRC = path.join(realRoot, "src");

/** Runs inside the throwaway environment: stock's own commands that put something installed there. */
const SEED_SCRIPT = `
const SRC = ${JSON.stringify(STOCK_SRC)};
const [command, ...args] = process.argv.slice(2);
const market = await import(SRC + "/extensibility/plugins/marketplace/index.ts");
const helpers = await import(SRC + "/discovery/helpers.ts");
const { PluginManager } = await import(SRC + "/extensibility/plugins/manager.ts");
const { SkillshareClient } = await import(SRC + "/skillshare/client.ts");
const { installSkillPackages } = await import(SRC + "/skillshare/installer.ts");
const marketplaceManager = async project => new market.MarketplaceManager({
	marketplacesRegistryPath: market.getMarketplacesRegistryPath(),
	installedRegistryPath: market.getInstalledPluginsRegistryPath(),
	projectInstalledRegistryPath: project ? await helpers.resolveOrDefaultProjectRegistryPath(project) : undefined,
	marketplacesCacheDir: market.getMarketplacesCacheDir(),
	pluginsCacheDir: market.getPluginsCacheDir(),
	clearPluginRootsCache: helpers.clearPluginRootsAndCaches,
});
if (command === "marketplace-add") {
	await (await marketplaceManager(null)).addMarketplace(args[0]);
} else if (command === "marketplace-install") {
	const [name, marketplace, scope, project] = args;
	await (await marketplaceManager(project || null)).installPlugin(name, marketplace, { scope });
} else if (command === "npm-install") {
	await new PluginManager(process.cwd()).install(args[0]);
} else if (command === "link") {
	await new PluginManager(process.cwd()).link(args[0]);
} else if (command === "skill-install") {
	const client = await SkillshareClient.create({ registryUrl: args[1] });
	await installSkillPackages(client, { specs: [args[0]], global: true, yes: true, cwd: process.cwd() }, { confirmScripts: async () => true, warn: () => {} });
	client.close();
}
`;

interface RealEnv {
	home: string;
	agent: string;
	env: Record<string, string>;
	/** Run one seed command in the throwaway environment. */
	seed: (...args: string[]) => Promise<void>;
	worker: ExtensionsWorker;
}

async function realEnv(
	extraEnv: Record<string, string> = {},
	agentFiles: Record<string, string> = {},
): Promise<RealEnv> {
	const home = await tempDir("omp-gui-extensions-real-");
	const agent = path.join(home, "agent");
	await fs.mkdir(agent, { recursive: true });
	for (const [file, text] of Object.entries(agentFiles)) {
		await fs.mkdir(path.dirname(path.join(agent, file)), { recursive: true });
		await fs.writeFile(path.join(agent, file), text);
	}
	const env: Record<string, string> = {
		HOME: home,
		USERPROFILE: home,
		BUN_INSTALL: path.join(home, ".bun"),
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: ".omp-config",
		PI_NOTIFICATIONS: "off",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		XDG_CONFIG_HOME: "",
		XDG_DATA_HOME: "",
		XDG_STATE_HOME: "",
		// Bun reads an empty XDG_CACHE_HOME as a relative path and writes its
		// transpiler cache to `bun/` in the worker's cwd, the checkout.
		XDG_CACHE_HOME: path.join(home, ".cache"),
		...extraEnv,
	};
	const script = path.join(home, "seed.ts");
	await fs.writeFile(script, SEED_SCRIPT);
	const seed = async (...args: string[]) => {
		const child = spawn("bun", [script, ...args], {
			cwd: home,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", chunk => {
			stderr += String(chunk);
		});
		const code = await new Promise<number | null>(resolve => child.on("exit", exitCode => resolve(exitCode)));
		if (code !== 0) throw new Error(`seed ${args.join(" ")} failed (${code}): ${stderr.slice(0, 600)}`);
	};
	return { home, agent, env, seed, worker: startWorker(realRoot, env) };
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
	for (const [file, text] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), text);
	}
}

describe.skipIf(!REAL)("the extensions worker on the real stock omp", () => {
	it("keeps a local-path marketplace and its plugin current: inventory, check, refresh, upgrade, activation", async () => {
		const real = await realEnv();
		const market = path.join(real.home, "market");
		const publish = (version: string) =>
			writeTree(market, {
				".claude-plugin/marketplace.json": JSON.stringify({
					name: "demo-mkt",
					owner: { name: "me" },
					plugins: [
						{ name: "demo", source: "./plugins/demo" },
						{ name: "bare", source: "./plugins/bare" },
					],
				}),
				"plugins/demo/.claude-plugin/plugin.json": JSON.stringify({ name: "demo", version }),
				"plugins/demo/skills/hello/SKILL.md": "---\nname: hello\ndescription: says hello\n---\nhello\n",
				"plugins/bare/skills/plain/SKILL.md": "---\nname: plain\ndescription: no version anywhere\n---\nplain\n",
			});
		await publish("1.0.0");
		await real.seed("marketplace-add", market);
		await real.seed("marketplace-install", "demo", "demo-mkt", "user");
		await real.seed("marketplace-install", "bare", "demo-mkt", "user");

		const inventory = await ok(real.worker.ask<HelperInventory>("extensions.inventory", { cwds: [real.home] }));
		expect(inventory.marketplaces.map(entry => [entry.name, entry.source])).toEqual([["demo-mkt", market]]);
		expect(inventory.plugins).toEqual([
			expect.objectContaining({
				channel: "marketplace",
				id: "demo@demo-mkt",
				scope: "user",
				installed: "1.0.0",
				enabled: true,
				spec: null,
			}),
			expect.objectContaining({ channel: "marketplace", id: "bare@demo-mkt", scope: "user", installed: "0.0.0" }),
		]);
		// Both plugins' skills follow their plugin: counted as plugin skills, never as local ones.
		expect(inventory.pluginSkills).toBe(2);
		expect(inventory.localSkills).toBe(0);

		const demo = userScope("demo@demo-mkt", "marketplace");
		const check = () => ok(real.worker.ask<PluginCheckResult>("extensions.plugin.check", demo));
		expect(await check()).toEqual({ installed: "1.0.0", latest: "1.0.0", pinned: false, unversioned: false });
		expect(
			await ok(
				real.worker.ask<PluginCheckResult>("extensions.plugin.check", userScope("bare@demo-mkt", "marketplace")),
			),
		).toEqual({
			installed: "0.0.0",
			latest: "0.0.0",
			pinned: false,
			unversioned: true,
		});

		await publish("1.1.0");
		const refreshed = await ok(
			real.worker.ask<{ updatedAt: string }>("extensions.marketplace.refresh", { name: "demo-mkt" }),
		);
		expect(Date.parse(refreshed.updatedAt)).not.toBeNaN();
		expect(await check()).toEqual({ installed: "1.0.0", latest: "1.1.0", pinned: false, unversioned: false });
		expect(await ok(real.worker.ask<PluginUpgradeResult>("extensions.plugin.upgrade", demo))).toEqual({
			from: "1.0.0",
			to: "1.1.0",
			changed: true,
			activation: "live",
		});
		// The caches were cleared after the upgrade: a later check sees the new install.
		expect(await check()).toEqual({ installed: "1.1.0", latest: "1.1.0", pinned: false, unversioned: false });
		// Upgrading what is already current changes nothing.
		expect(await ok(real.worker.ask<PluginUpgradeResult>("extensions.plugin.upgrade", demo))).toMatchObject({
			from: "1.1.0",
			to: "1.1.0",
			changed: false,
		});
		expect((await real.worker.ask("extensions.marketplace.refresh", { name: "nope" })).error).toMatch(/not found/);
	}, 120_000);

	it("checks and upgrades a project-scoped marketplace plugin through the project's own registry", async () => {
		const real = await realEnv();
		const market = path.join(real.home, "market");
		const project = path.join(real.home, "proj");
		await fs.mkdir(path.join(project, ".omp"), { recursive: true });
		const publish = (version: string) =>
			writeTree(market, {
				".claude-plugin/marketplace.json": JSON.stringify({
					name: "demo-mkt",
					owner: { name: "me" },
					plugins: [{ name: "demo", source: "./plugins/demo" }],
				}),
				"plugins/demo/.claude-plugin/plugin.json": JSON.stringify({ name: "demo", version }),
			});
		await publish("1.0.0");
		await real.seed("marketplace-add", market);
		await real.seed("marketplace-install", "demo", "demo-mkt", "project", project);

		const inventory = await ok(
			real.worker.ask<HelperInventory>("extensions.inventory", {
				cwds: [project, path.join(project, "sub"), real.home],
			}),
		);
		expect(inventory.plugins).toEqual([
			expect.objectContaining({
				channel: "marketplace",
				id: "demo@demo-mkt",
				scope: "project",
				cwd: project,
				installed: "1.0.0",
			}),
		]);
		await publish("1.2.0");
		const selector: PluginSelector = { channel: "marketplace", id: "demo@demo-mkt", scope: "project", cwd: project };
		expect(await ok(real.worker.ask<PluginCheckResult>("extensions.plugin.check", selector))).toMatchObject({
			installed: "1.0.0",
			latest: "1.2.0",
		});
		expect(await ok(real.worker.ask<PluginUpgradeResult>("extensions.plugin.upgrade", selector))).toEqual({
			from: "1.0.0",
			to: "1.2.0",
			changed: true,
			activation: "live",
		});
		const after = await ok(real.worker.ask<HelperInventory>("extensions.inventory", { cwds: [project] }));
		expect(after.plugins[0]).toMatchObject({ scope: "project", installed: "1.2.0" });
	}, 120_000);

	it("keeps an npm plugin from a registry current, honors a pin, and reports a restart for hooks", async () => {
		const registry: NpmRegistry = await npmRegistry();
		registries.push(registry);
		const real = await realEnv({ BUN_CONFIG_REGISTRY: registry.url, npm_config_registry: registry.url });
		registry.publish("npm-demo", "1.0.0", { manifest: { omp: { version: "1.0.0" } } });
		registry.publish("pin-demo", "1.0.0");
		await real.seed("npm-install", "npm-demo");
		await real.seed("npm-install", "pin-demo@1.0.0");
		const linked = path.join(real.home, "linked-plugin");
		await writeTree(linked, { "package.json": JSON.stringify({ name: "linked-demo", version: "0.0.1" }) });
		await real.seed("link", linked);

		const inventory = await ok(real.worker.ask<HelperInventory>("extensions.inventory", { cwds: [] }));
		// What bun recorded: a bare install is `^<version>`, an explicit version is exact; a linked plugin has its own record.
		expect(inventory.plugins.map(plugin => [plugin.channel, plugin.id, plugin.spec])).toEqual(
			expect.arrayContaining([
				["npm", "npm-demo", "^1.0.0"],
				["npm", "pin-demo", "1.0.0"],
				["linked", "linked-demo", null],
			]),
		);

		registry.publish("npm-demo", "1.1.0", {
			manifest: { omp: { version: "1.1.0", hooks: "h.ts" } },
			files: { "h.ts": "export default () => {};\n" },
		});
		registry.publish("pin-demo", "1.1.0");
		const check = (id: string) => ok(real.worker.ask<PluginCheckResult>("extensions.plugin.check", userScope(id)));
		expect(await check("npm-demo")).toEqual({
			installed: "1.0.0",
			latest: "1.1.0",
			pinned: false,
			unversioned: false,
		});
		expect(await check("pin-demo")).toEqual({
			installed: "1.0.0",
			latest: "1.1.0",
			pinned: true,
			unversioned: false,
		});
		expect((await real.worker.ask("extensions.plugin.check", userScope("linked-demo"))).error).toBe(
			"linked-demo is linked from a local path; nothing to check",
		);

		// A pin is refused by the worker, and nothing moves.
		expect((await real.worker.ask("extensions.plugin.upgrade", userScope("pin-demo"))).error).toBe(
			"pin-demo is pinned (1.0.0); it is not upgraded",
		);
		expect(await check("pin-demo")).toMatchObject({ installed: "1.0.0" });

		expect(
			await ok(real.worker.ask<PluginUpgradeResult>("extensions.plugin.upgrade", userScope("npm-demo"))),
		).toEqual({
			from: "1.0.0",
			to: "1.1.0",
			changed: true,
			activation: "restart-required",
		});
		expect(await check("npm-demo")).toEqual({
			installed: "1.1.0",
			latest: "1.1.0",
			pinned: false,
			unversioned: false,
		});
		const after = await ok(real.worker.ask<HelperInventory>("extensions.inventory", { cwds: [] }));
		// The upgrade rewrote the record to the new bare form, so the next check is still not pinned.
		expect(after.plugins.find(plugin => plugin.id === "npm-demo")?.spec).toBe("^1.1.0");
		expect(after.plugins.find(plugin => plugin.id === "pin-demo")?.spec).toBe("1.0.0");
	}, 180_000);

	it("checks and updates a registry skill, leaves an exact range alone, and reports one that needs approval", async () => {
		const registry: SkillsRegistry = await skillsRegistry();
		registries.push(registry);
		const real = await realEnv({}, { "config.yml": `skills:\n  registryUrl: ${registry.url}\n` });
		registry.publish("tester", "demo-skill", "1.0.0");
		registry.publish("tester", "pin-skill", "1.0.0");
		await real.seed("skill-install", "@tester/demo-skill", registry.url);
		await real.seed("skill-install", "@tester/pin-skill@1.0.0", registry.url);

		const inventory = await ok(real.worker.ask<HelperInventory>("extensions.inventory", { cwds: [real.home] }));
		expect(inventory.registrySkills).toEqual([
			{ id: "@tester/demo-skill", scope: "user", cwd: null, range: "^1.0.0", installed: "1.0.0" },
			{ id: "@tester/pin-skill", scope: "user", cwd: null, range: "1.0.0", installed: "1.0.0" },
		]);
		// Installed registry skills are listed as registry skills only.
		expect(inventory.pluginSkills + inventory.localSkills).toBe(0);

		const select = (id: string) => ({ id, scope: "user", cwd: null });
		const check = (id: string) => ok(real.worker.ask<SkillCheckResult>("extensions.skill.check", select(id)));
		expect(await check("@tester/demo-skill")).toEqual({
			installed: "1.0.0",
			latest: "1.0.0",
			within: "1.0.0",
			pinned: false,
		});
		registry.publish("tester", "demo-skill", "1.1.0");
		registry.publish("tester", "pin-skill", "1.1.0");
		expect(await check("@tester/demo-skill")).toEqual({
			installed: "1.0.0",
			latest: "1.1.0",
			within: "1.1.0",
			pinned: false,
		});
		expect(await check("@tester/pin-skill")).toEqual({
			installed: "1.0.0",
			latest: "1.1.0",
			within: "1.0.0",
			pinned: true,
		});

		expect(
			await ok(real.worker.ask<SkillUpdateResult>("extensions.skill.update", select("@tester/demo-skill"))),
		).toEqual({
			blocked: null,
			from: "1.0.0",
			to: "1.1.0",
			changed: true,
		});
		expect(
			await ok(real.worker.ask<SkillUpdateResult>("extensions.skill.update", select("@tester/demo-skill"))),
		).toEqual({
			blocked: null,
			from: "1.1.0",
			to: "1.1.0",
			changed: false,
		});

		registry.publish("tester", "demo-skill", "1.2.0", { scripts: true });
		expect(
			await ok(real.worker.ask<SkillUpdateResult>("extensions.skill.update", select("@tester/demo-skill"))),
		).toEqual({
			blocked: "needs-approval",
			version: "1.2.0",
		});
		// Nothing was installed for it.
		expect(await check("@tester/demo-skill")).toMatchObject({ installed: "1.1.0", latest: "1.2.0" });
		expect((await real.worker.ask("extensions.skill.check", select("@tester/missing-skill"))).error).toMatch(
			/not installed/,
		);
	}, 120_000);

	it("lists the user's MCP servers without their environment or headers, disabled ones included", async () => {
		const real = await realEnv(
			{},
			{
				"mcp.json": JSON.stringify({
					mcpServers: {
						alpha: {
							type: "stdio",
							command: "npx",
							args: ["-y", "alpha-mcp@1.2.3"],
							env: { TOKEN: "SECRET-ENV" },
						},
						beta: {
							type: "http",
							url: "https://user:SECRETPW@example.com/mcp",
							headers: { Authorization: "Bearer SECRET-HEADER" },
						},
						gamma: { command: "uvx", args: ["gamma-mcp"] },
					},
					disabledServers: ["gamma"],
				}),
				"skills/mine/SKILL.md": "---\nname: mine\ndescription: a local skill\n---\nmine\n",
			},
		);
		const inventory = await ok(real.worker.ask<HelperInventory>("extensions.inventory", { cwds: [real.home] }));
		const mcp = path.join(real.agent, "mcp.json");
		expect(inventory.mcpServers).toEqual([
			{
				name: "alpha",
				type: "stdio",
				command: "npx",
				args: ["-y", "alpha-mcp@1.2.3"],
				url: null,
				enabled: true,
				sourcePath: mcp,
				origin: "user",
			},
			{
				name: "beta",
				type: "http",
				command: null,
				args: [],
				url: "https://example.com/mcp",
				enabled: true,
				sourcePath: mcp,
				origin: "user",
			},
			{
				name: "gamma",
				type: "stdio",
				command: "uvx",
				args: ["gamma-mcp"],
				url: null,
				enabled: false,
				sourcePath: mcp,
				origin: "user",
			},
		]);
		expect(JSON.stringify(inventory)).not.toMatch(/SECRET/);
		expect(inventory.localSkills).toBe(1);
		expect(inventory.pluginSkills).toBe(0);
	}, 60_000);
});
