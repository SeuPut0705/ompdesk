import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The automatic mode choice asked while the user types, on the installed omp with a native judge on loopback (no
 * model spend; gui-bridge modes/auto-mode.ts `modes.auto_mode_prefetch`):
 * - the warm-up (a native judge only) reaches the judge once per omp, outside the answer cache and the session's ledger;
 * - a question asked while typing answers the decision at Enter for the same text from stock's judgment cache: no
 *   second request, the same decision;
 * - a decision that arrives while that question is still asked joins it instead of asking again;
 * - any other text is asked as before, and every billed question is journaled once (purpose `auto-mode`).
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const BIG = "migrate the whole app from REST to GraphQL across all services";
const SLOW = "migrate every package slowly from webpack to vite across the repo";
const OTHER = "rewrite the entire billing system across all services and add tests";

const PROBE = `
import { methods, warmJudge } from "./modes/auto-mode";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const prefetch = params => methods["modes.auto_mode_prefetch"](params, env);
   const decide = message => methods["modes.auto_mode_decide"]({ message }, env);
   const out = {};
   out.warm = await warmJudge(env);
   out.warmAgain = await warmJudge(env);
   out.prefetch = await prefetch({ message: ${JSON.stringify(BIG)} });
   out.cached = await decide(${JSON.stringify(BIG)});
   const asked = prefetch({ message: ${JSON.stringify(SLOW)} });
   const joined = decide(${JSON.stringify(SLOW)});
   // The loopback holds the typed-ahead question until now: the decision arrives while it is still asked.
   await fetch(process.env.AMP_LOOPBACK + "/release");
   out.joined = await joined;
   out.joinedPrefetch = await asked;
   out.other = await decide(${JSON.stringify(OTHER)});
   out.usage = session.sessionManager.getEntries().filter(entry => entry.type === "model_usage").map(entry => entry.purpose);
   console.error("AMP_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("AMP_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Decision {
	mode: string;
	reason?: string;
	latencyMs: number;
}

interface Probe {
	warm: boolean;
	warmAgain: boolean;
	prefetch: { prefetched: boolean };
	cached: Decision;
	joined: Decision;
	joinedPrefetch: { prefetched: boolean };
	other: Decision;
	usage: string[];
}

/** A System One server answering the mode question: plan for every request, a slow one for SLOW. */
async function startLoopback(): Promise<{ url: string; asked: string[]; close(): Promise<void> }> {
	const asked: string[] = [];
	// The SLOW question's answer waits for `GET /release` (which may come first: then it answers at once).
	const release = Promise.withResolvers<void>();
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", chunk => {
			raw += chunk;
		});
		req.on("end", () => {
			if (req.url === "/release") {
				release.resolve();
				res.writeHead(204).end();
				return;
			}
			if (req.method !== "POST" || req.url !== "/v1/systemone") {
				res.writeHead(404).end();
				return;
			}
			const body: unknown = JSON.parse(raw);
			const state = typeof body === "object" && body !== null && "state" in body ? body.state : undefined;
			const request =
				typeof state === "object" && state !== null && "request" in state && typeof state.request === "string"
					? state.request
					: "";
			asked.push(request);
			const answer = () => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						model: "jev-latest",
						answers: {
							mode: { type: "choice", choice: "plan", probabilities: { plan: 0.92, goal: 0.03, none: 0.05 } },
						},
						usage: { input_tokens: 300, output_tokens: 4 },
					}),
				);
			};
			if (request.includes("slowly")) void release.promise.then(answer);
			else answer();
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		asked,
		close: () => {
			server.closeAllConnections();
			return new Promise<void>(done => server.close(() => done()));
		},
	};
}

async function run(url: string): Promise<Probe> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-amp-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "amp-probe.ts"), PROBE);
		const cost = "{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }";
		writeFileSync(
			join(isolated, "models.yml"),
			[
				"providers:",
				"  fake:",
				`    baseUrl: ${url}/v1`,
				"    apiKey: x",
				"    api: openai-completions",
				"    models:",
				"      - id: m1",
				"        name: m1",
				`        cost: ${cost}`,
				"  jev:",
				`    baseUrl: ${url}`,
				"    apiKey: x",
				"    api: typesafe",
				"    models:",
				"      - id: jev-latest",
				"        name: jev-latest",
				`        cost: ${cost}`,
				"",
			].join("\n"),
		);
		writeFileSync(
			join(isolated, "config.yml"),
			"modelRoles:\n  judge: jev/jev-latest\n  default: fake/m1\nplan:\n  enabled: true\ngoal:\n  enabled: true\n",
		);
		const project = join(isolated, "project");
		mkdirSync(project, { recursive: true });
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			AMP_LOOPBACK: url,
		};
		for (const key of ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "ELECTRON_RUN_AS_NODE"])
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
				join(bridge, "amp-probe.ts"),
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
		const line = stderr.split("\n").find(value => value.startsWith("AMP_PROBE="));
		if (line === undefined) throw new Error(`the probe did not report\n${stderr.slice(-2500)}`);
		return JSON.parse(line.slice("AMP_PROBE=".length)) as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("automatic mode asked while typing, on stock omp", () => {
	it("warms the judge once, answers the decision at Enter from the cache, and joins a question still asked", async () => {
		const loopback = await startLoopback();
		try {
			const probe = await run(loopback.url);
			expect(probe.warm).toBe(true);
			expect(probe.warmAgain).toBe(true);
			expect(probe.prefetch).toEqual({ prefetched: true });
			expect(probe.cached).toMatchObject({ mode: "plan", tokens: { input: 0, output: 0 } });
			expect(probe.joinedPrefetch).toEqual({ prefetched: true });
			expect(probe.joined).toMatchObject({ mode: "plan" });
			expect(probe.other).toMatchObject({ mode: "plan" });
			// One request per distinct question: the warm-up, the two typed ahead, the one only asked at Enter.
			expect(loopback.asked).toEqual(["warm up", BIG, SLOW, OTHER]);
			// Billed once each, through the session's ledger; the warm-up and cache hits are not billed.
			expect(probe.usage).toEqual(["auto-mode", "auto-mode", "auto-mode"]);
		} finally {
			await loopback.close();
		}
	}, 130_000);
});
