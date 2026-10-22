/**
 * The Settings MCP list and the live-session sync on the installed omp (stock pinned): two scenarios, each a real
 * `omp --mode rpc-ui` with the bridge's MCP module, in a temp HOME and agent dir.
 *
 * 1. A server that answers 401 with an OAuth challenge lists as needing a sign-in, and once another omp of this
 *    computer stored its credential (what a sign-in in another tab does), `mcp_sync` connects it and its tool is
 *    the live session's (the user's report, 21 Oct 2026: signed in, `No such tool: xd://mcp__…` in the session).
 * 2. Servers only Codex's `~/.codex/config.toml` declares list as found in another tool; adopting one makes exactly
 *    that one active, the other stays off, and no other Codex capability (its skills) appears.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALLED_OMP } from "./test-bridge-probe";

const installed = fs.existsSync(INSTALLED_OMP);
const TOKEN = "good-token-0123456789";

/**
 * Answers stock's streamable HTTP client at /mcp: 401 with an OAuth challenge at once until a request carries the
 * token, then one tool. With `oauth`, it is also its own authorization server (RFC 9728 resource metadata, RFC 8414
 * server metadata, dynamic client registration, an authorize endpoint that approves at once, a token endpoint), so
 * the bridge's real sign-in runs end to end; without it nothing ever signs it in.
 */
function fakeOAuthMcp(oauth = true): Promise<{ url: string; close: () => void }> {
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += String(chunk);
		});
		req.on("end", () => {
			const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const url = new URL(req.url ?? "/", origin);
			const json = (status: number, value: unknown) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(value));
			};
			if (oauth && url.pathname.startsWith("/.well-known/oauth-protected-resource"))
				return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
			if (oauth && url.pathname.startsWith("/.well-known/oauth-authorization-server"))
				return json(200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			if (oauth && url.pathname === "/register")
				return json(201, { client_id: "fake-client", ...(JSON.parse(body || "{}") as object) });
			if (oauth && url.pathname === "/authorize") {
				const back = new URL(url.searchParams.get("redirect_uri") ?? "");
				back.searchParams.set("code", "fake-code");
				back.searchParams.set("state", url.searchParams.get("state") ?? "");
				res.writeHead(302, { Location: back.toString() }).end();
				return;
			}
			if (oauth && url.pathname === "/token")
				return json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh" });
			if (!oauth || req.headers.authorization !== `Bearer ${TOKEN}`) {
				res.writeHead(401, {
					"WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
					"Content-Type": "application/json",
				});
				res.end(JSON.stringify({ error: "invalid_token" }));
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
			if (message.id === undefined) {
				res.writeHead(202).end();
				return;
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "fake-oauth", version: "1" },
						}
					: message.method === "tools/list"
						? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] }
						: {};
			json(200, { jsonrpc: "2.0", id: message.id, result });
		});
	});
	const { promise, resolve } = Promise.withResolvers<{ url: string; close: () => void }>();
	server.listen(0, "127.0.0.1", () => {
		resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => server.close() });
	});
	return promise;
}

const STDIO_SERVER = `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	const result = request.method === "initialize"
		? { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stdio-probe", version: "1" } }
		: request.method === "tools/list"
			? { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }] }
			: {};
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;

/** The live session's view: the bridge's row for `name` and the session's tools that name it. */
const PROBE_HELPERS = `
import { methods as mcp } from "./extensions/mcp";
const until = async (check, ms) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await Bun.sleep(100);
	}
	return check();
};
const view = async (env, session, name) => ({
	row: (await mcp.get_mcp_servers({}, env)).servers.find(server => server.name === name),
	tools: session.getEnabledToolNames().filter(tool => tool.includes(name)),
});
`;

function signInProbe(report: string, go: string): string {
	return `${PROBE_HELPERS}
export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		const out = {};
		try {
			const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
			const env = { pi, session: () => session, context: () => ctx, emit: () => {} };
			await until(async () => (await view(env, session, "fake")).row?.authState === "required", 20_000);
			out.before = await view(env, session, "fake");
			await Bun.write(${JSON.stringify(`${report}.ready`)}, "1");
			await until(() => Bun.file(${JSON.stringify(go)}).exists(), 60_000);
			out.sync = await mcp.mcp_sync({ names: ["fake"] }, env);
			await until(async () => (await view(env, session, "fake")).row?.status === "connected", 15_000);
			out.after = await view(env, session, "fake");
		} catch (error) {
			out.error = error.stack ?? String(error);
		}
		await Bun.write(${JSON.stringify(report)}, JSON.stringify(out));
	});
}
`;
}

/**
 * The real add and sign-in paths: `mcp_add` of a server that answers 401 at once, then `mcp_reauth` while another
 * server still refuses. The open_url frame the flow emits is followed as a browser would.
 */
function addAndSignInProbe(report: string, url: string, add = true): string {
	return `${PROBE_HELPERS}
export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		const out = { opened: 0 };
		try {
			const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
			const emit = frame => {
				if (frame.method !== "open_url") return;
				out.opened++;
				void fetch(frame.url, { redirect: "follow" }).catch(error => { out.browser = String(error); });
			};
			const env = { pi, session: () => session, context: () => ctx, emit };
			if (${add}) out.add = await mcp.mcp_add({ name: "fake", scope: "user", config: { transport: "http", url: ${JSON.stringify(url)} } }, env);
			out.reauth = await mcp.mcp_reauth({ name: "fake" }, env);
			await until(async () => (await view(env, session, "fake")).row?.status === "connected", 15_000);
			out.after = { fake: await view(env, session, "fake"), other: await view(env, session, "other") };
		} catch (error) {
			out.error = error.stack ?? String(error);
		}
		await Bun.write(${JSON.stringify(report)}, JSON.stringify(out));
	});
}
`;
}

/** Another omp of the same agent dir signs in: it stores the credential as the bridge's OAuth flow does. */
function credentialProbe(url: string): string {
	return `
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
export default function (pi) {
	pi.on("session_start", async () => {
		const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
		await session.modelRegistry.authStorage.credentials.set(mcpOAuthCredentialId(${JSON.stringify(url)}), {
			type: "oauth", access: ${JSON.stringify(TOKEN)}, refresh: "refresh", expires: Date.now() + 3_600_000,
		});
		console.error("signed=ok");
	});
}
`;
}

function adoptProbe(report: string): string {
	return `${PROBE_HELPERS}
import { isUserSourceEnabled } from "@oh-my-pi/pi-coding-agent/capability";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		const out = {};
		try {
			const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
			const env = { pi, session: () => session, context: () => ctx, emit: () => {} };
			const cwd = session.sessionManager.getCwd();
			out.before = { alpha: await view(env, session, "alpha"), beta: await view(env, session, "beta") };
			out.stockReasons = (await loadAllExtensions(cwd)).filter(item => item.kind === "mcp").map(item => [item.name, item.state, item.disabledReason]);
			out.adopted = await mcp.mcp_action({ name: "alpha", action: "adopt" }, env);
			await until(async () => (await view(env, session, "alpha")).row?.status === "connected", 15_000);
			out.after = { alpha: await view(env, session, "alpha"), beta: await view(env, session, "beta") };
			out.codexOptedIn = isUserSourceEnabled("codex");
			out.skills = session.skills.map(skill => skill.name);
		} catch (error) {
			out.error = error.stack ?? String(error);
		}
		await Bun.write(${JSON.stringify(report)}, JSON.stringify(out));
	});
}
`;
}

interface Profile {
	root: string;
	home: string;
	agentDir: string;
	project: string;
	bridge: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeProfile(): Profile {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-mcp-stock-"));
	fs.chmodSync(root, 0o700);
	const profile = {
		root,
		home: path.join(root, "home"),
		agentDir: path.join(root, "home", ".omp", "agent"),
		project: path.join(root, "project"),
		bridge: path.join(root, "bridge"),
	};
	fs.mkdirSync(profile.agentDir, { recursive: true });
	fs.mkdirSync(profile.project, { recursive: true });
	fs.cpSync(path.resolve("resources/gui-bridge"), profile.bridge, { recursive: true });
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return profile;
}

function ompEnv(profile: Profile): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: profile.home,
		USERPROFILE: profile.home,
		PI_CODING_AGENT_DIR: profile.agentDir,
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OPENAI_API_KEY: "probe-not-a-real-key",
	};
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"])
		delete env[key];
	return env;
}

/** A live `omp --mode rpc-ui` with `extension`, until `report` is written. */
async function runLive(profile: Profile, extension: string, report: string, during?: () => Promise<void>) {
	const file = path.join(profile.bridge, `probe-${path.basename(report)}.ts`);
	fs.writeFileSync(file, extension);
	const child = spawn(INSTALLED_OMP, ["--mode", "rpc-ui", "--no-extensions", "--no-rules", "-e", file], {
		cwd: profile.project,
		env: ompEnv(profile),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += String(chunk);
	});
	child.stdout.resume();
	cleanups.push(() => {
		child.stdin.end();
		child.kill("SIGTERM");
	});
	const deadline = Date.now() + 110_000;
	const waitFor = async (target: string) => {
		while (!fs.existsSync(target)) {
			if (child.exitCode !== null || stderr.includes("Failed to load extension"))
				throw new Error(`omp exited or refused the probe: ${stderr.slice(-2000)}`);
			if (Date.now() > deadline) throw new Error(`no ${path.basename(target)}: ${stderr.slice(-2000)}`);
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	};
	if (during) {
		await waitFor(`${report}.ready`);
		await during();
	}
	await waitFor(report);
	const out = JSON.parse(fs.readFileSync(report, "utf8")) as Record<string, unknown>;
	expect(out.error, stderr.slice(-2000)).toBeUndefined();
	return out;
}

describe.skipIf(!installed)("MCP servers on the installed omp", () => {
	it("connects a server another session signed in to, and its tool joins this live session", async () => {
		const profile = makeProfile();
		const fake = await fakeOAuthMcp();
		cleanups.push(fake.close);
		fs.writeFileSync(
			path.join(profile.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { fake: { type: "http", url: fake.url } } }),
		);
		const report = path.join(profile.root, "signin.json");
		const go = path.join(profile.root, "go");
		const out = await runLive(profile, signInProbe(report, go), report, async () => {
			const signer = path.join(profile.bridge, "signer.ts");
			fs.writeFileSync(signer, credentialProbe(fake.url));
			const signed = spawnSync(
				INSTALLED_OMP,
				["--mode", "rpc", "--no-session", "--no-extensions", "--no-rules", "-e", signer],
				{ cwd: profile.project, env: ompEnv(profile), encoding: "utf8", input: "", timeout: 60_000 },
			);
			expect(signed.stderr, signed.stderr.slice(-2000)).toContain("signed=ok");
			fs.writeFileSync(go, "1");
		});
		const before = out.before as { row: Record<string, unknown>; tools: string[] };
		expect(before.row).toMatchObject({ enabled: true, status: "disconnected", authState: "required" });
		expect(String(before.row.lastError)).toContain("401");
		expect(before.tools).toEqual([]);
		expect(out.sync).toMatchObject({ connected: ["fake"], failed: [] });
		const after = out.after as { row: Record<string, unknown>; tools: string[] };
		expect(after.row).toMatchObject({ status: "connected", authState: "authorized", toolCount: 1 });
		expect(after.row.lastError).toBeUndefined();
		expect(after.tools.length).toBeGreaterThan(0);
	}, 150_000);

	it("adds a server that answers 401 at once and signs in to it while another server still refuses", async () => {
		const profile = makeProfile();
		const fake = await fakeOAuthMcp();
		const other = await fakeOAuthMcp(false);
		cleanups.push(fake.close, other.close);
		fs.writeFileSync(
			path.join(profile.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { other: { type: "http", url: other.url } } }),
		);
		const report = path.join(profile.root, "add-signin.json");
		const out = await runLive(profile, addAndSignInProbe(report, fake.url), report);
		// The add is saved and answered, the 401 is the server's state, not a failed add.
		expect(out.add).toMatchObject({ added: true, server: { name: "fake", enabled: true, authState: "required" } });
		expect(String((out.add as { warning?: string }).warning)).toContain("fake");
		// The sign-in succeeds although `other` still fails to connect in the same reload.
		expect(out.reauth).toEqual({ ok: true });
		expect(out.opened).toBe(1);
		type View = { row: Record<string, unknown>; tools: string[] };
		const after = out.after as { fake: View; other: View };
		expect(after.fake.row).toMatchObject({ status: "connected", authState: "authorized", toolCount: 1 });
		expect(after.fake.tools.length).toBeGreaterThan(0);
		expect(after.other.row).toMatchObject({ status: "disconnected", authState: "required" });
	}, 150_000);

	it("signs a server in over a stale bearer header the config carries", async () => {
		const profile = makeProfile();
		const fake = await fakeOAuthMcp();
		cleanups.push(fake.close);
		const config = path.join(profile.agentDir, "mcp.json");
		fs.writeFileSync(
			config,
			JSON.stringify({
				mcpServers: { fake: { type: "http", url: fake.url, headers: { Authorization: "Bearer stale-token" } } },
			}),
		);
		const report = path.join(profile.root, "stale-bearer.json");
		const out = await runLive(profile, addAndSignInProbe(report, fake.url, false), report);
		expect(out.error).toBeUndefined();
		expect(out.reauth).toEqual({ ok: true });
		// While the header stays, stock never reads the fresh credential: the next omp would send the stale bearer.
		const saved = JSON.parse(fs.readFileSync(config, "utf8")).mcpServers.fake as {
			headers?: Record<string, string>;
			auth?: { type?: string };
		};
		expect(saved.headers?.Authorization).toBeUndefined();
		expect(saved.auth).toMatchObject({ type: "oauth" });
	}, 150_000);

	it("uses one server Codex declares without reading the rest of Codex's config", async () => {
		const profile = makeProfile();
		const server = path.join(profile.root, "stdio-server.cjs");
		fs.writeFileSync(server, STDIO_SERVER);
		const codex = path.join(profile.home, ".codex");
		fs.mkdirSync(path.join(codex, "skills", "codex-only-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(codex, "skills", "codex-only-skill", "SKILL.md"),
			"---\nname: codex-only-skill\ndescription: Only Codex reads this\n---\nBody.\n",
		);
		// Distinct args: stock folds two servers with the same command line into one (equivalence dedupe).
		const toml = (name: string) =>
			`[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}, ${JSON.stringify(name)}]\n`;
		fs.writeFileSync(path.join(codex, "config.toml"), `${toml("alpha")}\n${toml("beta")}`);
		const report = path.join(profile.root, "adopt.json");
		const out = await runLive(profile, adoptProbe(report), report);

		type View = { row: Record<string, unknown>; tools: string[] };
		const before = out.before as { alpha: View; beta: View };
		for (const view of [before.alpha, before.beta]) {
			expect(view.row).toMatchObject({ enabled: false, offReason: { kind: "otherTool", provider: "codex" } });
		}
		const tool = (before.alpha.row.offReason as { tool: string }).tool;
		// Stock's dashboard says the same of both: a foreign `~/` config not opted in.
		expect(out.stockReasons).toEqual(
			expect.arrayContaining([
				["alpha", "disabled", "user-opt-in"],
				["beta", "disabled", "user-opt-in"],
			]),
		);
		expect(out.adopted).toMatchObject({ name: "alpha", action: "adopt", from: tool });

		const after = out.after as { alpha: View; beta: View };
		expect(after.alpha.row).toMatchObject({
			enabled: true,
			status: "connected",
			toolCount: 1,
			scope: "user",
			alsoIn: tool,
		});
		expect(after.alpha.row.offReason).toBeUndefined();
		expect(after.alpha.tools.length).toBeGreaterThan(0);
		expect(after.beta.row).toMatchObject({
			enabled: false,
			status: "disconnected",
			offReason: { kind: "otherTool" },
		});
		expect(after.beta.tools).toEqual([]);

		const written = JSON.parse(fs.readFileSync(path.join(profile.agentDir, "mcp.json"), "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect(Object.keys(written.mcpServers)).toEqual(["alpha"]);
		expect(written.mcpServers.alpha).toMatchObject({
			type: "stdio",
			command: process.execPath,
			args: [server, "alpha"],
		});
		expect(written.mcpServers.alpha.enabled).toBeUndefined();
		expect(out.codexOptedIn).toBe(false);
		expect(out.skills).not.toContain("codex-only-skill");
	}, 150_000);
});
