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

const agentDir = join(homedir(), ".omp", "agent");
const omp = join(homedir(), ".bun", "bin", "omp");
describe.skipIf(!existsSync(omp) || !existsSync(join(agentDir, "agent.db")))("real stock stream metadata", () => {
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
				`
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { splitUrlScheme } from "@oh-my-pi/pi-tui/tools/url-scheme-host";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { decorateMessages, methods, readGroupTarget } from "./stream-metadata";
export default function(pi) {
 pi.on("session_start", async () => {
  const rows = (await Bun.file(${JSON.stringify(join(root, "replay.jsonl"))}).text()).split("\\n").filter(Boolean).map(line => JSON.parse(line));
  const messages = rows.filter(row => row.type === "message" && row.message?.role === "assistant").map(row => row.message);
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
   if ((target !== null) !== eligible) throw new Error("eligibility mismatch");
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
 });
}
`,
			);
			const result = spawnSync(
				omp,
				["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
				{
					env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_CONFIG_DIR: root, OMP_PROFILE: "", PI_PROFILE: "" },
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
			expect(report.probes).toEqual([
				{ path: "https://example.com" },
				{ path: "xd://lsp" },
				{ path: "src/a.ts", selector: "-5" },
				null,
			]);
			expect(report.rate).toBeCloseTo(64);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 40000);
});
