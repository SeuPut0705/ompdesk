import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isApprovalSelect, sessionApprovalOption, sessionApprovalSubject } from "../shared/tool-approval";

/**
 * Pins `src/shared/tool-approval.ts` to the installed omp's own tool-approval prompt: stock `requestApproval` is run
 * against a UI with only `select` (what an RPC host is), with and without the session subject stock passes for a
 * prompt the approval mode raised. Every select it sends must read as an approval, and each option the GUI can send
 * must mean what the GUI says: "Approve" this call, the session option this call and later ones, "Deny" no.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { requestApproval, sessionApprovalScope } from "@oh-my-pi/pi-coding-agent/tools/approval";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const tool = { name: "bash", formatApprovalDetails: args => [args.command] };
   const scope = sessionApprovalScope({ policy: "prompt", source: "mode", tier: "exec" }, "bash");
   const device = sessionApprovalScope({ policy: "prompt", source: "mode", tier: "exec", policyKey: "xd://lsp" }, "lsp");
   const out = [];
   for (const subject of [undefined, scope?.subject, device?.subject]) {
    let asked;
    await requestApproval({ select: async (title, options) => { asked = { title, options }; return undefined; } }, tool, { command: "ls -la" }, { sessionSubject: subject });
    const answers = {};
    for (const option of asked.options)
     answers[option] = await requestApproval({ select: async () => option }, tool, { command: "ls -la" }, { sessionSubject: subject });
    out.push({ subject: subject ?? null, method: "select", ...asked, answers });
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
	subject: string | null;
	method: string;
	title: string;
	options: string[];
	answers: Record<string, string>;
}

function probe(): Asked[] {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-approval-"));
	chmodSync(isolated, 0o700);
	try {
		writeFileSync(join(isolated, "probe.ts"), PROBE);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
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
		expect(asked.map(entry => entry.subject)).toEqual([null, "bash", "xd://lsp"]);
		for (const entry of asked) {
			expect(isApprovalSelect(entry), JSON.stringify(entry)).toBe(true);
			expect(entry.answers.Approve).toBe("once");
			expect(entry.answers.Deny).toBe("deny");
			const session = sessionApprovalOption(entry);
			if (entry.subject === null) {
				expect(session).toBeUndefined();
				continue;
			}
			expect(session).toBeDefined();
			expect(entry.answers[session ?? ""]).toBe("session");
			expect(sessionApprovalSubject(session ?? "")).toBe(entry.subject);
		}
	}, 150_000);
});
