import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT_SERVER } from "./root";
import { AiMemoryService } from "./service";
import { EXTENSION_FILE, GENERATED_HEADER, MCP_FILE } from "./terminal";

/**
 * One memory capture per OMPdesk session on the installed omp, whatever omp's agent dir holds. omp loads the agent
 * dir's extensions and MCP entries for every process it starts, OMPdesk's own sessions included, so a person who wired
 * ai-memory into the terminal omp themselves (`ai-memory setup --agent omp`) used to get OMPdesk's root on top of it:
 * two capture extensions in one session. The "extensions" here are stand-ins that report which copy ran (a POST to a
 * loopback server on `session_start`, the event ai-memory's generated extension captures on); the arguments and the
 * wiring checks are `AiMemoryService.extensionArgs()`'s own.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
const SETTLE_MS = 2_500;
const WAIT_MS = 60_000;

interface Rig {
	dir: string;
	agentDir: string;
	rootDir: string;
	cwd: string;
	hits: string[];
	mcpLog: string;
	close(): Promise<void>;
	service(pref: boolean | undefined): AiMemoryService;
}

const CONFIG = "config.yml";
const rigs: Rig[] = [];

const captureExtension = (url: string, who: string, header = "") =>
	`${header}export default function (pi: any) {\n\tpi.on("session_start", async () => {\n\t\tawait fetch("${url}/${who}", { method: "POST" });\n\t});\n}\n`;

const mcpEntry = (log: string, who: string) => ({
	command: process.execPath,
	args: [
		"-e",
		`require("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${who}\n`)}); setTimeout(() => {}, 30000);`,
	],
});

/** The entry `ai-memory install-mcp` writes runs a binary named `ai-memory`; this one only reports that it started. */
const terminalMcpEntry = (dir: string, log: string) => {
	const bin = join(dir, "bin", "ai-memory");
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(bin, `#!/bin/sh\necho terminal-wiring >> "${log}"\nsleep 30\n`);
	chmodSync(bin, 0o755);
	return { command: bin, args: ["mcp-bridge"] };
};

async function makeRig(options: { agentWiring: boolean; disabled?: string[] }): Promise<Rig> {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-capture-"));
	const agentDir = join(dir, "agent");
	const rootDir = join(dir, "userData", "ai-memory", "omp-ext");
	const cwd = join(dir, "work");
	const mcpLog = join(dir, "mcp.log");
	for (const folder of [join(agentDir, "extensions"), join(rootDir, "skills", "ai-memory-handoff"), cwd]) {
		mkdirSync(folder, { recursive: true });
	}
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		hits.push((req.url ?? "").slice(1));
		res.end("{}");
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("loopback server has no port");
	const url = `http://127.0.0.1:${address.port}`;

	const cost = "{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }";
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  fake:\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        cost: ${cost}\n`,
	);
	const disabled = options.disabled?.length
		? `disabledExtensions:\n${options.disabled.map(id => `  - ${id}\n`).join("")}`
		: "";
	writeFileSync(join(agentDir, "config.yml"), `modelRoles:\n  default: fake/m1\n${disabled}`);

	// An extension of the person's own that they switched off: the overlay must not bring it back.
	if (options.disabled?.includes("extension-module:other")) {
		writeFileSync(join(agentDir, "extensions", "other.ts"), captureExtension(url, "other"));
	}
	writeFileSync(join(rootDir, "index.ts"), captureExtension(url, "ompdesk-root"));
	writeFileSync(
		join(rootDir, ".mcp.json"),
		JSON.stringify({ mcpServers: { [ROOT_SERVER]: mcpEntry(mcpLog, "ompdesk-root") } }),
	);
	writeFileSync(join(rootDir, "skills", "ai-memory-handoff", "SKILL.md"), "# skill\n");
	if (options.agentWiring) {
		writeFileSync(
			join(agentDir, EXTENSION_FILE),
			captureExtension(url, "terminal-wiring", `${GENERATED_HEADER} --apply\`.\n`),
		);
		writeFileSync(
			join(agentDir, MCP_FILE),
			JSON.stringify({ mcpServers: { "ai-memory": terminalMcpEntry(dir, mcpLog) } }),
		);
	}

	const rig: Rig = {
		dir,
		agentDir,
		rootDir,
		cwd,
		hits,
		mcpLog,
		close: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		},
		service: pref =>
			new AiMemoryService({
				platform: "darwin",
				arch: "arm64",
				automatic: true,
				toolsDir: join(dir, "tools"),
				bundledDir: null,
				binaryOverride: "/unused/ai-memory",
				home: join(dir, "home"),
				agentDir: () => agentDir,
				rootDir,
				terminalPref: () => pref,
				persistTerminal: () => undefined,
				spawnEnv: async () => ({}),
				onState: () => undefined,
			}),
	};
	rigs.push(rig);
	return rig;
}

/** One omp (`--mode rpc`, as OMPdesk starts it) in the rig's agent dir; resolves with what captured while it ran. */
async function runOmp(rig: Rig, args: string[]): Promise<string[]> {
	rig.hits.length = 0;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: rig.agentDir,
		PI_CONFIG_DIR: rig.agentDir,
		HOME: join(rig.dir, "home"),
		USERPROFILE: join(rig.dir, "home"),
		OMP_PROFILE: "",
		PI_PROFILE: "",
	};
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
		Reflect.deleteProperty(env, key);
	}
	const child = spawn(omp, ["--mode", "rpc", "--no-session", ...args], {
		cwd: rig.cwd,
		env,
		stdio: ["pipe", "ignore", "ignore"],
	});
	try {
		child.stdin.write(`${JSON.stringify({ id: "1", type: "get_state" })}\n`);
		const started = Date.now();
		// Real omp on a real clock: the first capture arrives when omp has booted, and a second one would arrive in the
		// same startup, so the run waits for the first and then a settle time no deterministic clock can stand in for.
		while (rig.hits.length === 0 && Date.now() - started < WAIT_MS) await sleep(100);
		await sleep(SETTLE_MS);
		return [...rig.hits].sort();
	} finally {
		child.kill();
	}
}

function mcpOwners(rig: Rig): string[] {
	return existsSync(rig.mcpLog)
		? [...new Set(readFileSync(rig.mcpLog, "utf8").split("\n").filter(Boolean))].sort()
		: [];
}

/** What the person owns in the agent dir (omp keeps its own state databases beside it), with its bytes. */
function personsFiles(agentDir: string): Record<string, string> {
	const names = [CONFIG, MCP_FILE, EXTENSION_FILE, join("extensions", "other.ts"), "models.yml"];
	return Object.fromEntries(names.map(name => [name, readFileSync(join(agentDir, name), "utf8")]));
}

afterEach(async () => {
	for (const rig of rigs.splice(0)) {
		await rig.close();
		rmSync(rig.dir, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32" || !existsSync(omp))(
	"one memory capture per OMPdesk session on stock omp",
	() => {
		it("the terminal omp, which OMPdesk never passes the root to, keeps capturing through the agent dir's extension", async () => {
			const rig = await makeRig({ agentWiring: true });
			expect(await runOmp(rig, [])).toEqual(["terminal-wiring"]);
		}, 120_000);

		it("no wiring in the agent dir: the root is the one capture and the one MCP entry", async () => {
			const rig = await makeRig({ agentWiring: false });
			const args = await rig.service(undefined).extensionArgs(rig.cwd);
			expect(args).toEqual(["-e", rig.rootDir]);
			expect(await runOmp(rig, args)).toEqual(["ompdesk-root"]);
			expect(mcpOwners(rig)).toEqual(["ompdesk-root"]);
		}, 120_000);

		for (const pref of [undefined, false] as const) {
			it(`wiring in the agent dir, terminal pref ${String(pref)}: OMPdesk's root is the one capture and the one MCP server, the agent dir stays as it was`, async () => {
				const rig = await makeRig({ agentWiring: true, disabled: ["extension-module:other"] });
				const before = personsFiles(rig.agentDir);
				const args = await rig.service(pref).extensionArgs(rig.cwd);
				expect(await runOmp(rig, args)).toEqual(["ompdesk-root"]);
				// One memory MCP server, OMPdesk's: the agent dir's `ai-memory` entry is held off for the spawn.
				expect(mcpOwners(rig)).toEqual(["ompdesk-root"]);
				expect(personsFiles(rig.agentDir)).toEqual(before);
			}, 120_000);
		}

		it("wiring in the agent dir the person connected (pref true): their extension is the one capture", async () => {
			const rig = await makeRig({ agentWiring: true });
			const args = await rig.service(true).extensionArgs(rig.cwd);
			expect(args).toEqual([]);
			expect(await runOmp(rig, args)).toEqual(["terminal-wiring"]);
			expect(mcpOwners(rig)).toEqual(["terminal-wiring"]);
		}, 120_000);
	},
);
