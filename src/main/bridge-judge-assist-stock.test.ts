import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The judge-model assists on the installed omp, no model spend: a loopback server stands in for the provider.
 * - No native judge (the `judge` role routes to a prompted chat model): `judge_assist.needs_user` answers
 *   `{needsUser: null}` and not one request leaves, to the chat model or anywhere else, so the code rules decide.
 * - A native judge (a catalog model on the `typesafe` judgment API, base URL on loopback): stock's own `resolveJudge`
 *   sends the question to `POST /v1/systemone`, the answer becomes the decision, and the usage lands in the session's
 *   journal as a `model_usage` entry whose purpose is `ompdesk-needs-user` (`journalJudgmentUsage`), the way auto
 *   mode's judgments are billed. The switch (`judge_assist_set {enabled: false}`) stops it with no request.
 * The journal is the live session's own (`getEntries()`), the probe runs under `--no-session`.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const ASKING = "I found two ways to fix it: patch the parser or rewrite the lexer. Which one do you want me to take?";
const REPORT = "I patched the parser and the tests pass. The change is in src/parser.ts.";

const PROBE = `
import { methods } from "./modes/judge-assist";
import { judgeAssistState } from "./modes/judge-assist-engine";
import { probe } from "./health";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const out = {};
   out.unavailable = (await probe(env, ["judgeAssist"])).map(entry => ({ feature: entry.feature, missing: entry.missing }));
   const { hasNativeJudge } = await import("@oh-my-pi/pi-coding-agent/judgment");
   out.native = hasNativeJudge(session.settings, session.modelRegistry);
   const say = text => session.agent.replaceMessages([
    { role: "user", content: "fix the parser", timestamp: Date.now() - 1000 },
    { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() },
   ]);
   say(${JSON.stringify(ASKING)});
   out.asking = await methods["judge_assist.needs_user"]({}, env);
   say(${JSON.stringify(REPORT)});
   out.report = await methods["judge_assist.needs_user"]({}, env);
   out.available = await methods["judge_assist.available"]({}, env);
   out.stateOn = judgeAssistState();
   out.usage = session.sessionManager.getEntries().filter(entry => entry.type === "model_usage")
    .map(entry => ({ purpose: entry.purpose, role: entry.role, api: entry.api, provider: entry.provider, model: entry.model }));
   out.bad = await methods["judge_assist_set"]({ enabled: "yes" }, env).then(() => "accepted", error => String(error.message));
   await methods["judge_assist_set"]({ enabled: false }, env);
   say("A third reply that nobody has asked the judge about. Which file first?");
   out.off = await methods["judge_assist.needs_user"]({}, env);
   out.stateOff = judgeAssistState();
   console.error("JA_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("JA_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Usage {
	purpose: string;
	role: string;
	api: string;
	provider: string;
	model: string;
}

interface Probe {
	unavailable: Array<{ feature: string; missing: string[] }>;
	native: boolean;
	available: { available: boolean };
	asking: { needsUser: boolean | null };
	report: { needsUser: boolean | null };
	stateOn: { enabled: boolean; requests: number };
	usage: Usage[];
	bad: string;
	off: { needsUser: boolean | null };
	stateOff: { enabled: boolean; requests: number };
}

interface Loopback {
	url: string;
	requests: Array<{ method: string; path: string; body: unknown }>;
	close(): Promise<void>;
}

/** The `state.reply` of a System One request body, or "". */
function replyOf(body: unknown): string {
	if (typeof body !== "object" || body === null || !("state" in body)) return "";
	const state = body.state;
	if (typeof state !== "object" || state === null || !("reply" in state)) return "";
	return typeof state.reply === "string" ? state.reply : "";
}

/** A System One server: `needs` is "noul" 0.93 for a reply that asks a question, 0.04 otherwise. */
async function startLoopback(): Promise<Loopback> {
	const loopback: Loopback = { url: "", requests: [], close: async () => undefined };
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", chunk => {
			raw += chunk;
		});
		req.on("end", () => {
			let body: unknown = raw;
			try {
				body = JSON.parse(raw);
			} catch {
				// not JSON: recorded as text
			}
			loopback.requests.push({ method: req.method ?? "", path: req.url ?? "", body });
			if (req.method !== "POST" || req.url !== "/v1/systemone") {
				res.writeHead(404).end();
				return;
			}
			const reply = replyOf(body);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					model: "jev-latest",
					answers: { needs: { type: "noul", noul: reply.includes("Which one") ? 0.93 : 0.04 } },
					usage: { input_tokens: 120, output_tokens: 3 },
				}),
			);
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	loopback.url = `http://127.0.0.1:${port}`;
	loopback.close = () => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	};
	return loopback;
}

/** One isolated omp life: `judge` is the model the `judge` role is set to, on a provider that is on `loopback`. */
async function run(loopback: Loopback, judge: "native" | "prompted", images = false): Promise<Probe> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-ja-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "ja-probe.ts"), PROBE);
		const cost = "{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }";
		// The session's own model is always the chat one (a judgment-only API cannot be the default model).
		const providers = [
			"  fake:",
			`    baseUrl: ${loopback.url}/v1`,
			"    apiKey: x",
			"    api: openai-completions",
			"    models:",
			"      - id: m1",
			"        name: m1",
			`        cost: ${cost}`,
			...(judge === "native"
				? [
						"  jev:",
						`    baseUrl: ${loopback.url}`,
						"    apiKey: x",
						"    api: typesafe",
						"    models:",
						"      - id: jev-latest",
						"        name: jev-latest",
						`        input: [${images ? "text, image" : "text"}]`,
						`        cost: ${cost}`,
					]
				: []),
		];
		writeFileSync(join(isolated, "models.yml"), ["providers:", ...providers, ""].join("\n"));
		writeFileSync(
			join(isolated, "config.yml"),
			`modelRoles:\n  judge: ${judge === "native" ? "jev/jev-latest" : "fake/m1"}\n  default: fake/m1\n`,
		);
		const project = join(isolated, "project");
		mkdirSync(project, { recursive: true });
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
		};
		for (const key of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"OPENAI_API_KEY",
			"OPENROUTER_API_KEY",
			"TYPESAFE_API_KEY",
			"TYPESAFE_BASE_URL",
			"ELECTRON_RUN_AS_NODE",
		])
			Reflect.deleteProperty(env, key);
		const child = spawn(
			omp,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				join(bridge, "ja-probe.ts"),
			],
			{ cwd: project, env: env as NodeJS.ProcessEnv },
		);
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += chunk;
		});
		const exited = new Promise<void>(done => child.once("exit", () => done()));
		// A guard, not a wait: an omp that never reaches its probe fails the test with its stderr.
		const guard = setTimeout(() => child.kill("SIGKILL"), 110_000);
		child.stdin.end();
		await exited;
		clearTimeout(guard);
		const line = stderr.split("\n").find(value => value.startsWith("JA_PROBE="));
		if (line === undefined) throw new Error(`the probe did not report\n${stderr.slice(-2500)}`);
		return JSON.parse(line.slice("JA_PROBE=".length)) as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("judge-model assists on stock omp", () => {
	it("without a native judge answers 'did not decide' and sends no request", async () => {
		const loopback = await startLoopback();
		try {
			const probe = await run(loopback, "prompted");
			expect(probe.unavailable).toEqual([]);
			expect(probe.native).toBe(false);
			expect(probe.available).toEqual({ available: false });
			expect(probe.asking).toEqual({ needsUser: null });
			expect(probe.report).toEqual({ needsUser: null });
			expect(probe.stateOn).toEqual({ enabled: true, requests: 0 });
			expect(probe.usage).toEqual([]);
			expect(loopback.requests).toEqual([]);
		} finally {
			await loopback.close();
		}
	}, 130_000);

	it("with a native judge asks stock's resolveJudge, journals the usage with the purpose, and stops when switched off", async () => {
		const loopback = await startLoopback();
		try {
			const probe = await run(loopback, "native");
			expect(probe.unavailable).toEqual([]);
			expect(probe.native).toBe(true);
			// A picture is judged only by a native model that takes images: this catalog entry takes text only.
			expect(probe.available).toEqual({ available: false });
			expect(probe.asking).toEqual({ needsUser: true });
			expect(probe.report).toEqual({ needsUser: false });
			expect(probe.stateOn).toEqual({ enabled: true, requests: 2 });
			expect(loopback.requests.map(request => [request.method, request.path])).toEqual([
				["POST", "/v1/systemone"],
				["POST", "/v1/systemone"],
			]);
			const first = loopback.requests[0]?.body as {
				model: string;
				state: { reply: string };
				questions: { needs: { type: string } };
			};
			expect(first.model).toBe("jev-latest");
			expect(first.state.reply).toBe(ASKING);
			expect(first.questions.needs.type).toBe("noul");
			// Every billed attempt is on the session ledger under the purpose that asked.
			expect(probe.usage).toEqual([
				{ purpose: "ompdesk-needs-user", role: "typesafe", api: "typesafe", provider: "jev", model: "jev-latest" },
				{ purpose: "ompdesk-needs-user", role: "typesafe", api: "typesafe", provider: "jev", model: "jev-latest" },
			]);
			// A bad switch value is refused; the real one turns the judge off without a request.
			expect(probe.bad).toContain("judge_assist_set needs {enabled: boolean}");
			expect(probe.off).toEqual({ needsUser: null });
			expect(probe.stateOff).toEqual({ enabled: false, requests: 2 });
			expect(loopback.requests).toHaveLength(2);
		} finally {
			await loopback.close();
		}
	}, 130_000);

	it("judges pictures only through a native model that takes images (stock's image bounds)", async () => {
		const loopback = await startLoopback();
		try {
			const probe = await run(loopback, "native", true);
			expect(probe.unavailable).toEqual([]);
			expect(probe.native).toBe(true);
			expect(probe.available).toEqual({ available: true });
		} finally {
			await loopback.close();
		}
	}, 130_000);
});
