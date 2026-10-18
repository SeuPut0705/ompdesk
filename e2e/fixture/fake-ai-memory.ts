#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * A stand-in for the `ai-memory` release binary OMPdesk wires into omp (`src/main/ai-memory/`). It never touches the
 * user's machine: everything it writes lives under the test's own `HOME`, `PI_CODING_AGENT_DIR` and (optionally)
 * `AI_MEMORY_DATA_DIR`. Install it with `fixtureAiMemory(dir)` (`fake-ai-memory-install.ts`), which returns the
 * environment to launch the app with (`OMP_GUI_AI_MEMORY_BIN` makes a non-packaged app wire it).
 *
 * Every call is logged, one JSON line `{argv}` per call, to `FAKE_AI_MEMORY_LOG`; the server's requests go to
 * `FAKE_AI_MEMORY_LOG + ".requests"` (`{path, authorized}`).
 *
 * Answers (the shapes of ai-memory 3.1.1):
 * - `--version`: `ai-memory 3.1.1`.
 * - `setup --plan --json --agent omp`: an INFO log line, then the plan document (`data_dir`, `config_path`, …).
 * - `setup --yes --agent omp [--no-service]`: `<agent dir>/mcp.json` (an `mcpServers["ai-memory"]` stdio entry),
 *   `<agent dir>/extensions/ai-memory-omp.ts`, the data dir with `config.toml` (`bind` on a free port) and
 *   `auth-tokens/default`, and, unless `--no-service`, a DETACHED server (`__serve`) recorded in
 *   `<HOME>/.fake-ai-memory/server.pid`. Waits until `/healthz` answers, like ai-memory's own self-check.
 * - `uninstall --apply --yes [--purge-data]`: removes the extension and the MCP entry, kills the server;
 *   `--purge-data` also empties the data dir.
 * - `__serve <data dir>`: the server: `/healthz`, then (bearer token) `/admin/status` and `/api/v1/…` with canned
 *   data: two projects, a search hit for "sqlite", recent pages, an open handoff and a page body.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "3.1.1";
const argv = process.argv.slice(2);
const logFile = process.env.FAKE_AI_MEMORY_LOG;
const home = process.env.HOME || process.env.USERPROFILE || homedir();
const agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".omp", "agent");
const dataDir = process.env.AI_MEMORY_DATA_DIR || join(home, "ai-memory-data");
const stateDir = join(home, ".fake-ai-memory");
const pidFile = join(stateDir, "server.pid");
const extensionFile = join(agentDir, "extensions", "ai-memory-omp.ts");
const mcpFile = join(agentDir, "mcp.json");
const configFile = join(dataDir, "config.toml");
const tokenFile = join(dataDir, "auth-tokens", "default");

if (argv[0] === "__serve") serve();
else main();

function main(): void {
	if (logFile) appendFileSync(logFile, `${JSON.stringify({ argv })}\n`);
	const [verb] = argv;
	if (argv[0] === "--version") {
		console.log(`ai-memory ${VERSION}`);
	} else if (verb === "init") {
		void ensureData().then(() => {
			console.log(`initialized ${dataDir}`);
			process.exit(0);
		});
		return;
	} else if (verb === "setup" && argv.includes("--plan")) {
		plan();
	} else if (verb === "setup" && argv.includes("--yes")) {
		void setup();
		return;
	} else if (verb === "uninstall" && argv.includes("--apply") && argv.includes("--yes")) {
		uninstall(argv.includes("--purge-data"));
	} else {
		console.error(`fake ai-memory: unsupported invocation: ${argv.join(" ")}`);
		process.exit(2);
	}
	process.exit(0);
}

function plan(): void {
	console.log("INFO ai_memory::setup: planning (nothing is changed)");
	console.log(
		JSON.stringify({
			format: 1,
			data_dir: dataDir,
			config_path: configFile,
			fresh: !existsSync(configFile),
			service: { action: "install", manager: "fake", path: pidFile },
			agents: [{ agent: "omp", found: null, wiring: "mcp+hooks+skills" }],
			other_agents: [],
			checks: [],
			first_question: null,
		}),
	);
}

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	await new Promise<void>(resolve => probe.close(() => resolve()));
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

function bindOf(): string | null {
	return /^\s*bind\s*=\s*"([^"]+)"/m.exec(readFileSync(configFile, "utf8"))?.[1] ?? null;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function ensureData(): Promise<void> {
	mkdirSync(join(dataDir, "auth-tokens"), { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	// ai-memory's own template: the embedding opt-out ships as a comment (OMPdesk switches it on after `init`).
	if (!existsSync(configFile) || bindOf() === null) {
		writeFileSync(
			configFile,
			`bind = "127.0.0.1:${await freePort()}"\n# embedding_provider = "none"   # template: no local embedding model\n`,
		);
	}
	if (!existsSync(tokenFile)) writeFileSync(tokenFile, `fake-token-${Math.random().toString(36).slice(2)}\n`);
}

async function setup(): Promise<void> {
	await ensureData();
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(extensionFile, "// generated by the fake ai-memory\nexport default function () {}\n");
	const config = existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")) : {};
	config.mcpServers = { ...config.mcpServers, "ai-memory": { command: process.argv[1], args: ["mcp-bridge"] } };
	writeFileSync(mcpFile, JSON.stringify(config, null, 2));
	if (argv.includes("--no-service")) {
		console.log("setup complete (no service)");
		process.exit(0);
	}
	const running = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
	if (!running || !alive(running)) {
		const child = spawn(process.execPath, [process.argv[1] ?? "", "__serve", dataDir], {
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
		writeFileSync(pidFile, String(child.pid));
	}
	const url = `http://${bindOf()}/healthz`;
	for (let attempt = 0; attempt < 100; attempt++) {
		const up = await fetch(url).then(
			response => response.ok,
			() => false,
		);
		if (up) {
			console.log("setup complete");
			process.exit(0);
		}
		await Bun.sleep(100);
	}
	console.log("problem: self-check: healthz did not answer");
	process.exit(1);
}

function uninstall(purge: boolean): void {
	rmSync(extensionFile, { force: true });
	if (existsSync(mcpFile)) {
		const config = JSON.parse(readFileSync(mcpFile, "utf8"));
		if (config.mcpServers) delete config.mcpServers["ai-memory"];
		writeFileSync(mcpFile, JSON.stringify(config, null, 2));
	}
	if (existsSync(pidFile)) {
		const pid = Number(readFileSync(pidFile, "utf8"));
		if (pid && alive(pid)) process.kill(pid);
		rmSync(pidFile, { force: true });
	}
	if (purge && existsSync(dataDir)) {
		for (const entry of readdirSync(dataDir)) rmSync(join(dataDir, entry), { recursive: true, force: true });
	}
	console.log(purge ? "uninstalled, data purged" : "uninstalled");
}

const PROJECTS = [
	{ workspace_name: "fixture", project_name: "alpha", page_count: 3, last_updated: "2026-10-17T10:00:00Z" },
	{ workspace_name: "fixture", project_name: "beta", page_count: 1, last_updated: "2026-10-01T10:00:00Z" },
];
const RECENT: Record<string, unknown[]> = {
	alpha: [
		{
			path: "sessions/s1.md",
			title: "Session: fix the cache",
			kind: "session",
			tier: "episodic",
			updated_at: "2026-10-17T10:00:00Z",
		},
		{
			path: "decisions/0007-db.md",
			title: "Use SQLite for the cache",
			kind: "decision",
			tier: "semantic",
			updated_at: "2026-10-16T10:00:00Z",
		},
	],
	beta: [
		{
			path: "notes/readme.md",
			title: "Beta notes",
			kind: "note",
			tier: "semantic",
			updated_at: "2026-10-01T10:00:00Z",
		},
	],
};
const HANDOFFS: Record<string, unknown[]> = {
	alpha: [
		{
			id: "h-1",
			agent: "omp",
			at: "2026-10-17T10:00:00Z",
			state: "open",
			summary: "Cache fix half done; next: add the eviction test.",
		},
	],
	beta: [],
};

function serve(): void {
	const dir = argv[1] ?? dataDir;
	const bind = /^\s*bind\s*=\s*"([^"]+)"/m.exec(readFileSync(join(dir, "config.toml"), "utf8"))?.[1] ?? "";
	const token = readFileSync(join(dir, "auth-tokens", "default"), "utf8").trim();
	const [hostname, port] = [bind.slice(0, bind.lastIndexOf(":")), Number(bind.slice(bind.lastIndexOf(":") + 1))];
	const json = (body: unknown, status = 200) => Response.json(body, { status });
	Bun.serve({
		hostname,
		port,
		fetch(request) {
			const url = new URL(request.url);
			const authorized = request.headers.get("authorization") === `Bearer ${token}`;
			if (logFile) appendFileSync(`${logFile}.requests`, `${JSON.stringify({ path: url.pathname, authorized })}\n`);
			if (url.pathname === "/healthz") return new Response("ok");
			if (!authorized) return json({ error: "unauthorized" }, 401);
			if (url.pathname === "/admin/status") {
				return json({
					version: VERSION,
					counts: { pages_latest: 4, sessions: 2, observations: 17 },
					storage: { database_bytes: 8192 },
				});
			}
			if (url.pathname === "/api/v1/projects") return json(PROJECTS);
			if (url.pathname === "/api/v1/search") {
				const query = (url.searchParams.get("q") ?? "").toLowerCase();
				return json(
					query.includes("sqlite")
						? [
								{
									workspace: "fixture",
									project: "alpha",
									path: "decisions/0007-db.md",
									title: "Use SQLite for the cache",
									updated_at: "2026-10-16T10:00:00Z",
									snippet: "We chose <mark>SQLite</mark> for the cache",
								},
							]
						: [],
				);
			}
			const project = /^\/api\/v1\/workspaces\/fixture\/projects\/([^/]+)\/(recent|handoffs|pages\/.+)$/.exec(
				url.pathname,
			);
			if (project) {
				const [, name = "", rest = ""] = project;
				if (rest === "recent") return json(RECENT[name] ?? []);
				if (rest === "handoffs") return json({ handoffs: HANDOFFS[name] ?? [] });
				return json({
					title: "Use SQLite for the cache",
					updated_at: "2026-10-16T10:00:00Z",
					body_markdown: "# Use SQLite for the cache\n\nWe chose SQLite for the cache because it ships with Bun.",
				});
			}
			return json({ error: "not found" }, 404);
		},
	});
}
