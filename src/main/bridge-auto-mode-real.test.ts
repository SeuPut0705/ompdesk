import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Opt-in audit on the user's real omp and credentials (`OMP_GUI_REAL_WORK=1`; it spends a few tokens, about six
 * judge requests on the `smol`/`tiny` role). Copies `config.yml` and `agent.db` into a private 0700 agent dir, runs the
 * bridge's `modes.auto_mode_decide` on real prompts and prints each decision with its model and latency
 * (`AUTO_MODE_REAL=` lines on stdout). The clear cases must come out as the product intends; every decision must
 * arrive inside the deadline.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
const agentDir = join(homedir(), ".omp", "agent");
const enabled = process.env.OMP_GUI_REAL_WORK === "1" && existsSync(omp) && existsSync(join(agentDir, "agent.db"));

const PROMPTS: Array<{ text: string; expect?: "plan" | "goal" | "none" }> = [
	{
		text: "Refactor the whole settings module into separate stores across all packages and update every caller.",
		expect: "plan",
	},
	{ text: "Keep going until all the tests pass, then stop.", expect: "goal" },
	{ text: "What does the session manager do when a tab closes?", expect: "none" },
	{ text: "Rename the variable foo to count in utils.ts", expect: "none" },
	{ text: "Add OAuth login with refresh tokens, a new settings page and database migrations for a multi-tenant app." },
	{ text: "Make the build green, retry until `bun run check` exits 0." },
];

const PROBE = `
import { methods } from "./modes/auto-mode";
export default function (pi) {
 pi.on("session_start", async () => {
  const out = [];
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const prompts = JSON.parse(process.env.AM_PROMPTS);
   const wall = [];
   for (const message of prompts) {
    const started = Date.now();
    const decision = await methods["modes.auto_mode_decide"]({ message }, env);
    out.push({ message, decision, wallMs: Date.now() - started });
   }
   console.error("AM_REAL=" + JSON.stringify(out));
  } catch (err) {
   console.error("AM_REAL_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Row {
	message: string;
	decision: {
		mode: string;
		reason?: string;
		latencyMs: number;
		model?: string;
		objective?: string;
		tokens?: { input: number; output: number };
		costUsd?: number;
	};
	wallMs: number;
}

describe.skipIf(!enabled)("automatic mode choice on the real small model", () => {
	it("decides six prompts in time", () => {
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-am-real-"));
		chmodSync(isolated, 0o700);
		try {
			cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
			writeFileSync(join(isolated, "bridge", "am-real.ts"), PROBE);
			copyFileSync(join(agentDir, "config.yml"), join(isolated, "config.yml"));
			copyFileSync(join(agentDir, "agent.db"), join(isolated, "agent.db"));
			const project = join(isolated, "project");
			mkdirSync(project);
			const result = spawnSync(
				omp,
				[
					"--mode",
					"rpc",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"-e",
					join(isolated, "bridge", "am-real.ts"),
				],
				{
					cwd: project,
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: isolated,
						PI_CONFIG_DIR: isolated,
						AM_PROMPTS: JSON.stringify(PROMPTS.map(p => p.text)),
					},
					encoding: "utf8",
					timeout: 180_000,
					maxBuffer: 4 * 1024 * 1024,
					input: "",
				},
			);
			const line = result.stderr.split("\n").find(value => value.startsWith("AM_REAL="));
			expect(line, result.stderr.slice(-2500)).toMatch(/^AM_REAL=/);
			const rows = JSON.parse(line?.slice("AM_REAL=".length) ?? "[]") as Row[];
			for (const row of rows) {
				console.log(
					`AUTO_MODE_REAL ${row.decision.mode.padEnd(4)} ${String(row.decision.reason ?? "").padEnd(15)} ${row.decision.latencyMs} ms (wall ${row.wallMs} ms) ${row.decision.model ?? "-"} ${JSON.stringify(row.decision.tokens ?? null)} $${row.decision.costUsd ?? "-"} :: ${row.message}`,
				);
			}
			expect(rows).toHaveLength(PROMPTS.length);
			// A decision that timed out is "none" by design (a cold first request often needs more than 1.5 s); the
			// rest must be what the product intends.
			for (const [index, row] of rows.entries()) {
				const wanted = PROMPTS[index]?.expect;
				if (wanted && row.decision.reason !== "timeout") expect(row.decision.mode, row.message).toBe(wanted);
				expect(row.wallMs).toBeLessThan(2500);
			}
			expect(rows.filter(row => row.decision.reason === "timeout").length).toBeLessThanOrEqual(3);
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	}, 200_000);
});
