import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handlers } from "./autopilot";
import { gitSync, initRepo } from "./git/test-repos";
import type { LocalCommandContext } from "./types";

let tmp = "";
let main = "";
let work = "";

function context(requests: Array<{ method: string; params: unknown }> = []): LocalCommandContext {
	return {
		cwd: main,
		omp: { bin: "omp", version: "0.0.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		send: async () => {
			throw new Error("not stock");
		},
		bridge: {
			connected: true,
			onEvent: () => () => undefined,
			request: async <T>(method: string, params?: unknown) => {
				requests.push({ method, params });
				return { active: false } as T;
			},
		},
	};
}

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "autopilot-local-")));
	main = path.join(tmp, "main");
	work = path.join(tmp, "work");
	await initRepo(main);
	gitSync(main, "worktree", "add", "-q", "-b", "autopilot/2026-10-17", work);
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("autopilot_branch_status", () => {
	const run = (input: Record<string, unknown>) =>
		handlers.autopilot_branch_status?.({ type: "autopilot_branch_status", ...input }, context());

	it("counts the commits the branch is ahead of and behind its base", async () => {
		for (const name of ["a.txt", "b.txt"]) {
			await fs.writeFile(path.join(work, name), name);
			gitSync(work, "add", name);
			gitSync(work, "commit", "-q", "-m", name);
		}
		await fs.writeFile(path.join(main, "m.txt"), "m");
		gitSync(main, "add", "m.txt");
		gitSync(main, "commit", "-q", "-m", "m");
		expect(await run({ root: work, base: "main", branch: "autopilot/2026-10-17" })).toEqual({ ahead: 2, behind: 1 });
	});

	it("reads without writing anything", async () => {
		const before = gitSync(main, "for-each-ref");
		await run({ root: work, base: "main", branch: "autopilot/2026-10-17" });
		expect(gitSync(main, "for-each-ref")).toBe(before);
	});

	it("refuses option-looking refs and a missing root", async () => {
		await expect(run({ root: work, base: "--output=/tmp/x", branch: "main" })).rejects.toThrow();
		await expect(run({ root: path.join(tmp, "nope"), base: "main", branch: "main" })).rejects.toThrow();
		await expect(run({ root: work, base: "main", branch: "no-such-branch" })).rejects.toThrow();
	});
});

describe("autopilot_bridge", () => {
	it("forwards only the autopilot bridge methods", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const call = (method: string) =>
			handlers.autopilot_bridge?.({ type: "autopilot_bridge", method, params: { a: 1 } }, context(requests));
		await call("modes.autopilot_status");
		expect(requests).toEqual([{ method: "modes.autopilot_status", params: { a: 1 } }]);
		await expect(call("modes.set_plan_mode")).rejects.toThrow(/not an autopilot method/);
		await expect(call("goal.anything")).rejects.toThrow();
		expect(requests).toHaveLength(1);
	});
});

describe("get_autopilot / set_autopilot", () => {
	it("get_autopilot is the bridge status; set_autopilot is the window's job", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		expect(await handlers.get_autopilot?.({ type: "get_autopilot" }, context(requests))).toEqual({ active: false });
		expect(requests[0]?.method).toBe("modes.autopilot_status");
		await expect(handlers.set_autopilot?.({ type: "set_autopilot", action: "stop" }, context())).rejects.toThrow(
			/OMPdesk window/,
		);
	});
});
