import { describe, expect, it } from "vitest";
import { asksForMac, hubArgs, parseArgs, route } from "./ci-run";

describe("ci-run arguments", () => {
	it("reads the workflow, the ref and every -f field", () => {
		expect(parseArgs(["ci.yml", "--ref", "feat/x", "-f", "batch=true", "-f", "win_e2e_grep=@smoke a=b"])).toEqual({
			workflow: "ci",
			ref: "feat/x",
			inputs: { batch: "true", win_e2e_grep: "@smoke a=b" },
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

	it("prints the hub's answer, a refusal as exit 2", () => {
		expect(route(true, answered("Checks held: run chk-1 waits.\n"))).toEqual({
			via: "hub",
			code: 0,
			text: "Checks held: run chk-1 waits.",
		});
		expect(route(false, answered("Checks refused: nothing was started.\nWhy: paused by the owner"))).toMatchObject({
			via: "hub",
			code: 2,
		});
	});

	it("dispatches without macOS directly when OMPdesk does not answer, and refuses macOS then", () => {
		const down = { code: 3, out: "", err: "ompdesk: OMPdesk is not running" };
		expect(route(false, down)).toEqual({ via: "direct" });
		expect(route(false, undefined)).toEqual({ via: "direct" });
		expect(route(true, down)).toMatchObject({
			via: "refused",
			code: 2,
			why: expect.stringContaining("open OMPdesk"),
		});
		expect(route(true, undefined)).toMatchObject({ via: "refused", code: 2 });
	});

	it("never sends macOS work around a hub that answered with an error", () => {
		const broken = { code: 1, out: "", err: "ompdesk: checks_source: gh is not signed in" };
		expect(route(true, broken)).toMatchObject({ via: "refused", code: 1, why: expect.stringContaining("signed in") });
		expect(route(false, broken)).toEqual({ via: "direct" });
	});
});
