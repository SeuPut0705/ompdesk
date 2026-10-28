import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const STATECHART = join(
	process.cwd(),
	"resources",
	"omp-builtin",
	"formal",
	"skills",
	"ompdesk-formal-verify",
	"scripts",
	"statechart",
);
const REAL = process.env.OMP_GUI_REAL_FORMAL === "1";

const CHART = `stateDiagram-v2
  state Screen {
    [*] --> Cart
    Cart --> Paying : tap Pay
    Paying --> Paid : charge goes through
    --
    [*] --> NotCharged
    NotCharged --> Charged : charge goes through
  }
  %% never PaidUncharged: Paid & NotCharged -- the paid screen never shows without a charge
`;

const LEAKY_SPEC = `---- MODULE Pay ----
EXTENDS Naturals
VARIABLES screen, charged

Init == screen = "cart" /\\ charged = 0

TapPay == screen = "cart" /\\ screen' = "paying" /\\ UNCHANGED charged
Charge == screen = "paying" /\\ charged < 2 /\\ charged' = charged + 1 /\\ screen' = "paid"
DoubleTap == screen = "paid" /\\ charged = 1 /\\ screen' = "paying" /\\ UNCHANGED charged

Next == TapPay \\/ Charge \\/ DoubleTap
Spec == Init /\\ [][Next]_<<screen, charged>>

\\* The customer is charged at most once.
ChargedOnce == charged <= 1
====
`;

const LEAKY_MAP = `export const readerActions = ["TapPay", "DoubleTap"];
const SCREENS = { cart: "Cart", paying: "Paying", paid: "Paid" };
export function state(v) {
	return v.charged > 1 ? "Paid: charged twice" : \`\${SCREENS[v.screen]}: \${v.charged ? "charged" : "not charged"}\`;
}
const STEPS = { TapPay: "tap Pay", Charge: "the charge goes through", DoubleTap: "tap Pay again" };
export function step(action) {
	return STEPS[action] ?? action;
}
export function cause() {
	return "tapping Pay again on the paid screen sends a second charge";
}
`;

let dir: string;
let home: string;

/** Runs a script of the ported statechart tools with bun, in `dir`, under a temporary HOME. */
function bun(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync("bun", [join(STATECHART, script), ...args], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
	});
	if (result.error) throw result.error;
	return { code: result.status, out: result.stdout, err: result.stderr };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompdesk-statechart-"));
	home = mkdtempSync(join(tmpdir(), "ompdesk-statechart-home-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("statechart scripts", () => {
	it("prints help and exits 0", { timeout: 20_000 }, () => {
		const result = bun("statechart.mjs", ["--help"]);
		expect(result.code, `${result.err}${result.out}`).toBe(0);
		expect(result.out).toContain("bun statechart.mjs from-spec SPEC.tla");
		expect(result.out).toContain("3  UNAVAILABLE");
	});

	it("compare-charts says same for equal charts and lists the differences otherwise", { timeout: 20_000 }, () => {
		const a =
			"stateDiagram-v2\n  [*] --> Idle\n  Idle --> Paying : tap Pay\n  Paying --> Paid : charge goes through\n";
		writeFileSync(join(dir, "a.mmd"), a);
		writeFileSync(
			join(dir, "b.mmd"),
			a.replace("Paying --> Paid : charge goes through", "Paying --> Idle : card declined"),
		);
		const same = bun("compare-charts.mjs", ["a.mmd", "a.mmd"]);
		expect(same.code, `${same.err}${same.out}`).toBe(0);
		expect(same.out.trim()).toBe("same");
		const different = bun("compare-charts.mjs", ["a.mmd", "b.mmd"]);
		expect(different.code, `${different.err}${different.out}`).toBe(1);
		expect(different.out).toContain("Paying --> Paid : charge goes through");
		expect(different.out).toContain("Paying --> Idle : card declined");
		expect(different.out).toContain("3 difference(s)");
	});

	it("chart-to-tla writes a spec, a config and a mapping from a chart", { timeout: 20_000 }, () => {
		writeFileSync(join(dir, "pay.mmd"), CHART);
		const result = bun("chart-to-tla.mjs", ["pay.mmd", "--module", "Pay"]);
		expect(result.code, `${result.err}${result.out}`).toBe(0);
		const spec = readFileSync(join(dir, "Pay.tla"), "utf8");
		expect(spec).toContain("---- MODULE Pay ----");
		expect(spec).toContain('PaidUncharged == ~(region1 = "Paid" /\\ region2 = "NotCharged")');
		expect(readFileSync(join(dir, "Pay.cfg"), "utf8")).toContain("INVARIANT PaidUncharged");
		expect(existsSync(join(dir, "Pay.map.mjs"))).toBe(true);
	});

	it("chart-to-tla exits 1 on a never line that names two states of one region", { timeout: 20_000 }, () => {
		writeFileSync(
			join(dir, "bad.mmd"),
			"stateDiagram-v2\n  [*] --> Idle\n  Idle --> Paid : pay\n  %% never X: Idle & Paid -- impossible\n",
		);
		const result = bun("chart-to-tla.mjs", ["bad.mmd", "--module", "Bad"]);
		expect(result.code, result.err).toBe(1);
		// The exit code alone would also be 1 for any crash: pin the reason.
		expect(result.err).toContain("names two states of one region");
	});

	it("exits 3 with UNAVAILABLE when TLC cannot be prepared offline", { timeout: 20_000 }, () => {
		writeFileSync(join(dir, "Pay.tla"), LEAKY_SPEC);
		writeFileSync(join(dir, "Pay.cfg"), "SPECIFICATION Spec\nINVARIANT ChargedOnce\n");
		writeFileSync(join(dir, "Pay.map.mjs"), LEAKY_MAP);
		const result = bun("statechart.mjs", ["from-spec", "Pay.tla"], {
			OMPDESK_FORMAL_CACHE: join(dir, "empty-cache"),
			OMPDESK_FORMAL_OFFLINE: "1",
			TLA2TOOLS: "",
			JAVA: "",
		});
		expect(result.code, `${result.err}${result.out}`).toBe(3);
		expect(result.err).toContain("UNAVAILABLE:");
	});

	it.runIf(REAL)("from-spec finds the double charge with the shared TLC cache", { timeout: 120_000 }, () => {
		writeFileSync(join(dir, "Pay.tla"), LEAKY_SPEC);
		writeFileSync(join(dir, "Pay.cfg"), "SPECIFICATION Spec\nINVARIANT ChargedOnce\n");
		writeFileSync(join(dir, "Pay.map.mjs"), LEAKY_MAP);
		const env = {
			OMPDESK_FORMAL_CACHE: process.env.OMPDESK_FORMAL_CACHE ?? "/tmp/formal-cache",
			TLA2TOOLS: "",
			JAVA: "",
		};
		const result = bun("statechart.mjs", ["from-spec", "Pay.tla", "--expect-broken", "ChargedOnce"], env);
		expect(result.err).toBe("");
		expect(result.code, `${result.err}${result.out}`).toBe(0);
		expect(result.out).toContain("ChargedOnce is broken (expected)");
		expect(result.out).toContain("4. The charge goes through. Now: Paid: charged twice");
		expect(readFileSync(join(dir, "Pay-statechart", "chart.mmd"), "utf8")).toContain("stateDiagram-v2");
		// The same spec without the expectation: the rule is broken, so exit 1.
		const second = bun("statechart.mjs", ["from-spec", "Pay.tla", "--out", "second"], env);
		expect(second.code, `${second.err}${second.out}`).toBe(1);
	});

	it.runIf(REAL)("from-chart draws the agreed chart back unchanged", { timeout: 120_000 }, () => {
		writeFileSync(join(dir, "pay.mmd"), CHART);
		const env = {
			OMPDESK_FORMAL_CACHE: process.env.OMPDESK_FORMAL_CACHE ?? "/tmp/formal-cache",
			TLA2TOOLS: "",
			JAVA: "",
		};
		const result = bun("statechart.mjs", ["from-chart", "pay.mmd", "--module", "Pay"], env);
		expect(result.code, `${result.err}${result.out}`).toBe(0);
		expect(result.out).toContain("The spec draws pay.mmd back unchanged.");
	});
});
