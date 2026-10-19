#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * A stand-in for the `ai-memory` release binary OMPdesk wires into omp (`src/main/ai-memory/`). It never touches the
 * user's machine: everything it writes lives under the test's own `HOME`, `PI_CODING_AGENT_DIR` and (optionally)
 * `AI_MEMORY_DATA_DIR`. Install it with `fixtureAiMemory(dir)` (`fake-ai-memory-install.ts`), which returns the
 * environment to launch the app with (`OMP_GUI_AI_MEMORY_BIN` makes a non-packaged app wire it).
 *
 * Every call is logged, one JSON line `{argv}` per call, to `FAKE_AI_MEMORY_LOG`; the server's requests go to
 * `FAKE_AI_MEMORY_LOG + ".requests"` (`{path, authorized}`). `FAKE_AI_MEMORY_BIN` is the command its MCP entries record
 * (the launcher the app runs; a real install records the binary's own path).
 *
 * Answers (the shapes of ai-memory 3.1.1):
 * - `--version`: `ai-memory 3.1.1`.
 * - `setup --plan --json --agent omp`: an INFO log line, then the plan document (`data_dir`, `config_path`, …).
 * - `setup --yes --agent omp [--no-service]`: `<agent dir>/mcp.json` (an `mcpServers["ai-memory"]` stdio entry),
 *   `<agent dir>/extensions/ai-memory-omp.ts` (the agent dir is `PI_CODING_AGENT_DIR`, as the real one honours it), the
 *   shared skills under `<HOME>/.agents/skills/ai-memory-*`, the data dir with `config.toml` (`bind` on a free port) and
 *   `auth-tokens/default`, and, unless `--no-service`, a DETACHED server (`__serve`) recorded in
 *   `<HOME>/.fake-ai-memory/server.pid` (the app's `OMP_GUI_AI_MEMORY_UNIT_PIDFILE` seam points at that file: it is the
 *   fake's "service unit"). Waits until `/healthz` answers, like ai-memory's own self-check. With
 *   `FAKE_AI_MEMORY_REFUSE_SERVICE=<file>` present, the service step fails once instead (launchd's error 5).
 * - `install-hooks --agent omp --apply --config-file F`, `install-mcp --client omp --apply --config-file F`,
 *   `install-skills --target-dir D`: the generated omp extension, the MCP entry file and the skills, each written ONLY
 *   at the path it was given.
 * - `uninstall` (no `--apply`): the dry run, listing what it would remove for EVERY agent it finds (omp's wiring, the
 *   managed skills, and a planted Claude Code `<HOME>/.claude/settings.json` that mentions ai-memory).
 * - `uninstall --apply --yes [--purge-data]`: removes all of that (the planted Claude Code hooks too: an app that ever
 *   ran it would fail the spec that plants them), kills the server; `--purge-data` also empties the data dir.
 * - `__serve <data dir>`: the server: `/healthz`, then (bearer token) `/admin/status` and `/api/v1/…`: two projects
 *   (alpha: four pages, two sessions (one with 60 observations), an open and an accepted handoff; beta: one page),
 *   search over the pages (global or scoped), overview, observations by offset, the profile, and a STATEFUL wiki:
 *   `/admin/write-page` (keeps `origin_device` and `expires_at` in the page's frontmatter, as OMPdesk's server does; an
 *   expired page is left out of the page list unless `include_expired=true`), `/admin/delete-page`
 *   (returns `pre_checkpoint`), `/admin/restore-page`, `/admin/lint`,
 *   `/admin/forget-sweep`, and MCP `tools/call` on `/mcp` for `memory_handoff_cancel`, `memory_feedback` and
 *   `memory_query`. POSTs are logged with their body, and `/mcp` calls with the tool name, in
 *   `FAKE_AI_MEMORY_LOG + ".requests"`.
 * - Session conclusions (what OMPdesk shares between paired computers, src/main/ai-memory/sync.ts), stateful for the
 *   life of the server process. NATIVE ones are the Stop observations this server captured: seed them with
 *   `FAKE_AI_MEMORY_CONCLUSIONS=<JSON array of {project, id, session_id, title?, body, created_at?}>` at launch, or
 *   add one later with an authorized `POST /__fake/capture` (same fields). SYNCED ones arrive by
 *   `POST /admin/write-conclusions` and are kept in their own table. `GET /admin/conclusions?source=native|synced&
 *   after&limit` pages either by `seq` (the row's position, 1-based) and answers 422 on a bad query;
 *   `/admin/write-conclusions` validates the whole request first (422, nothing written), scrubs `ghp_…`/`sk-…`
 *   tokens out of the body and cuts it to 2000 bytes, and is insert-if-absent per (workspace, project, id): `written`,
 *   `same` or `skipped` (empty body). `memory_query {conclusions: true}` answers `conclusion_hits` from the native
 *   and synced rows of the named project: a row matches when it holds every whitespace-separated term of the query
 *   (case-insensitive substring of title or body), one hit per session, the snippet is the body with the terms in
 *   `<mark>`; `hits` is always empty.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
const skillsRoot = join(home, ".agents", "skills");
const claudeSettings = join(home, ".claude", "settings.json");
const command = process.env.FAKE_AI_MEMORY_BIN || process.argv[1] || "ai-memory";
const GENERATED = "// Auto-generated by `ai-memory install-hooks --agent omp --apply`.\n";
const SKILL = "<!-- ai-memory-managed: routing-skill -->\n# ai-memory skill\n";
const argAfter = (flag: string): string => argv[argv.indexOf(flag) + 1] ?? "";
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
	} else if (verb === "install-hooks" && argv.includes("--apply")) {
		write(argAfter("--config-file"), `${GENERATED}export default function () {}\n`);
	} else if (verb === "install-mcp" && argv.includes("--apply")) {
		write(argAfter("--config-file"), JSON.stringify({ mcpServers: { "ai-memory": mcpEntry() } }, null, 2));
	} else if (verb === "install-skills" && argv.includes("--target-dir")) {
		write(join(argAfter("--target-dir"), "ai-memory-handoff", "SKILL.md"), SKILL);
	} else if (verb === "uninstall" && !argv.includes("--apply")) {
		dryRun();
	} else if (verb === "uninstall" && argv.includes("--apply") && argv.includes("--yes")) {
		uninstall(argv.includes("--purge-data"));
	} else {
		console.error(`fake ai-memory: unsupported invocation: ${argv.join(" ")}`);
		process.exit(2);
	}
	process.exit(0);
}

function write(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function mcpEntry(): Record<string, unknown> {
	return { type: "stdio", command, args: ["mcp-bridge"], enabled: true };
}

function claudeWired(): boolean {
	return existsSync(claudeSettings) && readFileSync(claudeSettings, "utf8").includes("ai-memory");
}

function managedSkills(): string[] {
	if (!existsSync(skillsRoot)) return [];
	return readdirSync(skillsRoot).filter(name => name.startsWith("ai-memory-"));
}

/** What `uninstall` would remove, in ai-memory's own words, for every agent it finds. */
function dryRun(): void {
	if (existsSync(extensionFile)) console.log(`would delete ${extensionFile} (OMP extension)`);
	if (existsSync(mcpFile) && readFileSync(mcpFile, "utf8").includes('"ai-memory"')) {
		console.log(`would remove ai-memory from ${mcpFile}`);
	}
	if (claudeWired()) console.log(`would remove ai-memory hooks from ${claudeSettings} (Claude Code hooks)`);
	for (const name of managedSkills())
		console.log(`would delete ${join(skillsRoot, name, "SKILL.md")} (managed Agent Skill)`);
	console.log("(dry-run; pass --apply to remove)");
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
	writeFileSync(extensionFile, `${GENERATED}export default function () {}\n`);
	const config = existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")) : {};
	config.mcpServers = { ...config.mcpServers, "ai-memory": mcpEntry() };
	writeFileSync(mcpFile, JSON.stringify(config, null, 2));
	if (!existsSync(join(skillsRoot, "ai-memory-retrieval")))
		write(join(skillsRoot, "ai-memory-retrieval", "SKILL.md"), SKILL);
	if (argv.includes("--no-service")) {
		console.log("setup complete (no service)");
		process.exit(0);
	}
	// FAKE_AI_MEMORY_REFUSE_SERVICE=<file>: while that file exists, the service step fails once (it is deleted) as an
	// update's did on macOS: launchd refused the bootstrap while the old server still drained.
	const refuse = process.env.FAKE_AI_MEMORY_REFUSE_SERVICE;
	if (refuse && existsSync(refuse)) {
		rmSync(refuse);
		console.log(
			"problem: service: `launchctl bootstrap gui/501 ai-memory.plist` failed: Bootstrap failed: 5: Input/output error",
		);
		process.exit(1);
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
	// Every agent it finds: a planted Claude Code wiring goes too.
	if (claudeWired()) rmSync(claudeSettings, { force: true });
	for (const name of managedSkills()) rmSync(join(skillsRoot, name), { recursive: true, force: true });
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

interface FakePage {
	path: string;
	title: string;
	kind: string;
	tier: string;
	pinned: boolean;
	id: string;
	updated_at: string;
	body: string;
	tags: string[];
	/** Frontmatter `origin_device`: the computer this page is a copy from. */
	origin?: string;
	/** Frontmatter `expires_at`: past it the page leaves the page list (a retired page). */
	expires?: string;
}
interface FakeHandoff {
	id: string;
	agent: string;
	at: string;
	state: string;
	summary: string;
	open_questions: string[];
	next_steps: string[];
}

const WORKSPACE = "fixture";
const PROJECTS = [
	{ workspace_name: WORKSPACE, project_name: "alpha", page_count: 4, last_updated: "2026-10-17T10:00:00Z" },
	{ workspace_name: WORKSPACE, project_name: "beta", page_count: 1, last_updated: "2026-10-01T10:00:00Z" },
];
// FAKE_AI_MEMORY_UPKEEP=1: a third project holding what the old titling left behind (the quality upkeep's repair reads it).
const UPKEEP = process.env.FAKE_AI_MEMORY_UPKEEP === "1";
const WRAPPED_PROMPT =
	'<ompdesk-agent-message from="부모 세션">\nTitle: 맥 자동업데이트 확인\n\nCheck the updater.\n</ompdesk-agent-message>';
const WRAPPED_TITLE = '<ompdesk-agent-message from="부모 세션">';
if (UPKEEP)
	PROJECTS.push({
		workspace_name: WORKSPACE,
		project_name: "gamma",
		page_count: 1,
		last_updated: "2026-10-18T10:00:00Z",
	});
let idCounter = 0;
const page = (path: string, title: string, kind: string, tier: string, updated: string, body: string): FakePage => ({
	path,
	title,
	kind,
	tier,
	pinned: false,
	id: `v${++idCounter}`,
	updated_at: updated,
	body,
	tags: [],
});
/** The stateful wiki: write, delete and restore change it for the life of the server process. */
const PAGES: Record<string, FakePage[]> = {
	alpha: [
		page(
			"sessions/s1.md",
			"Session: fix the cache",
			"session",
			"episodic",
			"2026-10-17T10:00:00Z",
			"# Session\n\nFixed the cache.",
		),
		page(
			"decisions/0007-db.md",
			"Use SQLite for the cache",
			"decision",
			"semantic",
			"2026-10-16T10:00:00Z",
			"# Use SQLite for the cache\n\nWe chose SQLite for the cache because it ships with Bun.",
		),
		page(
			"_rules/style.md",
			"Keep functions short",
			"rule",
			"semantic",
			"2026-10-15T10:00:00Z",
			"# Keep functions short\n\nUnder forty lines.",
		),
		page("notes/ideas.md", "Ideas", "note", "semantic", "2026-10-14T10:00:00Z", "# Ideas\n\nTry a ring buffer."),
	],
	gamma: UPKEEP
		? [
				page(
					"sessions/junk1.md",
					WRAPPED_TITLE,
					"session",
					"episodic",
					"2026-10-18T10:00:00Z",
					`# ${WRAPPED_TITLE}\n\n## Prompts\n\n1. ${WRAPPED_TITLE}\n`,
				),
			]
		: [],
	beta: [
		page(
			"notes/readme.md",
			"Beta notes",
			"note",
			"semantic",
			"2026-10-01T10:00:00Z",
			"# Beta notes\n\nSQLite is also used here.",
		),
	],
};
const DELETED: Record<string, FakePage> = {};
const HANDOFFS: Record<string, FakeHandoff[]> = {
	alpha: [
		{
			id: "h-1",
			agent: "omp",
			at: "2026-10-17T10:00:00Z",
			state: "open",
			summary: "Cache fix half done; next: add the eviction test.",
			open_questions: ["Which eviction policy?"],
			next_steps: ["Add the eviction test"],
		},
		{
			id: "h-0",
			agent: "omp",
			at: "2026-10-10T10:00:00Z",
			state: "accepted",
			summary: "Earlier work.",
			open_questions: [],
			next_steps: [],
		},
	],
	beta: [],
	gamma: UPKEEP
		? [
				{
					id: "h-child",
					agent: "omp",
					at: "2026-10-18T10:00:00Z",
					state: "open",
					summary: `Started: ${WRAPPED_TITLE}\nTitle: 맥 자동업데이트 확인`,
					open_questions: [],
					next_steps: [],
				},
				{
					id: "h-main",
					agent: "omp",
					at: "2026-10-18T09:00:00Z",
					state: "open",
					summary: "Session focused on: 이제 업데이트 완료했어",
					open_questions: [],
					next_steps: [],
				},
			]
		: [],
};
const SESSIONS: Record<string, Record<string, unknown>[]> = {
	alpha: [
		{
			session_id: "s-big",
			cwd: "/work/alpha",
			agent_kind: "omp",
			started_at: "2026-10-17T09:00:00Z",
			ended_at: "2026-10-17T10:00:00Z",
			observation_count: 60,
			actor_user: null,
			consolidation: null,
		},
		{
			session_id: "s-open",
			cwd: "/work/alpha",
			agent_kind: "omp",
			started_at: "2026-10-17T11:00:00Z",
			ended_at: null,
			observation_count: 2,
			actor_user: null,
			consolidation: { state: "running", attempts: 1 },
		},
	],
	beta: [],
	gamma: UPKEEP
		? [
				{
					session_id: "junk1",
					cwd: "/work/gamma",
					agent_kind: "omp",
					started_at: "2026-10-18T09:00:00Z",
					ended_at: "2026-10-18T10:00:00Z",
					observation_count: 1,
					actor_user: null,
					consolidation: null,
				},
			]
		: [],
};

interface FakeConclusion {
	seq: number;
	workspace: string;
	project: string;
	id: string;
	session_id: string;
	title: string;
	body: string;
	created_at: string;
	origin_device?: string;
}
/** Stop observations captured here, then conclusions written by another computer (`origin_device`). */
const NATIVE: FakeConclusion[] = [];
const SYNCED: FakeConclusion[] = [];
function capture(row: Record<string, unknown>): void {
	NATIVE.push({
		seq: NATIVE.length + 1,
		workspace: WORKSPACE,
		project: String(row.project),
		id: String(row.id),
		session_id: String(row.session_id),
		title: String(row.title ?? row.session_id),
		body: String(row.body),
		created_at: String(row.created_at ?? new Date().toISOString()),
	});
}
for (const row of JSON.parse(process.env.FAKE_AI_MEMORY_CONCLUSIONS ?? "[]") as Record<string, unknown>[]) capture(row);
const CONCLUSION_BODY_BYTES = 2000;
const scrubbed = (text: string): string => text.replace(/\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{16,}/g, "<token>");
function cutBytes(text: string, max: number): string {
	let kept = "";
	for (const char of text) {
		if (Buffer.byteLength(kept + char) > max) break;
		kept += char;
	}
	return kept;
}
let revCounter = 0;
const checkpoints: string[] = ["rev-0"];

function viewOf(entry: FakePage) {
	return { path: entry.path, title: entry.title, kind: entry.kind, tier: entry.tier, updated_at: entry.updated_at };
}

function serve(): void {
	const dir = argv[1] ?? dataDir;
	const bind = /^\s*bind\s*=\s*"([^"]+)"/m.exec(readFileSync(join(dir, "config.toml"), "utf8"))?.[1] ?? "";
	const token = readFileSync(join(dir, "auth-tokens", "default"), "utf8").trim();
	const [hostname, port] = [bind.slice(0, bind.lastIndexOf(":")), Number(bind.slice(bind.lastIndexOf(":") + 1))];
	const json = (body: unknown, status = 200) => Response.json(body, { status });
	const logRequest = (entry: Record<string, unknown>) => {
		if (logFile) appendFileSync(`${logFile}.requests`, `${JSON.stringify(entry)}\n`);
	};
	Bun.serve({
		hostname,
		port,
		async fetch(request) {
			const url = new URL(request.url);
			const authorized = request.headers.get("authorization") === `Bearer ${token}`;
			const body: Record<string, unknown> = request.method === "POST" ? await request.json().catch(() => ({})) : {};
			const tool =
				url.pathname === "/mcp" && typeof (body.params as { name?: unknown } | undefined)?.name === "string"
					? (body.params as { name: string }).name
					: undefined;
			logRequest({
				path: url.pathname,
				authorized,
				...(request.method === "POST" ? { method: "POST", tool, body } : {}),
			});
			if (url.pathname === "/healthz") return new Response("ok");
			if (!authorized) return json({ error: "unauthorized" }, 401);
			if (url.pathname === "/admin/status") {
				return json({
					version: VERSION,
					counts: { pages_latest: 4, sessions: 2, observations: 17 },
					storage: { database_bytes: 8192 },
				});
			}
			if (url.pathname === "/api/v1/projects") {
				return json(
					PROJECTS.map(project => ({ ...project, page_count: PAGES[project.project_name]?.length ?? 0 })),
				);
			}
			if (url.pathname === "/api/v1/search") {
				const query = (url.searchParams.get("q") ?? "").toLowerCase();
				const scope = url.searchParams.get("project");
				const hits: unknown[] = [];
				for (const [name, list] of Object.entries(PAGES)) {
					if (scope && scope !== name) continue;
					for (const entry of list) {
						if (!query || !`${entry.title} ${entry.body}`.toLowerCase().includes(query)) continue;
						const at = entry.body.toLowerCase().indexOf(query);
						const snippet =
							`${entry.body.slice(0, at)}<mark>${entry.body.slice(at, at + query.length)}</mark>${entry.body.slice(at + query.length)}`
								.replace(/^#.*\n+/, "")
								.slice(0, 120);
						hits.push({
							workspace: WORKSPACE,
							project: name,
							path: entry.path,
							title: entry.title,
							kind: entry.kind,
							snippet,
							rank: -1,
						});
					}
				}
				return json(hits);
			}
			if (url.pathname === "/admin/checkpoints")
				return json(checkpoints.slice(-1).map(oid => ({ oid, short_oid: oid, time: 0, summary: "" })));
			if (url.pathname === "/admin/profile/status") {
				return json({
					enabled: "auto",
					effective_share: "global",
					inject_on_session_start: true,
					digest_bytes: 64,
				});
			}
			if (url.pathname === "/admin/profile/list") {
				return json({
					scope: { workspace: "default", project: "_global" },
					entries: [
						{
							path: "profile/tools/bun.md",
							category: "tools",
							statement: "Use Bun, not npm.",
							applies_to: ["javascript"],
							enforced_by: null,
						},
					],
				});
			}
			if (url.pathname === "/admin/lint") {
				return json({
					findings: [
						{
							kind: "orphan",
							severity: "warning",
							message: "Nothing links to Ideas",
							pages: ["notes/ideas.md"],
							detail: null,
						},
					],
				});
			}
			if (url.pathname === "/admin/forget-sweep") {
				const dry = body.dry_run === true;
				return json({
					dry_run: dry,
					candidates_evaluated: 4,
					evicted: dry ? [{ path: "notes/ideas.md" }] : [],
					compacted: [],
					merged: [],
					expired: [],
					observations_prunable: 0,
					observations_pruned: 0,
				});
			}
			if (url.pathname === "/admin/write-page") {
				const list = PAGES[String(body.project)] ?? [];
				const existing = list.find(entry => entry.path === body.path);
				// As OMPdesk's server: only over the version named, or only where nothing is yet; else 409.
				const moved =
					(body.create_only === true && existing !== undefined) ||
					(typeof body.expected_page_id === "string" && existing?.id !== body.expected_page_id);
				if (moved) return json({ error: `precondition failed for ${String(body.path)}` }, 409);
				const next = page(
					String(body.path),
					String(body.title ?? existing?.title ?? body.path),
					String(body.kind ?? existing?.kind ?? "note"),
					String(body.tier ?? existing?.tier ?? "semantic"),
					new Date().toISOString(),
					String(body.body),
				);
				next.pinned = body.pinned === true;
				next.tags = Array.isArray(body.tags) ? (body.tags as string[]) : [];
				if (typeof body.origin_device === "string" && body.origin_device.trim())
					next.origin = body.origin_device.trim();
				if (typeof body.expires_at === "string" && body.expires_at.trim()) next.expires = body.expires_at.trim();
				PAGES[String(body.project)] = [next, ...list.filter(entry => entry.path !== body.path)];
				checkpoints.push(`rev-${++revCounter}`);
				return json({ page_id: next.id, path: next.path });
			}
			if (url.pathname === "/__fake/capture") {
				capture(body);
				return json({ seq: NATIVE.length });
			}
			if (url.pathname === "/admin/conclusions") {
				const source = url.searchParams.get("source");
				const after = Number(url.searchParams.get("after") ?? 0);
				const limit = Number(url.searchParams.get("limit") ?? 200);
				if (
					(source !== "native" && source !== "synced") ||
					!Number.isInteger(after) ||
					after < 0 ||
					!Number.isInteger(limit) ||
					limit < 1 ||
					limit > 500
				)
					return json({ error: "invalid conclusions query" }, 422);
				const rows = (source === "native" ? NATIVE : SYNCED).filter(row => row.seq > after);
				const page = rows.slice(0, limit);
				return json({
					conclusions: page.map(
						({ seq, workspace, project, id, session_id, title, body, created_at, origin_device }) => ({
							seq,
							workspace,
							project,
							id,
							session_id,
							title,
							body,
							created_at,
							...(source === "synced" ? { origin_device } : {}),
						}),
					),
					next: page.at(-1)?.seq ?? after,
					more: rows.length > page.length,
				});
			}
			if (url.pathname === "/admin/write-conclusions") {
				const items = Array.isArray(body.conclusions) ? (body.conclusions as Record<string, unknown>[]) : [];
				const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
				const origin = body.origin_device;
				const valid =
					text(body.workspace) &&
					text(body.project) &&
					text(origin) &&
					origin.length <= 128 &&
					items.length >= 1 &&
					items.length <= 500 &&
					items.every(
						item =>
							text(item.id) &&
							item.id.length <= 128 &&
							!/\s/.test(item.id) &&
							text(item.session_id) &&
							typeof item.title === "string" &&
							typeof item.body === "string" &&
							text(item.created_at) &&
							!Number.isNaN(Date.parse(item.created_at)),
					);
				if (!valid) return json({ error: "invalid conclusions" }, 422);
				const results = items.map(item => {
					const stored = cutBytes(scrubbed(String(item.body)), CONCLUSION_BODY_BYTES);
					if (!stored.trim()) return { id: item.id, status: "skipped" };
					if (SYNCED.some(row => row.project === body.project && row.id === item.id))
						return { id: item.id, status: "same" };
					SYNCED.push({
						seq: SYNCED.length + 1,
						workspace: String(body.workspace),
						project: String(body.project),
						id: String(item.id),
						session_id: String(item.session_id),
						title: [...scrubbed(String(item.title))].slice(0, 500).join(""),
						body: stored,
						created_at: String(item.created_at),
						origin_device: String(origin),
					});
					return { id: item.id, status: "written" };
				});
				return json({ results });
			}
			if (url.pathname === "/admin/delete-page") {
				const key = String(body.project);
				const list = PAGES[key] ?? [];
				const found = list.find(entry => entry.path === body.path);
				if (!found) return json({ error: "page not found" }, 404);
				const pre = `rev-pre-${++revCounter}`;
				DELETED[pre] = found;
				PAGES[key] = list.filter(entry => entry !== found);
				return json({ path: found.path, deleted: true, pre_checkpoint: pre });
			}
			if (url.pathname === "/admin/restore-page") {
				const found = DELETED[String(body.rev)];
				if (!found) return json({ error: "unknown revision" }, 404);
				const key = String(body.project);
				PAGES[key] = [
					{ ...found, id: `v${++idCounter}`, updated_at: new Date().toISOString() },
					...(PAGES[key] ?? []),
				];
				return json({ page_id: "restored", path: found.path, restored_from: body.rev });
			}
			if (url.pathname === "/mcp") {
				const args = ((body.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ??
					{}) as Record<string, unknown>;
				const reply = (payload: unknown) =>
					json({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
					});
				if (tool === "memory_handoff_cancel") {
					const entry = (HANDOFFS[String(args.project)] ?? []).find(item => item.id === args.handoff_id);
					if (!entry)
						return json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "handoff not found" } });
					const open = entry.state === "open";
					if (open) entry.state = "expired";
					return reply({ handoff_id: entry.id, cancelled: open, state: entry.state });
				}
				if (tool === "memory_write_page") {
					const key = String(args.project);
					const list = PAGES[key] ?? [];
					const existing = list.find(entry => entry.path === args.path);
					if (args.create_only === true && existing)
						return json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "precondition failed" } });
					if (typeof args.expected_page_id === "string" && existing?.id !== args.expected_page_id)
						return json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "precondition failed" } });
					const text = String(args.body);
					const next = page(
						String(args.path),
						/^# (.*)$/m.exec(text)?.[1] ?? String(args.path),
						existing?.kind ?? String(args.kind ?? "note"),
						String(args.tier ?? "semantic"),
						new Date().toISOString(),
						text,
					);
					PAGES[key] = [next, ...list.filter(entry => entry.path !== args.path)];
					return reply({ page_id: next.id, path: next.path });
				}
				if (tool === "memory_query") {
					const terms = String(args.query ?? "")
						.toLowerCase()
						.split(/\s+/)
						.filter(Boolean);
					const hits: Record<string, unknown>[] = [];
					if (args.conclusions === true) {
						const seen = new Set<string>();
						for (const row of [...NATIVE, ...SYNCED]) {
							if (row.project !== args.project || seen.has(row.session_id)) continue;
							const haystack = `${row.title} ${row.body}`.toLowerCase();
							if (terms.length === 0 || !terms.every(term => haystack.includes(term))) continue;
							seen.add(row.session_id);
							const marked = terms.reduce(
								(text, term) =>
									text.replace(
										new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
										"<mark>$&</mark>",
									),
								row.body,
							);
							hits.push({
								session_id: row.session_id,
								title: row.title,
								excerpt: marked,
								created_at: row.created_at,
								rank: -1,
							});
						}
					}
					return reply({
						hits: [],
						...(hits.length ? { conclusion_hits: hits.slice(0, Number(args.limit ?? 10)) } : {}),
					});
				}
				if (tool === "memory_feedback") return reply({ ok: true, path: args.path, signal: args.signal });
				return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown tool" } });
			}
			const project = /^\/api\/v1\/workspaces\/fixture\/projects\/([^/]+)\/(.+)$/.exec(url.pathname);
			if (project) {
				const [, name = "", rest = ""] = project;
				const list = PAGES[name] ?? [];
				if (rest === "recent") return json(list.slice(0, 20).map(viewOf));
				if (rest === "pages") {
					const expired = (entry: FakePage) =>
						entry.expires !== undefined && Date.parse(entry.expires) <= Date.now();
					const all = url.searchParams.get("include_expired") === "true";
					return json(list.filter(entry => all || !expired(entry)).map(viewOf));
				}
				if (rest === "handoffs") return json({ handoffs: HANDOFFS[name] ?? [] });
				if (rest.startsWith("overview")) {
					return json({
						briefing: {
							counts: { pages_latest: list.length, sessions: 2, observations: 17 },
							activity_7d: { days: 7, sessions: 2, observations: 17, pages_updated: list.length },
							last_observation_at: "2026-10-17T10:30:00Z",
							pending_handoff_count: (HANDOFFS[name] ?? []).filter(item => item.state === "open").length,
						},
						health: { stale: 0, duplicates: 0, contradictions: 0, orphans: 1 },
					});
				}
				if (rest.startsWith("sessions") && !rest.includes("/")) return json({ sessions: SESSIONS[name] ?? [] });
				const observations = /^sessions\/([^/]+)\/observations$/.exec(rest);
				if (observations) {
					const sessionId = decodeURIComponent(observations[1] ?? "");
					const session = (SESSIONS[name] ?? []).find(item => item.session_id === sessionId);
					if (!session) return json({ error: "not found" }, 404);
					const offset = Number(url.searchParams.get("offset") ?? 0);
					if (name === "gamma") {
						const row = {
							id: "o-0",
							session_id: sessionId,
							kind: "user-prompt",
							title: WRAPPED_TITLE,
							body: WRAPPED_PROMPT,
							importance: 3,
							created_at: "2026-10-18T09:30:00Z",
						};
						return json({
							session,
							observations: offset === 0 ? [row] : [],
							total: 1,
							offset,
							limit: 50,
							order: "asc",
						});
					}
					const limit = Number(url.searchParams.get("limit") ?? 50);
					const count = Number(session.observation_count);
					const rows = Array.from({ length: Math.max(0, Math.min(limit, count - offset)) }, (_, index) => ({
						id: `o-${offset + index}`,
						session_id: sessionId,
						kind: offset + index === 0 ? "user-prompt" : "post-tool-use",
						title: `Observation ${offset + index + 1}`,
						body: `body ${offset + index + 1}`,
						importance: 3,
						created_at: "2026-10-17T09:30:00Z",
					}));
					return json({ session, observations: rows, total: count, offset, limit, order: "asc" });
				}
				const path = decodeURIComponent(rest.replace(/^pages\//, ""));
				const found = list.find(entry => entry.path === path);
				if (!found) return json({ error: "not found" }, 404);
				return json({
					id: found.id,
					title: found.title,
					kind: found.kind,
					tier: found.tier,
					pinned: found.pinned,
					created_at: found.updated_at,
					updated_at: found.updated_at,
					frontmatter: {
						tags: found.tags,
						summary: "1 prompt",
						...(found.origin ? { origin_device: found.origin } : {}),
						...(found.expires ? { expires_at: found.expires } : {}),
					},
					body_markdown: found.body,
				});
			}
			return json({ error: "not found" }, 404);
		},
	});
}
