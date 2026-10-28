/**
 * The statechart tools' audit findings (S1 to S8), each pinned by a case named after it. The cases that need the real
 * TLC (the model of the output folder, a full from-spec run) run with `OMP_GUI_REAL_FORMAL=1` and
 * `OMPDESK_FORMAL_CACHE` pointing at a cache that already holds TLC; the others need nothing installed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const STATECHART = path.join(SKILL, "scripts/statechart");
const REAL = process.env.OMP_GUI_REAL_FORMAL === "1";
const CACHE = process.env.OMPDESK_FORMAL_CACHE ?? path.join(os.tmpdir(), "formal-cache");
const POSIX = process.platform !== "win32";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-audit-statechart-"));
afterAll(() => {
	// A case may leave a read-only folder behind.
	spawnSync("chmod", ["-R", "u+rwX", temp]);
	fs.rmSync(temp, { recursive: true, force: true });
});

interface Lib {
	parseMermaid: (text: string) => {
		regions: Record<string, { states: Set<string>; transitions: { from: string; to: string; label: string }[] }>;
		nevers: { name: string; states: string[]; sentence: string }[];
	};
	moved: (from: string, to: string, ...missed: string[]) => boolean;
}

async function lib(): Promise<Lib> {
	return (await import(/* @vite-ignore */ path.join(STATECHART, "lib.mjs"))) as Lib;
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(temp, "case-"));
});

function bun(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync("bun", [path.join(STATECHART, script), ...args], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, HOME: dir, USERPROFILE: dir, ...env },
	});
	if (result.error) throw result.error;
	return { code: result.status, out: result.stdout, err: result.stderr, text: `${result.stdout}${result.stderr}` };
}

const write = (name: string, text: string) => {
	fs.writeFileSync(path.join(dir, name), text);
	return path.join(dir, name);
};

const TWO_STATES = "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Paid : pay\n";

describe("S1: a %% never line that the strict form rejects is an error, never a silent comment", () => {
	const cases: [string, string][] = [
		["a Korean rule name", "%% never 결제없음: Idle & Paid -- text"],
		["a rule name with a hyphen", "%% never paid-twice: Idle & Paid -- text"],
		["a capital N in never", "%% Never PaidTwice: Idle & Paid -- text"],
		["a missing colon", "%% never PaidTwice Idle & Paid -- text"],
		["no space after the percent signs", "%%never PaidTwice Idle"],
	];
	for (const [why, line] of cases) {
		it(`rejects ${why}, and the message names the rule`, async () => {
			const { parseMermaid } = await lib();
			const name = line.match(/never\s+(\S+)/i)?.[1] ?? "";
			expect(() => parseMermaid(`${TWO_STATES}  ${line}\n`)).toThrow(name);
		});
	}

	it("chart-to-tla exits non-zero and leaves no spec when a never line is malformed", () => {
		write("bad.mmd", `${TWO_STATES}  %% never 결제없음: Idle & Paid -- text\n`);
		const result = bun("chart-to-tla.mjs", ["bad.mmd", "--module", "Bad"]);
		expect(result.code).not.toBe(0);
		expect(result.text).toContain("결제없음");
		expect(fs.existsSync(path.join(dir, "Bad.tla"))).toBe(false);
	});

	it("still reads a well-formed never line, with and without a sentence", async () => {
		const { parseMermaid } = await lib();
		const { nevers } = parseMermaid(`${TWO_STATES}  %% never A_1: Idle & Paid -- why\n  %% never B2: Idle\n`);
		expect(nevers.map(n => n.name)).toEqual(["A_1", "B2"]);
		expect(nevers[0].sentence).toBe("why");
	});

	it("an ordinary comment that does not start with never stays a comment", async () => {
		const { parseMermaid } = await lib();
		expect(() => parseMermaid(`${TWO_STATES}  %% the rules below never change\n`)).not.toThrow();
	});
});

describe("S2: header words are matched exactly, so a state id may start with one", () => {
	it("keeps a transition whose state id starts with note, direction, classDef or stateDiagram", async () => {
		const { parseMermaid } = await lib();
		const { regions } = parseMermaid(
			[
				"stateDiagram-v2",
				"  [*] --> notePending",
				"  notePending --> Sent : send",
				"  Sent --> directionLeft : turn",
				"  directionLeft --> classDefault : mark",
				"  classDefault --> stateDiagramDone : finish",
				"",
			].join("\n"),
		);
		expect([...regions.Main.states].sort()).toEqual(
			["Sent", "classDefault", "directionLeft", "notePending", "stateDiagramDone"].sort(),
		);
		expect(regions.Main.transitions.map(t => `${t.from}>${t.to}`)).toContain("notePending>Sent");
	});

	it("still skips the real header, direction, classDef, class and note lines", async () => {
		const { parseMermaid } = await lib();
		const { regions } = parseMermaid(
			[
				"stateDiagram-v2",
				"  direction LR",
				"  classDef bad fill:#f00",
				"  [*] --> Idle",
				"  Idle --> Paid : pay",
				"  class Paid bad",
				"  note right of Idle : the start",
				"  note left of Paid : the end",
				"",
			].join("\n"),
		);
		expect([...regions.Main.states].sort()).toEqual(["Idle", "Paid"]);
	});

	it("reads stateDiagram without -v2 as a header too", async () => {
		const { parseMermaid } = await lib();
		expect([...parseMermaid("stateDiagram\n  [*] --> A\n  A --> B : go\n").regions.Main.states].sort()).toEqual([
			"A",
			"B",
		]);
	});

	it("does not turn accTitle or accDescr into a state", async () => {
		const { parseMermaid } = await lib();
		const { regions } = parseMermaid(
			[
				"stateDiagram-v2",
				"  accTitle: Paying",
				"  accDescr: how paying works",
				"  accDescr {",
				"    a long text",
				"    over lines",
				"  }",
				"  [*] --> Idle",
				"  Idle --> Paid : pay",
				"",
			].join("\n"),
		);
		expect([...regions.Main.states].sort()).toEqual(["Idle", "Paid"]);
	});

	it("skips a multi-line note, and the lines inside it are not read as chart lines", async () => {
		const { parseMermaid } = await lib();
		const { regions } = parseMermaid(
			[
				"stateDiagram-v2",
				"  [*] --> Idle",
				"  note right of Idle",
				"    Paid --> Nowhere : not a step",
				"    free text here",
				"  end note",
				"  Idle --> Paid : pay",
				"",
			].join("\n"),
		);
		expect([...regions.Main.states].sort()).toEqual(["Idle", "Paid"]);
	});
});

describe("S3: a rename that Windows refuses with EPERM is retried once when the folder has gone", () => {
	function setup() {
		const from = path.join(dir, "next");
		const to = path.join(dir, "out");
		fs.mkdirSync(from);
		fs.writeFileSync(path.join(from, "new.txt"), "new");
		fs.mkdirSync(to);
		fs.writeFileSync(path.join(to, "old.txt"), "old");
		return { from, to };
	}
	const eperm = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

	it("another run moving `out` aside between the refusal and the check is not an error", async () => {
		const { moved } = await lib();
		const { from, to } = setup();
		const real = fs.renameSync;
		let calls = 0;
		fs.renameSync = (a: fs.PathLike, b: fs.PathLike) => {
			calls++;
			if (calls === 1) {
				// Refused because `out` exists, and then the other run moves it away before the existence check.
				fs.rmSync(to, { recursive: true });
				throw eperm();
			}
			real(a, b);
		};
		try {
			expect(moved(from, to, "ENOTEMPTY", "EEXIST")).toBe(true);
		} finally {
			fs.renameSync = real;
		}
		expect(calls).toBe(2);
		expect(fs.readFileSync(path.join(to, "new.txt"), "utf8")).toBe("new");
	});

	it("EPERM on the retry with the folder back is a refusal (false), so the caller moves it aside", async () => {
		const { moved } = await lib();
		const { from, to } = setup();
		const real = fs.renameSync;
		let calls = 0;
		fs.renameSync = () => {
			calls++;
			if (calls === 1) {
				fs.rmSync(to, { recursive: true });
				throw eperm();
			}
			fs.mkdirSync(to);
			throw eperm();
		};
		try {
			expect(moved(from, to, "ENOTEMPTY", "EEXIST")).toBe(false);
		} finally {
			fs.renameSync = real;
		}
		expect(calls).toBe(2);
	});

	it("EPERM twice on a free target is a real permission error and throws after one retry", async () => {
		const { moved } = await lib();
		const { from, to } = setup();
		fs.rmSync(to, { recursive: true });
		const real = fs.renameSync;
		let calls = 0;
		fs.renameSync = () => {
			calls++;
			throw eperm();
		};
		try {
			expect(() => moved(from, to, "ENOTEMPTY", "EEXIST")).toThrow("EPERM");
		} finally {
			fs.renameSync = real;
		}
		expect(calls).toBe(2);
	});

	it("EPERM with `to` present stays a plain refusal on the first try", async () => {
		const { moved } = await lib();
		const { from, to } = setup();
		const real = fs.renameSync;
		let calls = 0;
		fs.renameSync = () => {
			calls++;
			throw eperm();
		};
		try {
			expect(moved(from, to, "ENOTEMPTY", "EEXIST")).toBe(false);
		} finally {
			fs.renameSync = real;
		}
		expect(calls).toBe(1);
	});

	describe.skipIf(!REAL)("the model of the output folder, with three runs", () => {
		const MODEL = path.join(STATECHART, "model");

		async function tlc(tla: string, cfg: string) {
			const { prepareTla } = (await import(/* @vite-ignore */ path.join(SKILL, "scripts/lib/tla-env.ts"))) as {
				prepareTla: (o: { env: NodeJS.ProcessEnv }) => Promise<{ java: string; tla2tools: string }>;
			};
			const tools = await prepareTla({ env: { ...process.env, OMPDESK_FORMAL_CACHE: CACHE } });
			const work = fs.mkdtempSync(path.join(dir, "tlc-"));
			fs.writeFileSync(path.join(work, "OutputFolder.tla"), tla);
			fs.writeFileSync(path.join(work, "OutputFolder.cfg"), cfg);
			const r = spawnSync(
				tools.java,
				[
					"-cp",
					tools.tla2tools,
					"tlc2.TLC",
					"-deadlock",
					"-workers",
					"4",
					"-metadir",
					path.join(work, "m"),
					"OutputFolder.tla",
				],
				{ cwd: work, encoding: "utf8", maxBuffer: 1 << 28 },
			);
			return { code: r.status, text: `${r.stdout}${r.stderr}` };
		}

		it("ships with Runs == {1, 2, 3} and TLC passes every rule on the fixed protocol", async () => {
			const tla = fs.readFileSync(path.join(MODEL, "OutputFolder.tla"), "utf8");
			expect(tla).toContain("Runs == {1, 2, 3}");
			expect(tla).toContain("epermCheck");
			const result = await tlc(tla, fs.readFileSync(path.join(MODEL, "OutputFolder.cfg"), "utf8"));
			expect(result.text).toContain("Model checking completed. No error has been found.");
			expect(result.code).toBe(0);
		}, 120_000);

		it("TLC finds the false exit 2 when the EPERM check is not followed by a retry", async () => {
			const tla = fs.readFileSync(path.join(MODEL, "OutputFolder.tla"), "utf8");
			const old = tla.replace("/\\ Retry(r)", '/\\ Exit(r, "2")');
			expect(old).not.toBe(tla);
			const result = await tlc(old, fs.readFileSync(path.join(MODEL, "OutputFolder.cfg"), "utf8"));
			expect(result.text).toContain("Invariant OverlapNeverRefuses is violated");
		}, 120_000);
	});
});

/** A `java` that records its arguments and fails the way a missing TLC output would. */
function fakeJava(opts: { sany?: "fail" | "pass" } = {}) {
	const log = path.join(dir, "java-args.log");
	const file = path.join(dir, "fake-java");
	fs.writeFileSync(
		file,
		[
			"#!/bin/sh",
			`echo "$@" >> "${log}"`,
			'for a in "$@"; do',
			'  if [ "$a" = "tla2sany.SANY" ]; then',
			opts.sany === "fail"
				? '    echo "Fatal errors while parsing TLA+ spec in file Gen.tla"; exit 255'
				: "    exit 0",
			"  fi",
			"done",
			"exit 1",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return { file, log };
}

const SPEC = [
	"---- MODULE Pay ----",
	"EXTENDS Naturals",
	"VARIABLES x",
	"Init == x = 0",
	"Next == x' = x",
	"Spec == Init /\\ [][Next]_x",
	"Ok == x = 0",
	"====",
	"",
].join("\n");
const MAP =
	"export const readerActions = [];\nexport const state = (v) => String(v.x);\nexport const step = (a) => a;\n";

function plainFrom(extra: NodeJS.ProcessEnv = {}) {
	write("Pay.tla", SPEC);
	write("Pay.cfg", "SPECIFICATION Spec\nINVARIANT Ok\n");
	write("Pay.map.mjs", MAP);
	return { ...extra };
}

describe("S4: java reads and writes UTF-8 whatever the code page", () => {
	it.skipIf(!POSIX)("every java spawn of from-spec carries the four UTF-8 flags", () => {
		const { file, log } = fakeJava();
		plainFrom();
		const result = bun("statechart.mjs", ["from-spec", "Pay.tla"], {
			TLA2TOOLS: path.join(dir, "Pay.tla"),
			JAVA: file,
		});
		expect(result.code, result.text).toBe(2);
		const args = fs.readFileSync(log, "utf8");
		for (const flag of [
			"-Dfile.encoding=UTF-8",
			"-Dstdout.encoding=UTF-8",
			"-Dsun.stdout.encoding=UTF-8",
			"-Dsun.stderr.encoding=UTF-8",
		])
			expect(args).toContain(flag);
	});
});

describe("S5: a broken map file or a stuck cleanup is a clean exit 2, not a crash that reads as a broken rule", () => {
	it("a syntax error in the map file exits 2 and names the file and the error", () => {
		plainFrom();
		write("Pay.map.mjs", "export const state = (v) => {\n");
		const { file } = fakeJava();
		const result = bun("statechart.mjs", ["from-spec", "Pay.tla"], {
			TLA2TOOLS: path.join(dir, "Pay.tla"),
			JAVA: file,
		});
		expect(result.code, result.text).toBe(2);
		expect(result.err).toContain("Pay.map.mjs");
	});

	it("an unexpected error (a config that is a folder) is printed and exits 2, not 1", () => {
		plainFrom();
		fs.mkdirSync(path.join(dir, "cfgdir"));
		const result = bun("statechart.mjs", ["from-spec", "Pay.tla", "--config", "cfgdir"], {
			TLA2TOOLS: path.join(dir, "Pay.tla"),
			JAVA: fakeJava().file,
		});
		expect(result.code, result.text).toBe(2);
		expect(result.err).toContain("unexpected error");
		expect(result.err).toContain("EISDIR");
	});

	it.skipIf(!REAL || !POSIX || process.getuid?.() === 0)(
		"a cleanup that fails after a published run warns and exits by the verdict",
		() => {
			const LEAKY = [
				"---- MODULE Pay ----",
				"EXTENDS Naturals",
				"VARIABLES x",
				"Init == x = 0",
				"Inc == x < 2 /\\ x' = x + 1",
				"Next == Inc",
				"Spec == Init /\\ [][Next]_x",
				"Small == x < 5",
				"====",
				"",
			].join("\n");
			write("Pay.tla", LEAKY);
			write("Pay.cfg", "SPECIFICATION Spec\nINVARIANT Small\n");
			write(
				"Pay.map.mjs",
				`export const readerActions = ["Inc"];\nexport const state = (v) => "n" + v.x;\nexport const step = (a) => a;\n`,
			);
			const env = { OMPDESK_FORMAL_CACHE: CACHE, TLA2TOOLS: "", JAVA: "" };
			const first = bun("statechart.mjs", ["from-spec", "Pay.tla"], env);
			expect(first.code, first.text).toBe(0);
			// The previous output's tlc folder cannot be emptied, so removing the old folder fails after the new one is in.
			const stuck = path.join(dir, "Pay-statechart", "tlc");
			fs.chmodSync(stuck, 0o555);
			const second = bun("statechart.mjs", ["from-spec", "Pay.tla"], env);
			fs.chmodSync(path.join(dir, `${fs.readdirSync(dir).find(f => f.endsWith("-old")) ?? "x"}`, "tlc"), 0o755);
			expect(second.code, second.text).toBe(0);
			expect(second.err).toMatch(/could not remove|cannot remove|could not be removed/);
			expect(fs.existsSync(path.join(dir, "Pay-statechart", "chart.mmd"))).toBe(true);
		},
		180_000,
	);
});

describe("S6: TLA+ keywords are not used as names, and a spec that SANY rejects is not kept", () => {
	it("chart-to-tla renames an action called IN, TRUE or OTHER", () => {
		write(
			"kw.mmd",
			"stateDiagram-v2\n  [*] --> A\n  A --> B : IN\n  B --> C : TRUE\n  C --> D : other\n  D --> A : CASE\n",
		);
		const result = bun("chart-to-tla.mjs", ["kw.mmd", "--module", "Kw"]);
		expect(result.code, result.text).toBe(0);
		const spec = fs.readFileSync(path.join(dir, "Kw.tla"), "utf8");
		for (const word of ["IN", "TRUE", "CASE"]) expect(spec).not.toMatch(new RegExp(`^${word} ==`, "m"));
		expect(spec).toMatch(/^IN2 ==/m);
		expect(spec).toMatch(/^TRUE2 ==/m);
		expect(spec).toMatch(/^CASE2 ==/m);
	});

	it("a never rule named like a keyword is refused with a clear message", () => {
		write("kw.mmd", "stateDiagram-v2\n  [*] --> A\n  A --> B : go\n  %% never DOMAIN: B -- x\n");
		const result = bun("chart-to-tla.mjs", ["kw.mmd", "--module", "Kw"]);
		expect(result.code).not.toBe(0);
		expect(result.text).toContain("DOMAIN");
	});

	it.skipIf(!POSIX)("from-chart removes the spec it wrote when SANY rejects it, and says so", () => {
		write("kw.mmd", "stateDiagram-v2\n  [*] --> A\n  A --> B : go\n");
		const { file } = fakeJava({ sany: "fail" });
		const result = bun("statechart.mjs", ["from-chart", "kw.mmd", "--module", "Kw"], {
			TLA2TOOLS: path.join(dir, "kw.mmd"),
			JAVA: file,
		});
		expect(result.code, result.text).toBe(2);
		expect(result.text).toContain("Fatal errors while parsing");
		for (const f of ["Kw.tla", "Kw.cfg", "Kw.map.mjs"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(false);
	});

	it.skipIf(!POSIX)("from-chart keeps the spec it wrote when SANY accepts it", () => {
		write("kw.mmd", "stateDiagram-v2\n  [*] --> A\n  A --> B : go\n");
		const { file } = fakeJava({ sany: "pass" });
		bun("statechart.mjs", ["from-chart", "kw.mmd", "--module", "Kw"], {
			TLA2TOOLS: path.join(dir, "kw.mmd"),
			JAVA: file,
		});
		for (const f of ["Kw.tla", "Kw.cfg", "Kw.map.mjs"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
	});
});

describe("S7: the error line of a script that Bun runs is found", () => {
	it("from-chart reports chart-to-tla's own message, without Bun's source excerpt", () => {
		write("bad.mmd", "stateDiagram-v2\n  [*] --> A\n  A --> B : go\n  %% never X: Nope -- text\n");
		const result = bun("statechart.mjs", ["from-chart", "bad.mmd", "--module", "Bad"], {
			TLA2TOOLS: path.join(dir, "bad.mmd"),
		});
		expect(result.code, result.text).toBe(2);
		expect(result.err.trim()).toBe('bad.mmd: never line names "Nope", which is not a state in the chart');
	});
});

describe("S8: the files an operating system adds to a folder are not foreign", () => {
	for (const name of ["Thumbs.db", "desktop.ini", ".DS_Store"]) {
		it(`${name} in the output folder does not stop a run`, () => {
			plainFrom();
			const out = path.join(dir, "out");
			fs.mkdirSync(out);
			fs.writeFileSync(path.join(out, name), "x");
			const result = bun("statechart.mjs", ["from-spec", "Pay.tla", "--out", "out"], {
				OMPDESK_FORMAL_CACHE: path.join(dir, "empty-cache"),
				OMPDESK_FORMAL_OFFLINE: "1",
				TLA2TOOLS: "",
				JAVA: "",
			});
			// It went on to prepare TLC (not available offline, exit 3) instead of refusing the folder (exit 2).
			expect(result.text).not.toContain("did not write");
			expect(result.code, result.text).toBe(3);
		});
	}

	it("a file of the user's is still refused", () => {
		plainFrom();
		fs.mkdirSync(path.join(dir, "out"));
		fs.writeFileSync(path.join(dir, "out", "notes.txt"), "mine");
		const result = bun("statechart.mjs", ["from-spec", "Pay.tla", "--out", "out"], { TLA2TOOLS: "", JAVA: "" });
		expect(result.code, result.text).toBe(2);
		expect(result.err).toContain("notes.txt");
	});
});
