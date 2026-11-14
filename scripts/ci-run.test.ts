import { describe, expect, it } from "vitest";
import { asksForMac, hubArgs, parseArgs, readGate, route } from "./ci-run";

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
