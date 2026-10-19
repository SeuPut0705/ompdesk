import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Background jobs as a tree, on the installed omp in an empty private agent dir (no model is called): a job a
 * subagent owns is listed by `getAsyncJobTree` under that subagent, `inspectAsyncJob` answers for it,
 * `cancelAsyncJob` refuses it (stock cancels only the jobs the session's own agent owns, and its jobs sheet offers
 * Cancel on those alone), and the bridge's `composer.jobs` turns stock's `buildJobTree` into rows that say the same:
 * nested one level under the task job that runs the subagent, `cancellable` false. The composer feature stays
 * available, so `pi-tui/overlays/job-tree` is this omp's own module and not a separate copy.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const HELPER = `
import { probe } from "./health";
export async function capabilitiesFor(env) {
 return (await probe(env, ["composer", "autoMode"])).map(entry => ({ feature: entry.feature, missing: entry.missing }));
}
`;

const PROBE = `
import { methods as composer } from "./composer";
import { capabilitiesFor } from "./probe-helper";
export default function (pi) {
 pi.on("session_start", async () => {
  const out = {};
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const manager = session.asyncJobManager;
   const rootId = session.getAgentId();
   out.rootId = rootId ?? null;
   const hold = ({ signal, reportProgress }) => {
    const { promise, resolve } = Promise.withResolvers();
    void reportProgress("working");
    signal.addEventListener("abort", () => resolve("stopped"));
    return promise;
   };
   const shell = manager.register("bash", "root shell", hold, { ownerId: rootId });
   const task = manager.register("task", "SubA", hold, { ownerId: rootId, agentId: "SubA" });
   const nested = manager.register("bash", "sub shell", hold, { ownerId: "SubA" });
   const tree = session.getAsyncJobTree();
   out.tree = {
    running: tree.running.map(job => ({ id: job.id, ownerId: job.ownerId ?? null, agentId: job.agentId ?? null })),
    agents: tree.agents,
    rootId: tree.rootId ?? null,
   };
   out.ids = { shell, task, nested };
   out.inspect = session.inspectAsyncJob(nested)?.output ?? null;
   out.rows = (await composer["composer.jobs"]({}, env)).map(row =>
    row.kind === "job"
     ? { kind: row.kind, id: row.job.id, depth: row.depth, cancellable: row.cancellable, preview: row.job.resultPreview ?? null }
     : { kind: row.kind, agentId: row.agentId, depth: row.depth });
   out.cancelNested = await composer["composer.cancel_job"]({ id: nested }, env);
   out.nestedAfter = manager.getJob(nested)?.status;
   out.cancelTask = await composer["composer.cancel_job"]({ id: task }, env);
   out.taskAfter = manager.getJob(task)?.status;
   out.cancelShell = await composer["composer.cancel_job"]({ id: shell }, env);
   out.unavailable = await capabilitiesFor(env);
  } catch (err) {
   out.error = String(err && err.stack || err);
  }
  console.error("JOBS_TREE_PROBE=" + JSON.stringify(out));
  process.exit(0);
 });
}
`;

interface Probe {
	rootId: string | null;
	tree: {
		running: Array<{ id: string; ownerId: string | null; agentId: string | null }>;
		agents: Array<{ id: string; parentId?: string }>;
		rootId: string | null;
	};
	ids: { shell: string; task: string; nested: string };
	inspect: string | null;
	rows: Array<{
		kind: string;
		id?: string;
		agentId?: string;
		depth: number;
		cancellable?: boolean;
		preview?: string | null;
	}>;
	cancelNested: { cancelled: boolean };
	nestedAfter: string;
	cancelTask: { cancelled: boolean };
	taskAfter: string;
	cancelShell: { cancelled: boolean };
	unavailable: Array<{ feature: string; missing: string[] }>;
	error?: string;
}

function run(): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-jobs-tree-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "jobs-probe.ts"), PROBE);
		writeFileSync(join(bridge, "probe-helper.ts"), HELPER);
		const project = join(isolated, "project");
		mkdirSync(project, { recursive: true });
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
		};
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
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
				join(bridge, "jobs-probe.ts"),
			],
			{ cwd: project, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("JOBS_TREE_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^JOBS_TREE_PROBE=/);
		return JSON.parse(line?.slice("JOBS_TREE_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("background jobs tree on stock omp", () => {
	it("lists a subagent's job under its agent, inspects it, and refuses to cancel it", () => {
		const probe = run();
		expect(probe.error).toBeUndefined();
		const { shell, task, nested } = probe.ids;

		// Stock's own tree: the subagent is an agent below the root, the three jobs are all in it.
		expect(probe.tree.running.map(job => job.id).sort()).toEqual([nested, shell, task].sort());
		expect(probe.tree.agents).toEqual([{ id: "SubA", parentId: probe.rootId }]);
		expect(probe.tree.running.find(job => job.id === nested)).toMatchObject({ ownerId: "SubA" });
		expect(probe.inspect).toBe("working");

		// The bridge's rows: the task job heads the subagent, its shell sits one level under it.
		const byId = new Map(probe.rows.map(row => [row.id, row]));
		expect(byId.get(task)).toMatchObject({ kind: "job", depth: 0, cancellable: true });
		expect(byId.get(shell)).toMatchObject({ kind: "job", depth: 0, cancellable: true });
		expect(byId.get(nested)).toMatchObject({ kind: "job", depth: 1, cancellable: false, preview: "working" });
		const order = probe.rows.map(row => row.id);
		expect(order.indexOf(nested)).toBe(order.indexOf(task) + 1);

		// Only the session's own jobs cancel; the refusal leaves the nested job running.
		expect(probe.cancelNested).toEqual({ cancelled: false });
		expect(probe.nestedAfter).toBe("running");
		expect(probe.cancelTask).toEqual({ cancelled: true });
		expect(probe.taskAfter).toBe("cancelled");
		expect(probe.cancelShell).toEqual({ cancelled: true });
	}, 130_000);

	it("keeps the composer and auto mode features available: every internal they read, job-tree included, is this omp's", () => {
		expect(run().unavailable).toEqual([]);
	}, 130_000);
});
