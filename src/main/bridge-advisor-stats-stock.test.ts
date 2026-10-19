import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdvisorUsage } from "../../resources/gui-bridge/advisor-stats-contracts";

/**
 * The advisor spend card on the installed omp (bridge `advisor_stats`, resources/gui-bridge/advisor-stats.ts), in an
 * empty private agent dir (no model call, no advisor configured). Two advisor notes are appended to the session
 * journal through stock's own `appendCustomMessageEntry`, then the method's answer is compared with what stock's
 * `getAdvisorStats()` says in the same process. The probe also times the method (guard included) over 200 calls.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods } from "./advisor-stats";

const CALLS = 200;

export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const sm = session.sessionManager;
   sm.appendCustomMessageEntry("advisor", "advisor note", true, { notes: [{ note: "first", severity: "concern" }, { note: "second", severity: "concern" }] });
   sm.appendCustomMessageEntry("advisor", "advisor note", true, { notes: [{ note: "third", severity: "nit" }] });
   await sm.flush();
   const usage = await methods.advisor_stats({}, env);
   const stock = session.getAdvisorStats();
   const started = performance.now();
   for (let i = 0; i < CALLS; i++) await methods.advisor_stats({}, env);
   const mean = (performance.now() - started) / CALLS;
   console.error("ADVISOR_STATS_MS=" + mean);
   console.error("ADVISOR_PROBE=" + JSON.stringify({
    usage,
    stock: {
     configured: stock.configured,
     active: stock.active,
     cost: stock.cost,
     tokens: stock.tokens,
     advisors: stock.advisors.map(a => ({ name: a.name, status: a.status, calls: a.messages.assistant, cost: a.cost })),
    },
    subscription: session.isAdvisorUsingSubscription(),
   }));
  } catch (err) {
   console.error("ADVISOR_PROBE_ERROR=" + String((err && err.stack) || err));
  }
  process.exit(0);
 });
}
`;

interface StockSide {
	configured: boolean;
	active: boolean;
	cost: number;
	tokens: { input: number; output: number; cacheRead: number; total: number };
	advisors: { name: string; status: string; calls: number; cost: number }[];
}

function isolatedRun(probe: string, file: string): { stderr: string; cleanup: () => void } {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-advisor-"));
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
		input: "",
	});
	return { stderr: result.stderr, cleanup: () => rmSync(isolated, { recursive: true, force: true }) };
}

describe.skipIf(!existsSync(omp))("advisor stats on stock omp", () => {
	it("maps stock's advisor stats and the notes journaled into the session, in under 5 ms a call", () => {
		const { stderr, cleanup } = isolatedRun(PROBE, "advisor-probe.ts");
		try {
			const line = stderr.split("\n").find(value => value.startsWith("ADVISOR_PROBE="));
			expect(line, stderr.slice(-2500)).toMatch(/^ADVISOR_PROBE=/);
			const out = JSON.parse(line?.slice("ADVISOR_PROBE=".length) ?? "{}") as {
				usage: AdvisorUsage;
				stock: StockSide;
				subscription: boolean;
			};
			const { usage, stock } = out;
			expect(usage.configured).toBe(stock.configured);
			expect(usage.active).toBe(stock.active);
			expect(usage.cost).toBe(stock.cost);
			expect(usage.subscription).toBe(out.subscription);
			expect(usage.tokens).toEqual({
				input: stock.tokens.input,
				output: stock.tokens.output,
				cacheRead: stock.tokens.cacheRead,
				total: stock.tokens.total,
			});
			expect(usage.advisors.map(({ name, status, calls, cost }) => ({ name, status, calls, cost }))).toEqual(
				stock.advisors,
			);
			expect(usage.calls).toBe(stock.advisors.reduce((sum, advisor) => sum + advisor.calls, 0));
			expect(usage.advisories).toEqual({ total: 3, concern: 2, nit: 1, blocker: 0, other: 0 });

			const ms = Number(
				stderr
					.split("\n")
					.find(value => value.startsWith("ADVISOR_STATS_MS="))
					?.split("=")[1],
			);
			expect(ms, stderr.slice(-2500)).toBeLessThan(5);
			process.stderr.write(`ADVISOR_STATS_MS=${ms}\n`);
		} finally {
			cleanup();
		}
	}, 130_000);
});
