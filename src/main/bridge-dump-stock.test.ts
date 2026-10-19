import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

/**
 * "Save diagnostic bundle" on the installed omp (bridge `session_dump`, resources/gui-bridge/session-dump.ts), in
 * an empty private agent dir and temp dir (no model call). The bridge method calls the session methods stock's
 * `/dump all` and `/dump anon` run and returns their archive, so the GUI can copy the zip: over stock RPC the slash
 * command only prints the path inside a `command_output` text frame, which is why the method exists.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const SEED = `
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = content => ({ role: "user", content, timestamp: Date.now() });
const reply = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "gpt-probe", usage, stopReason: "stop", timestamp: Date.now() });
async function seed(session) {
 const sm = session.sessionManager;
 const question = user([{ type: "text", text: "dump probe question" }]);
 const answer = reply("dump probe answer");
 sm.appendMessage(question);
 sm.appendMessage(answer);
 await sm.flush();
 session.agent.replaceMessages([question, answer]);
}
`;

const BRIDGE_PROBE = `
import { methods } from "./session-dump";
${SEED}
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const empty = await methods.session_dump({}, env);
   await seed(session);
   const all = await methods.session_dump({}, env);
   const anon = await methods.session_dump({ anonymized: true }, env);
   console.error("DUMP_PROBE=" + JSON.stringify({ empty, all, anon }));
  } catch (err) {
   console.error("DUMP_PROBE_ERROR=" + String((err && err.stack) || err));
  }
  process.exit(0);
 });
}
`;

const RPC_PROBE = `
${SEED}
export default function (pi) {
 pi.on("session_start", async () => {
  await seed(pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session);
 });
}
`;

interface Archive {
	path: string;
	files: string[];
	subagentCount: number;
	anonymized: boolean;
}

function isolatedRun(
	probe: string,
	file: string,
	input: string,
	body: (dirs: { temp: string }, result: { stdout: string; stderr: string }) => Promise<void>,
): Promise<void> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-dump-"));
	chmodSync(isolated, 0o700);
	const temp = join(isolated, "tmp");
	mkdirSync(temp);
	cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
	const extension = join(isolated, "bridge", file);
	writeFileSync(extension, probe);
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: isolated,
		PI_CONFIG_DIR: isolated,
		TMPDIR: temp,
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OPENAI_API_KEY: "probe-not-a-real-key",
	};
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
		Reflect.deleteProperty(env, key);
	}
	const result = spawnSync(omp, ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "-e", extension], {
		env,
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 4 * 1024 * 1024,
		input,
	});
	return body({ temp }, result).finally(() => rmSync(isolated, { recursive: true, force: true }));
}

const members = async (file: string) => Object.keys((await JSZip.loadAsync(await readFile(file))).files).sort();

describe.skipIf(!existsSync(omp))("session dump on stock omp", () => {
	it("hands back stock's `/dump all` and `/dump anon` zips: session.md for all, session.jsonl for anon, null while empty", async () => {
		await isolatedRun(BRIDGE_PROBE, "dump-probe.ts", "", async (_dirs, { stderr }) => {
			const line = stderr.split("\n").find(value => value.startsWith("DUMP_PROBE="));
			expect(line, stderr.slice(-2500)).toMatch(/^DUMP_PROBE=/);
			const out = JSON.parse(line?.slice("DUMP_PROBE=".length) ?? "{}") as {
				empty: null;
				all: Archive;
				anon: Archive;
			};
			expect(out.empty).toBeNull();
			expect(out.all.anonymized).toBe(false);
			expect(out.all.files).toEqual(expect.arrayContaining(["session.md"]));
			expect(await members(out.all.path)).toEqual(expect.arrayContaining(["session.md"]));
			expect(out.anon.anonymized).toBe(true);
			expect(out.anon.files).toEqual(["session.jsonl"]);
			expect(await members(out.anon.path)).toEqual(["session.jsonl"]);
			const transcript = await (await JSZip.loadAsync(await readFile(out.all.path))).files["session.md"]?.async(
				"string",
			);
			expect(transcript).toContain("dump probe question");
		});
	}, 130_000);

	it("answers `/dump all` over RPC with a command_output text frame only: no structured archive to copy", async () => {
		const input = `${JSON.stringify({ id: "d1", type: "prompt", message: "/dump all" })}\n`;
		await isolatedRun(RPC_PROBE, "rpc-probe.ts", input, async ({ temp }, { stdout }) => {
			const frames = stdout
				.split("\n")
				.filter(value => value.startsWith("{"))
				.map(value => JSON.parse(value) as Record<string, unknown>);
			const output = frames.find(frame => frame.type === "command_output");
			expect(output, stdout.slice(-2500)).toBeDefined();
			expect(String(output?.text)).toMatch(/Session dump archive: .*omp-dump-.*\.zip/);
			// Nothing in the frame is data: the path is prose, and no frame carries the archive as a field.
			expect(Object.keys(output ?? {}).sort()).toEqual(["text", "type"]);
			expect(frames.some(frame => "path" in frame && String(frame.path).endsWith(".zip"))).toBe(false);
			expect(temp).toBeTruthy();
		});
	}, 130_000);
});
