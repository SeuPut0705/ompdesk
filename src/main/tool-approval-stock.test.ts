import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVE_DENY, approvalChoices, sessionApprovalSubject } from "../shared/tool-approval";

/**
 * Pins `src/shared/tool-approval.ts` to the installed omp's own tool-approval prompt: stock `requestApproval` is run
 * against a UI with only `select` (what an RPC host is), with and without the session subject stock passes for a
 * prompt the approval mode raised, and with the grants an `always-ask-cached` ("Ask and remember") prompt offers for
 * a command, a file, a folder and a web address. Every select it sends must read as an approval, and each option the
 * GUI can send must mean what the GUI says: once this call, the session option this call and later ones, each grant
 * the folder or target for this session or every session, "Deny" no.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { requestApproval, sessionApprovalScope } from "@oh-my-pi/pi-coding-agent/tools/approval";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const bash = { name: "bash", formatApprovalDetails: args => [args.command] };
   const read = { name: "read", formatApprovalDetails: args => [args.path], approvalCacheTargets: args => [args.path] };
   const scope = sessionApprovalScope({ policy: "prompt", source: "mode", tier: "exec" }, "bash");
   const device = sessionApprovalScope({ policy: "prompt", source: "mode", tier: "exec", policyKey: "xd://lsp" }, "lsp");
   const cases = [
    ...[undefined, scope?.subject, device?.subject].map(subject => ({ tool: bash, args: { command: "ls -la" }, subject })),
    ...[process.env.PROBE_FILE, process.env.PROBE_DIR, "https://example.com/page"].flatMap(path =>
     [undefined, "read"].map(subject => ({ tool: read, args: { path }, subject, grants: true }))),
    { tool: bash, args: { command: "ls -la" }, subject: scope?.subject, grants: true },
   ];
   const out = [];
   for (const { tool, args, subject, grants } of cases) {
    const options = { sessionSubject: subject, grants };
    let asked;
    await requestApproval({ select: async (title, choices) => { asked = { title, options: choices }; return undefined; } }, tool, args, options);
    const answers = {};
    for (const option of asked.options) answers[option] = await requestApproval({ select: async () => option }, tool, args, options);
    out.push({ case: tool.name + " " + JSON.stringify(args) + " " + (subject ?? "-") + (grants ? " grants" : ""), subject: subject ?? null, method: "select", ...asked, answers });
   }
   console.error("APPROVAL_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("APPROVAL_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Asked {
	case: string;
	subject: string | null;
	method: string;
	title: string;
	options: string[];
	answers: Record<string, unknown>;
}

function probe(): Asked[] {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-approval-"));
	chmodSync(isolated, 0o700);
	try {
		writeFileSync(join(isolated, "probe.ts"), PROBE);
		mkdirSync(join(isolated, "folder"));
		writeFileSync(join(isolated, "folder", "notes.txt"), "notes\n");
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			PROBE_FILE: join(isolated, "folder", "notes.txt"),
			PROBE_DIR: join(isolated, "folder"),
		};
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
				join(isolated, "probe.ts"),
			],
			{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("APPROVAL_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^APPROVAL_PROBE=/);
		return JSON.parse(line?.slice("APPROVAL_PROBE=".length) ?? "[]") as Asked[];
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("tool approval on stock omp", () => {
	it("reads every approval select stock sends over RPC, and each option means what the card says", () => {
		const asked = probe();
		expect(asked).toHaveLength(10);
		// The grant prompts offered something to remember: a file with its folder, a folder, a web address.
		const kinds = asked.map(entry => (approvalChoices(entry)?.grants ?? []).map(grant => grant.kind).join("+"));
		expect(kinds.filter(Boolean).length).toBeGreaterThanOrEqual(6);
		expect(kinds).toContain("folder+file+folder+file");
		expect(kinds).toContain("target+target");
		for (const entry of asked) {
			const choices = approvalChoices(entry);
			expect(choices, entry.case).toBeDefined();
			if (!choices) continue;
			// Every option is one the card offers, in stock's order, and Deny comes last.
			expect(
				[...choices.grants.map(grant => grant.option), choices.once, ...(choices.session ? [choices.session] : [])],
				entry.case,
			).toEqual(entry.options.slice(0, -1));
			expect(entry.options.at(-1)).toBe(APPROVE_DENY);
			expect(entry.answers[choices.once], entry.case).toBe("once");
			expect(entry.answers[APPROVE_DENY], entry.case).toBe("deny");
			for (const grant of choices.grants) {
				expect(entry.answers[grant.option], `${entry.case} ${grant.option}`).toEqual({
					grant: grant.kind === "folder" ? "folder" : "target",
					always: grant.always,
				});
			}
			if (entry.subject === null) {
				expect(choices.session, entry.case).toBeUndefined();
				continue;
			}
			expect(choices.session, entry.case).toBeDefined();
			expect(entry.answers[choices.session ?? ""], entry.case).toBe("session");
			expect(sessionApprovalSubject(choices.session ?? ""), entry.case).toBe(entry.subject);
		}
	}, 150_000);
});
