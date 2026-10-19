import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isApprovalOnly } from "../../resources/gui-bridge/modes/next-prompt-core";

/**
 * Opt-in audit on the user's real omp and credentials (`OMP_GUI_REAL_WORK=1`; about `RUNS` × 2 requests on the
 * `smol` role). Replays the reported moment: the assistant had just steered a session it opened onto the user's
 * correction and said so, and the suggestion offered "좋아 그 방향으로 가". Each run asks the small model twice, once
 * with the rules before this fix (`git show HEAD~:…next-prompt-core.ts`, set by `NEXT_PROMPT_BEFORE_REF`) and once with
 * the current ones, and counts the shown suggestions that only approve. Prints `NEXT_PROMPT_REAL` lines.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
const agentDir = join(homedir(), ".omp", "agent");
const journal = join(
	agentDir,
	"sessions",
	"-Desktop-GitHub-omgdesk",
	"2026-10-07T11-14-25-843Z_01a11612-61b3-771b-8fc2-c8065fd64e38.jsonl",
);
/** The reply after which the reported suggestion was made. */
const MOMENT = "2026-10-19T06:26:49.029Z";
const RUNS = Number(process.env.NEXT_PROMPT_REAL_RUNS ?? 4);
const beforeRef = process.env.NEXT_PROMPT_BEFORE_REF;
const enabled =
	process.env.OMP_GUI_REAL_WORK === "1" &&
	beforeRef !== undefined &&
	existsSync(omp) &&
	existsSync(journal) &&
	existsSync(join(agentDir, "agent.db"));

/** The sessions the assistant had opened and was running at that moment. */
const OPENED = [
	{ title: "원격 기기 이름을 언제든 바꿀 수 있게" },
	{ title: "에이전트에게 OMPdesk 모든 권한 (확인 카드 없이)" },
	{ title: "메모리 통합 빌드" },
];

const PROBE = `
import { readFileSync } from "node:fs";
import * as after from "./modes/next-prompt-core";
import * as before from "./modes/next-prompt-core-before";
import { completeOnSmol } from "./modes/next-prompt-engine";
import "./modes/next-prompt";
export default function (pi) {
 pi.on("session_start", async () => {
  const out = [];
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const messages = JSON.parse(readFileSync(process.env.NP_MESSAGES, "utf8"));
   const opened = JSON.parse(process.env.NP_OPENED);
   const sent = after.sentTexts(messages);
   const register = after.userRegister(sent);
   const transcript = after.renderTranscript(messages, after.SUGGEST_TRANSCRIPT_CHARS);
   const variants = {
    before: { core: before, state: before.buildAppState(before.extractFacts(messages)), clean: {} },
    after: {
     core: after,
     state: after.buildAppState(after.extractFacts(messages, { openedSessions: opened })),
     clean: { decisionPending: after.awaitsDecision(messages) },
    },
   };
   // Concurrent: omp in RPC mode ends about 30 s after its stdin closes.
   const jobs = [];
   for (let run = 0; run < Number(process.env.NP_RUNS); run++)
    for (const [name, v] of Object.entries(variants))
     jobs.push(completeOnSmol(session, {
      system: v.core.SUGGEST_INSTRUCTIONS,
      user: v.core.buildSuggestionRequest(transcript, v.state, register),
      maxTokens: 512, temperature: 0.3, purpose: "next-prompt-audit",
     }).then(reply => {
      const shown = v.core.cleanCandidates(reply.text, { register, sent: new v.core.SentMessages(sent), ...v.clean });
      out.push({ run, variant: name, raw: reply.text, shown, model: reply.model, state: v.state });
     }));
   await Promise.all(jobs);
   console.error("NP_REAL=" + JSON.stringify(out));
  } catch (err) {
   console.error("NP_REAL_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Row {
	run: number;
	variant: "before" | "after";
	raw: string;
	shown: string[];
	model: string;
	state: string;
}

function momentMessages(): unknown[] {
	const lines = spawnSync("cat", [journal], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).stdout.split("\n");
	const messages: unknown[] = [];
	for (const line of lines) {
		if (!line.includes('"type":"message"')) continue;
		const entry = JSON.parse(line) as { timestamp: string; message: unknown };
		if (entry.timestamp > MOMENT) break;
		messages.push(entry.message);
	}
	return messages.slice(-80);
}

describe.skipIf(!enabled)("prompt suggestions replay the reported moment on the real small model", () => {
	it("shows fewer pure approvals for work already underway", () => {
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-np-real-"));
		chmodSync(isolated, 0o700);
		try {
			cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
			const old = spawnSync("git", ["show", `${beforeRef}:resources/gui-bridge/modes/next-prompt-core.ts`], {
				encoding: "utf8",
			});
			writeFileSync(join(isolated, "bridge", "modes", "next-prompt-core-before.ts"), old.stdout);
			writeFileSync(join(isolated, "bridge", "np-real.ts"), PROBE);
			writeFileSync(join(isolated, "messages.json"), JSON.stringify(momentMessages()));
			copyFileSync(join(agentDir, "config.yml"), join(isolated, "config.yml"));
			copyFileSync(join(agentDir, "agent.db"), join(isolated, "agent.db"));
			const project = join(isolated, "project");
			mkdirSync(project);
			const result = spawnSync(
				omp,
				["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e"].concat(
					join(isolated, "bridge", "np-real.ts"),
				),
				{
					cwd: project,
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: isolated,
						PI_CONFIG_DIR: isolated,
						NP_MESSAGES: join(isolated, "messages.json"),
						NP_OPENED: JSON.stringify(OPENED),
						NP_RUNS: String(RUNS),
					},
					encoding: "utf8",
					timeout: 600_000,
					maxBuffer: 8 * 1024 * 1024,
					input: "",
				},
			);
			const line = result.stderr.split("\n").find(value => value.startsWith("NP_REAL="));
			expect(
				line ?? "",
				`${String(result.error)} ${result.status}\n${result.stderr.slice(-2500)}${result.stdout.slice(-1500)}`,
			).toMatch(/^NP_REAL=/);
			const rows = JSON.parse(line?.slice("NP_REAL=".length) ?? "[]") as Row[];
			const tally = { before: { shown: 0, approvals: 0 }, after: { shown: 0, approvals: 0 } };
			for (const row of rows) {
				const approvals = row.shown.filter(isApprovalOnly).length;
				tally[row.variant].shown += row.shown.length;
				tally[row.variant].approvals += approvals;
				const rawApprovals = row.raw.split("\n").filter(text => isApprovalOnly(text.trim())).length;
				console.log(
					`NEXT_PROMPT_REAL run ${row.run} ${row.variant.padEnd(6)} approvals shown ${approvals}, in raw ${rawApprovals} ${row.model} :: ${JSON.stringify(row.shown)}`,
				);
			}
			console.log(`NEXT_PROMPT_REAL app-state after:\n${rows.find(row => row.variant === "after")?.state}`);
			console.log(`NEXT_PROMPT_REAL total ${JSON.stringify(tally)}`);
			expect(rows).toHaveLength(RUNS * 2);
			expect(tally.after.approvals).toBe(0);
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	}, 620_000);
});
