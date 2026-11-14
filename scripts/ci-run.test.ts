import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { asksForMac, decide, hubArgs, type LaneRun, laneOf, parseArgs, readGate, refAllowed, route } from "./ci-run";

const run = (id: number, workflow: string, branch: string, ...statuses: string[]): LaneRun => ({
	id,
	workflow,
	branch,
	jobs: statuses.map(status => ({ status, labels: status === "pending" ? [] : ["macos-latest"] })),
});

describe("ci-run arguments", () => {
	it("reads the workflow, the ref and every -f field", () => {
		expect(
			parseArgs(["ci.yml", "--ref", "feat/x", "-f", "batch=true", "-f", "win_e2e_grep=@smoke a=b", "--wait"]),
		).toEqual({
			workflow: "ci",
			ref: "feat/x",
			inputs: { batch: "true", win_e2e_grep: "@smoke a=b" },
			wait: true,
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

	it("asks the hub for the named workflow with its inputs and says when it takes macOS", () => {
		const args = parseArgs(["ci", "-f", "batch=true", "-f", "mac=true"]);
		if (typeof args === "string") throw new Error(args);
		expect(hubArgs(args, "omp/agent/x")).toEqual([
			"checks",
			"start",
			"--workflow",
			"ci.yml",
			"--input",
			"batch=true",
			"--input",
			"mac=true",
			"--macos",
			"--ref",
			"omp/agent/x",
		]);
	});
});

describe("ci-run route", () => {
	const answered = (out: string) => ({ code: 0, out, err: "" });
	const gateOn = () => "on" as const;
	const gateOff = () => "off" as const;
	const unread = () => {
		throw new Error("the gate is read only for macOS work no hub took");
	};
	const down = { code: 3, out: "", err: "ompdesk: OMPdesk is not running" };
	// What every computer's ompdesk 0.128.0 answers: it predates check control.
	const old = { code: 2, out: "", err: 'ompdesk: unknown command "checks"\nRun `ompdesk help` for the commands.' };

	it("prints the hub's answer, a refusal as exit 2", () => {
		expect(route(true, answered("Checks held: run chk-1 waits.\n"), unread)).toEqual({
			via: "hub",
			code: 0,
			text: "Checks held: run chk-1 waits.",
		});
		expect(
			route(false, answered("Checks refused: nothing was started.\nWhy: paused by the owner"), unread),
		).toMatchObject({ via: "hub", code: 2 });
	});

	it("dispatches without macOS directly whenever no hub answers", () => {
		expect(route(false, down, unread)).toEqual({ via: "direct", why: "ompdesk: OMPdesk is not running" });
		expect(route(false, undefined, unread)).toEqual({ via: "direct", why: "no ompdesk command found" });
		expect(route(false, old, unread)).toMatchObject({ via: "direct" });
	});

	it("dispatches macOS directly while no hub answers and the ticket gate is off, saying so in one line", () => {
		for (const hub of [down, old, undefined]) {
			expect(route(true, hub, gateOff)).toMatchObject({
				via: "direct",
				why: expect.stringContaining("the ticket gate is off"),
			});
		}
		expect(route(true, old, gateOff)).toEqual({
			via: "direct",
			why: 'ompdesk: unknown command "checks"; the ticket gate is off',
		});
	});

	it("refuses macOS without a hub while the ticket gate is on, or cannot be read", () => {
		for (const hub of [down, old, undefined]) {
			expect(route(true, hub, gateOn)).toMatchObject({
				via: "refused",
				code: 2,
				why: expect.stringContaining("open OMPdesk (a version with checks)"),
			});
		}
		expect(route(true, down, () => ({ unknown: "HTTP 502" }))).toMatchObject({
			via: "refused",
			why: expect.stringContaining("HTTP 502"),
		});
	});

	it("never sends macOS work around a hub that answered with an error", () => {
		const broken = { code: 1, out: "", err: "ompdesk: checks_source: gh is not signed in" };
		expect(route(true, broken, gateOff)).toMatchObject({
			via: "refused",
			code: 1,
			why: expect.stringContaining("signed in"),
		});
		expect(route(false, broken, unread)).toMatchObject({ via: "direct", why: expect.stringContaining("signed in") });
	});
});

describe("ci-run ticket gate", () => {
	it("is off while the repository's device list is unset or empty, on while it names a computer", () => {
		const reply =
			(ok: boolean, out: string, err = "") =>
			() => ({ ok, out, err });
		expect(readGate(reply(false, "", "variable CHECKS_ADMISSION_DEVICES was not found"))).toBe("off");
		expect(readGate(reply(true, "\n"))).toBe("off");
		expect(readGate(reply(true, "MACBOOK MINI\n"))).toBe("on");
		expect(readGate(reply(false, "", "HTTP 502: Bad Gateway"))).toEqual({ unknown: "HTTP 502: Bad Gateway" });
	});
});

describe("ci-run direct dispatch: the workflows' queue rules", () => {
	const mine = { workflow: "ci", branch: "mine" };

	it("lets main and the listed branches ask for macOS, by exact name", () => {
		expect(refAllowed("main", "")).toBe(true);
		expect(refAllowed("a/b", "a/b c")).toBe(true);
		expect(refAllowed("c", "a/b,c")).toBe(true);
		expect(refAllowed("a", "a/b")).toBe(false);
		expect(refAllowed("a/b", "")).toBe(false);
	});

	it("refuses macOS to a branch outside MAC_REFS, and asks nothing of a run without macOS", () => {
		const lane = laneOf([], { workflow: "ci", branch: "x" });
		expect(decide({ workflow: "ci", inputs: { mac: "true" }, replace: false }, "x", "y", lane)).toMatchObject({
			go: false,
			code: 2,
		});
		expect(decide({ workflow: "ci", inputs: { batch: "true" }, replace: false }, "x", "y", lane)).toEqual({
			go: true,
		});
	});

	it("counts queued and running macOS jobs as the holder and pending ones as waiting, for dispatched runs", () => {
		const lane = laneOf([run(1, "ci", "a", "in_progress", "queued"), run(2, "e2e-nightly", "b", "pending")], mine);
		expect(lane.holders.map(r => r.id)).toEqual([1]);
		expect(lane.waiting.map(r => r.id)).toEqual([2]);
		expect(lane.openJobs).toBe(2);
	});

	it("leaves out the run this dispatch replaces, and jobs that are not macOS", () => {
		const linux: LaneRun = {
			id: 4,
			workflow: "ci",
			branch: "c",
			jobs: [{ status: "queued", labels: ["ubuntu-latest"] }],
		};
		expect(laneOf([run(3, "ci", "mine", "in_progress"), linux], mine)).toEqual({
			holders: [],
			waiting: [],
			openJobs: 0,
		});
	});

	it("refuses to replace another session's waiting macOS request unless told to, and notes a busy lane otherwise", () => {
		const args = { workflow: "ci", inputs: { mac: "true" }, replace: false };
		const full = laneOf([run(1, "ci", "a", "in_progress"), run(2, "e2e-nightly", "b", "pending")], mine);
		const refused = decide(args, "mine", "mine", full);
		expect(refused).toMatchObject({ go: false, code: 3 });
		expect(refused.go === false && refused.why).toContain("1 (ci, a)");
		expect(decide({ ...args, replace: true }, "mine", "mine", full)).toMatchObject({ go: true });
		const held = laneOf([run(1, "ci", "a", "in_progress")], mine);
		expect(decide(args, "mine", "mine", held)).toMatchObject({ go: true, note: expect.stringContaining("run 1") });
	});

	it("refuses a pending-only macOS request from another workflow even without a holder", () => {
		const lane = laneOf([run(707, "e2e-nightly", "parity-owner", "pending")], mine);
		const decision = decide({ workflow: "ci", inputs: { mac: "true" }, replace: false }, "mine", "mine", lane);
		expect(decision).toMatchObject({ go: false, code: 3 });
		expect(decision.go === false && decision.why).toContain("707 (e2e-nightly, parity-owner)");
	});

	it("permits replacing a pending-only request only when explicitly asked", () => {
		const lane = laneOf([run(707, "e2e-nightly", "parity-owner", "pending")], mine);
		expect(decide({ workflow: "ci", inputs: { mac: "true" }, replace: true }, "mine", "mine", lane)).toEqual({
			go: true,
		});
	});
});

const dispatchDirs: string[] = [];
afterEach(() => {
	for (const dir of dispatchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// PATH stand-ins are POSIX executables; the same dispatch/parser code runs on Windows without these shell fixtures.
describe.skipIf(process.platform === "win32")("ci-run dispatch receipt consumer", () => {
	const execute = promisify(execFile);
	function fixture(pendingOnly = false) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-dispatch-receipt-"));
		dispatchDirs.push(dir);
		fs.writeFileSync(
			path.join(dir, "ompdesk"),
			"#!/bin/sh\necho 'ompdesk: unknown command \"checks\"' >&2\nexit 2\n",
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(dir, "gh"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "$DISPATCH_TRACE"
for arg do
  case "$arg" in
    */actions/workflows/e2e-nightly.yml/runs?*)
      if [ "$PENDING_ONLY" = yes ]; then echo '{"workflow_runs":[{"id":707,"status":"pending","head_branch":"parity-owner"}]}'; else echo '{"workflow_runs":[]}'; fi
      exit 0 ;;
    */actions/workflows/ci.yml/runs?*|*/actions/workflows/flake-probe.yml/runs?*)
      echo '{"workflow_runs":[]}'; exit 0 ;;
    */actions/runs/707/jobs?*)
      echo '[{"status":"pending","labels":[]}]'; exit 0 ;;
    */dispatches)
      if [ "$EMPTY_RECEIPT" = yes ]; then echo '{}'; else
        printf '{"workflow_run_id":%s,"html_url":"https://github.com/test/repo/actions/runs/%s"}\\n' "$OWN_RUN" "$OWN_RUN"
      fi
      exit 0 ;;
  esac
done
if [ "$1 $2" = 'variable get' ]; then
  if [ "$3" = MAC_REFS ]; then echo concurrent-dispatch; fi
  exit 0
fi
if [ "$1 $2" = 'run list' ]; then
  echo '[{"databaseId":999999,"createdAt":"2099-01-01T00:00:00Z","headSha":"other","url":"https://github.com/test/repo/actions/runs/999999"}]'
else
  echo '{}'
fi
`,
			{ mode: 0o755 },
		);
		return {
			dir,
			start: (id: number, empty = false, argv = ["formal", "--ref", "concurrent-dispatch", "-f", "only=unit"]) =>
				execute("bun", [path.resolve("scripts/ci-run.ts"), ...argv], {
					env: {
						...process.env,
						PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
						OWN_RUN: String(id),
						DISPATCH_TRACE: path.join(dir, `trace-${id}`),
						EMPTY_RECEIPT: empty ? "yes" : "no",
						PENDING_ONLY: pendingOnly ? "yes" : "no",
					},
				}),
		};
	}

	it("keeps two concurrent dispatches on the same ref attached to their own returned run IDs", async () => {
		const { start } = fixture();
		const [first, second] = await Promise.all([start(101), start(202)]);
		expect(first.stdout).toContain("watch it once: bun scripts/watch-run.ts 101");
		expect(second.stdout).toContain("watch it once: bun scripts/watch-run.ts 202");
		expect(first.stdout + second.stdout).not.toContain("watch it once: bun scripts/watch-run.ts 999999");
	});

	it("retains an unconfirmed dispatch without selecting a recent candidate or dispatching again", async () => {
		const { start, dir } = fixture();
		await expect(start(303, true)).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("unconfirmed"),
		});
		const trace = fs.readFileSync(path.join(dir, "trace-303"), "utf8").trim().split("\n");
		expect(trace.filter(line => line.includes("/dispatches"))).toHaveLength(1);
	});

	it("refuses a pending-only lane with --wait and no holder without dispatching, cancelling or blind watching", async () => {
		const { start, dir } = fixture(true);
		await expect(
			start(404, false, ["ci", "--ref", "concurrent-dispatch", "-f", "mac=true", "--wait"]),
		).rejects.toMatchObject({
			code: 3,
			stderr: expect.stringContaining("707 (e2e-nightly, parity-owner)"),
		});
		const trace = fs.readFileSync(path.join(dir, "trace-404"), "utf8");
		expect(trace).not.toContain("/dispatches");
		expect(trace).not.toContain("/cancel");
		expect(trace).not.toContain("run watch");
	});
});
