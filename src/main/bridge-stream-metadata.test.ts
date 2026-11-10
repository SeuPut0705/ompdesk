import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp, runBridgeProbe } from "./test-bridge-probe";

/**
 * The probe both suites run as a bridge extension: every `read` call of `messages` (a JS expression giving assistant
 * messages) must get a group target exactly when stock's own rule compacts it (its URL router's `compactTranscript`),
 * shown as stock's `splitPathAndSel` splits it; then the fixed probes and one sample of the session's token meter.
 */
const probeSource = (messages: string) => `
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { splitUrlScheme } from "@oh-my-pi/pi-tui/tools/url-scheme-host";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { decorateMessages, methods, readGroupTarget } from "./stream-metadata";
export default function(pi) {
 pi.on("session_start", async () => {
  try {
   const messages = ${messages};
   const decorated = decorateMessages(messages);
   let reads = 0;
   for (const message of decorated) for (const block of message.content ?? []) {
    if (block.type !== "toolCall" || block.name !== "read") continue;
    reads++;
    const target = block.arguments.__ompReadGroup;
    const rawPath = block.arguments.path ?? block.arguments.file_path;
    const scheme = typeof rawPath === "string" ? splitUrlScheme(rawPath)?.scheme : undefined;
    const spec = scheme ? InternalUrlRouter.instance().spec(scheme) : undefined;
    const eligible = typeof rawPath === "string" && (!spec || spec.compactTranscript === true);
    if ((target !== null) !== eligible) throw new Error("eligibility mismatch: " + scheme);
    if (target) {
     const expected = splitPathAndSel(block.arguments.path ?? block.arguments.file_path);
     if (target.path !== expected.path || target.selector !== expected.sel) throw new Error("display mismatch");
    }
   }
   const probes = ["https://example.com", "xd://lsp", "src/a.ts:-5", "skill://example"].map(path => readGroupTarget({path}));
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   session.tokenRate.seed(640, 10000);
   let rate;
   await methods["stream_metadata.start"]({}, {pi, session: () => session, emit: event => { if (event.type === "token_rate") rate = event.rate; }});
   console.error("STREAM_METADATA_RESULT=" + JSON.stringify({reads, probes, rate}));
   process.exit(0);
  } catch (error) {
   console.error("STREAM_METADATA_RESULT=" + JSON.stringify({ error: String((error && error.message) || error) }));
   process.exit(1);
  }
 });
}
`;

const PROBES = [{ path: "https://example.com" }, { path: "xd://lsp" }, { path: "src/a.ts", selector: "-5" }, null];

/**
 * The same rules on the installed omp wherever it is installed (CI included), over one `read` call of every kind of
 * path an agent passes. The replay below needs the person's own sessions, so it runs on a developer's machine only,
 * and until 10 Nov 2026 it was the only suite that asked stock about `readGroupTarget` and the token meter.
 */
describe.skipIf(!existsSync(omp))("stream metadata on stock omp", () => {
	it("groups a read exactly when stock compacts it, shows it as stock splits it, and samples the session meter", () => {
		const paths = [
			"src/a.ts",
			"src/a.ts:10-20",
			"notes.md:-5",
			"https://example.com/page",
			"xd://lsp",
			"skill://example",
			"agent://1-Worker",
			"artifact://12",
			"local://plan.md",
			"pr://12/diff",
			"issue://7",
			"mcp://resource",
			"history://1-Worker",
			"proc://bg_1",
			"omp://rpc.md",
			"rule://composer",
			"ssh://host/etc/hosts",
		];
		const messages = [
			{
				role: "assistant",
				content: paths.map((path, index) => ({
					type: "toolCall",
					id: `call_${index}`,
					name: "read",
					arguments: { path },
				})),
			},
		];
		expect(runBridgeProbe(probeSource(JSON.stringify(messages)), "STREAM_METADATA_RESULT")).toEqual({
			reads: paths.length,
			probes: PROBES,
			rate: 64,
		});
	}, 120_000);
});

const agentDir = join(homedir(), ".omp", "agent");
// The person's own agent folder: both files it copies. A CI runner where another stock suite's omp left an
// `agent.db` has no `config.yml`, and no transcript to replay.
const personsAgentDir = ["agent.db", "config.yml"].every(name => existsSync(join(agentDir, name)));
describe.skipIf(!existsSync(omp) || !personsAgentDir)("real stock stream metadata", () => {
	it("replays real read calls with stock eligibility/selectors and samples the session meter", () => {
		const root = mkdtempSync(join(tmpdir(), "ompdesk-stream-metadata-"));
		chmodSync(root, 0o700);
		try {
			copyFileSync(join(agentDir, "config.yml"), join(root, "config.yml"));
			const vacuum = spawnSync(
				"bun",
				[
					"-e",
					"import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1], {readonly:true}); db.exec('VACUUM INTO ' + JSON.stringify(process.argv[2])); db.close();",
					join(agentDir, "agent.db"),
					join(root, "agent.db"),
				],
				{ encoding: "utf8" },
			);
			expect(vacuum.status, vacuum.stderr).toBe(0);
			const sessions = join(agentDir, "sessions");
			// One that holds a `read` call: the first file listed may be a chat with none (it then replayed 0 reads).
			const transcript = readdirSync(sessions, { recursive: true }).find(
				name =>
					typeof name === "string" &&
					name.endsWith(".jsonl") &&
					readFileSync(join(sessions, name), "utf8").includes('"name":"read"'),
			);
			if (typeof transcript !== "string") throw new Error("No real persisted transcript to replay");
			copyFileSync(join(sessions, transcript), join(root, "replay.jsonl"));
			cpSync(resolve("resources/gui-bridge"), join(root, "bridge"), { recursive: true });
			const extension = join(root, "bridge", "probe.ts");
			writeFileSync(
				extension,
				probeSource(
					`(await Bun.file(${JSON.stringify(join(root, "replay.jsonl"))}).text()).split("\\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === "message" && row.message?.role === "assistant").map(row => row.message)`,
				),
			);
			const result = spawnSync(
				OMP_COMMAND.file,
				[
					...OMP_COMMAND.args,
					"--mode",
					"rpc",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"-e",
					extension,
				],
				{
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: root,
						PI_CONFIG_DIR: configDirName(root),
						OMP_PROFILE: "",
						PI_PROFILE: "",
					},
					encoding: "utf8",
					timeout: 30000,
					maxBuffer: 4 * 1024 * 1024,
				},
			);
			expect(result.status, result.stderr).toBe(0);
			const line = result.stderr.split("\n").find(line => line.startsWith("STREAM_METADATA_RESULT="));
			if (!line) throw new Error(`Stock probe did not report: ${result.stderr}`);
			const report = JSON.parse(line.slice("STREAM_METADATA_RESULT=".length)) as {
				reads: number;
				probes: unknown[];
				rate: number;
			};
			expect(report.reads).toBeGreaterThan(0);
			expect(report.probes).toEqual(PROBES);
			expect(report.rate).toBeCloseTo(64);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 40000);
});
