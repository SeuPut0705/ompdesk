import { describe, expect, it } from "vitest";
import { asksForMac, decide, type LaneRun, laneOf, parseArgs, refAllowed } from "./ci-run";

const run = (id: number, workflow: string, branch: string, ...statuses: string[]): LaneRun => ({
	id,
	workflow,
	branch,
	jobs: statuses.map(status => ({ status, labels: ["macos-latest"] })),
});

describe("ci-run arguments", () => {
	it("reads the workflow, the ref and every -f field", () => {
		expect(parseArgs(["ci.yml", "--ref", "feat/x", "-f", "batch=true", "-f", "win_e2e_grep=@smoke a=b"])).toEqual({
			workflow: "ci",
			ref: "feat/x",
			inputs: { batch: "true", win_e2e_grep: "@smoke a=b" },
			wait: false,
			replace: false,
			dryRun: false,
		});
	});

	it("refuses a workflow it does not know and a field without a value", () => {
		expect(parseArgs(["release"])).toContain("workflow must be one of");
		expect(parseArgs(["ci", "-f", "batch"])).toContain("key=value");
		expect(parseArgs(["ci", "--nope"])).toContain("unknown argument");
	});

	it("knows which dispatches ask for a macOS runner", () => {
		expect(asksForMac("ci", { batch: "true" })).toBe(false);
		expect(asksForMac("ci", { mac: "true" })).toBe(true);
		expect(asksForMac("ci", { e2e: "true" })).toBe(true);
		expect(asksForMac("e2e-nightly", {})).toBe(true);
		expect(asksForMac("flake-probe", { os: "windows" })).toBe(false);
		expect(asksForMac("flake-probe", {})).toBe(true);
		expect(asksForMac("formal", {})).toBe(false);
	});
});

describe("ci-run admission", () => {
	it("lets main and the listed branches ask for macOS, by exact name", () => {
		expect(refAllowed("main", "")).toBe(true);
		expect(refAllowed("a/b", "a/b c")).toBe(true);
		expect(refAllowed("c", "a/b,c")).toBe(true);
		expect(refAllowed("a", "a/b")).toBe(false);
		expect(refAllowed("a/b", "")).toBe(false);
	});

	it("refuses macOS to a branch outside MAC_REFS, and asks nothing of a run without macOS", () => {
		const lane = laneOf([], { workflow: "ci", branch: "x" });
		const refused = decide({ workflow: "ci", inputs: { mac: "true" }, replace: false }, "x", "y", lane);
		expect(refused).toMatchObject({ go: false, code: 2 });
		expect(decide({ workflow: "ci", inputs: { batch: "true" }, replace: false }, "x", "y", lane)).toEqual({
			go: true,
		});
	});
});

describe("ci-run lane", () => {
	const mine = { workflow: "ci", branch: "mine" };

	it("counts queued and running macOS jobs as the holder and pending ones as waiting, for dispatched runs", () => {
		const lane = laneOf([run(1, "ci", "a", "in_progress", "queued"), run(2, "e2e-nightly", "b", "pending")], mine);
		expect(lane.holders.map(r => r.id)).toEqual([1]);
		expect(lane.waiting.map(r => r.id)).toEqual([2]);
		expect(lane.openJobs).toBe(2);
	});

	it("leaves out the run this dispatch replaces, and jobs that are not macOS", () => {
		const own = run(3, "ci", "mine", "in_progress");
		const linux: LaneRun = {
			id: 4,
			workflow: "ci",
			branch: "c",
			jobs: [{ status: "queued", labels: ["ubuntu-latest"] }],
		};
		expect(laneOf([own, linux], mine)).toEqual({ holders: [], waiting: [], openJobs: 0 });
	});

	it("refuses to replace a waiting request unless told to, and notes a busy lane otherwise", () => {
		const args = { workflow: "ci", inputs: { mac: "true" }, replace: false };
		const full = laneOf([run(1, "ci", "a", "in_progress"), run(2, "ci", "b", "pending")], mine);
		const refused = decide(args, "mine", "mine", full);
		expect(refused).toMatchObject({ go: false, code: 3 });
		expect(refused.go === false && refused.why).toContain("1 (ci, a)");
		expect(decide({ ...args, replace: true }, "mine", "mine", full)).toMatchObject({ go: true });
		const held = laneOf([run(1, "ci", "a", "in_progress")], mine);
		expect(decide(args, "mine", "mine", held)).toMatchObject({ go: true, note: expect.stringContaining("run 1") });
	});
});
