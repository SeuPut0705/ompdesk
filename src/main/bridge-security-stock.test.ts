import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The security dashboard on the installed omp shows a scan an earlier process left running as stock's coordinator
 * recovers it: failed, scan and operation alike, on the very first read (the recovery rewrites the bundle, so the
 * bridge must read the scans after it). The interrupted bundle is built with stock's SARIF importer and store.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods as security } from "./security";
import { importSarif } from "@oh-my-pi/pi-coding-agent/security/importers/sarif";
import { SecurityStore } from "@oh-my-pi/pi-coding-agent/security/store";
export default function (pi) {
 pi.on("session_start", async () => {
  const out = {};
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const store = await SecurityStore.openForCwd(session.sessionManager.getCwd());
   const bundle = await importSarif({ version: "2.1.0", runs: [{ tool: { driver: { name: "probe" } }, results: [] }] }, { repositoryRoot: store.repositoryRoot });
   bundle.scan.status = "running";
   bundle.scan.provenance.metadata = { ...(bundle.scan.provenance.metadata ?? {}), operationId: "op-interrupted" };
   await store.putBundle(bundle);
   const dashboard = await security.security_dashboard({}, env);
   out.scans = dashboard.scans.map(scan => scan.status);
   out.latest = dashboard.latest?.scan.status;
   out.operations = dashboard.operations.map(operation => operation.operationId + ":" + operation.phase);
  } catch (err) {
   out.error = String(err && err.stack || err);
  }
  console.error("SECURITY_PROBE=" + JSON.stringify(out));
  process.exit(0);
 });
}
`;

interface Probe {
	scans?: string[];
	latest?: string;
	operations?: string[];
	error?: string;
}

function run(): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-security-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "security-probe.ts"), PROBE);
		writeFileSync(join(isolated, "config.yml"), "security:\n  enabled: true\n");
		const project = join(isolated, "project");
		mkdirSync(project, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
		git("init", "-q");
		writeFileSync(join(project, "a.txt"), "hi\n");
		git("add", ".");
		git("-c", "user.email=probe@example.com", "-c", "user.name=probe", "commit", "-qm", "init");
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
		};
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENROUTER_API_KEY"])
			Reflect.deleteProperty(env, key);
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
				join(bridge, "security-probe.ts"),
			],
			{ cwd: project, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("SECURITY_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^SECURITY_PROBE=/);
		return JSON.parse(line?.slice("SECURITY_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("security dashboard on stock omp", () => {
	it("shows a scan an earlier process left running as failed, scan and operation alike, on the first read", () => {
		const probe = run();
		expect(probe.error).toBeUndefined();
		expect(probe.operations).toEqual(["op-interrupted:failed"]);
		expect(probe.scans).toEqual(["failed"]);
		expect(probe.latest).toBe("failed");
	}, 130_000);
});
