import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTlcDiagnostics } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-diagnostics";
import { runTlc } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-run";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlc-diagnostics-test-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(name: string) {
	const dir = path.join(root, name);
	fs.mkdirSync(dir);
	const spec = path.join(dir, "Example.tla");
	fs.writeFileSync(spec, "---- MODULE Example ----\n====\n");
	fs.writeFileSync(path.join(dir, "Example.cfg"), "");
	const java = path.join(dir, "fake-java");
	fs.writeFileSync(
		java,
		`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'argv.json'), JSON.stringify(args));
const states = args[args.indexOf('-metadir') + 1];
fs.mkdirSync(states);
fs.writeFileSync(path.join(states, 'queue'), 'metadata only');
if (process.env.JAVA_TOOL_OPTIONS) process.stdout.write('Picked up JAVA_TOOL_OPTIONS: ' + process.env.JAVA_TOOL_OPTIONS + '\\n');
process.stdout.write('Progress(1) complete\\nStarting checkpoint...\\n');
process.stdout.write('Er');
setImmediate(() => {
  process.stdout.write('ror: TLC failed\\njava.io.IOException: No space left on device: ' + states + '/queue\\nCaused by: java.io.IOException: hidden-secret-IOException\\n    at tlc.Store.write(Store.java:1)\\nError: second failure\\n');
  process.exitCode = 7;
});
`,
	);
	fs.chmodSync(java, 0o755);
	const jar = path.join(dir, "tla.jar");
	fs.writeFileSync(jar, "fake jar");
	return {
		dir,
		spec,
		java,
		jar,
		tla: {
			java,
			javaSource: "system" as const,
			javaMajor: 21,
			tla2tools: jar,
			community: jar,
			classpath: jar,
			tlaVersion: "fake",
			communityVersion: "fake",
		},
	};
}

interface DiagnosticRecord {
	event: string;
	argv: Array<string | object>;
	environment: Record<string, { tokens: Array<string | object> }>;
	files: { topFiles: Array<{ path: string }>; truncated: boolean; visited: number };
	directories: Record<string, { dev: number; path: string }>;
	excerpt: string[];
	jars: Array<{ path: string; sha256: string }>;
}

function events(dir: string): DiagnosticRecord[] {
	return fs
		.readFileSync(path.join(dir, "tlc-diagnostics.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

describe.skipIf(process.platform === "win32")("TLC diagnostics", () => {
	it("captures events before cleanup without exposing extra flags or JVM secrets", async () => {
		const f = fixture("failure");
		const outDir = path.join(f.dir, "diagnostics");
		const previous = process.env.JAVA_TOOL_OPTIONS;
		process.env.JAVA_TOOL_OPTIONS = "-Xmx512m -Dpassword=hidden-secret-IOException";
		try {
			const result = await runTlc({
				tla: f.tla,
				spec: f.spec,
				diagnostics: { outDir },
				extraArgs: ["-lncheck", "final", "-secret", "secret-argument"],
			});
			expect(result.code).toBe(7);
			expect(result.result.outcome).toBe("error");
			const records = events(outDir);
			expect(records.map(record => record.event)).toEqual(["start", "progress", "progress", "first-error", "close"]);
			expect(records[0].argv).toContain("-Dtlc2.output.MP.noDebug=true");
			expect(records[0].argv).toContain("-lncheck");
			expect(records[0].argv).toContain("final");
			expect(records[0].jars[0].sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(records[0].environment.JAVA_TOOL_OPTIONS.tokens[0]).toBe("-Xmx512m");
			expect(JSON.stringify(records)).not.toContain("hidden-secret");
			expect(JSON.stringify(records)).not.toContain("secret-argument");
			expect(records[3].files.topFiles.some((file: { path: string }) => file.path === "states/queue")).toBe(true);
			expect(records[4].directories.scratch.dev).toBeTypeOf("number");
			expect(records[4].excerpt.join(" ")).toContain("Store.write");
			expect(records[4].excerpt.join(" ")).toContain("java.io.IOException: No space left on device:");
			expect(fs.existsSync(records[4].directories.scratch.path)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.JAVA_TOOL_OPTIONS;
			else process.env.JAVA_TOOL_OPTIONS = previous;
		}
	});

	it("preserves the ordinary argv and verdict when diagnostics are off or cannot write", async () => {
		const f = fixture("opt-out");
		const without = await runTlc({ tla: f.tla, spec: f.spec });
		const argv = JSON.parse(fs.readFileSync(path.join(f.dir, "argv.json"), "utf8")) as string[];
		expect(argv).not.toContain("-Dtlc2.output.MP.noDebug=true");
		const firstScratch = path.dirname(argv[argv.indexOf("-metadir") + 1]);
		expect(fs.existsSync(firstScratch)).toBe(false);
		const blocked = path.join(f.dir, "not-a-directory");
		fs.writeFileSync(blocked, "x");
		const withFailure = await runTlc({ tla: f.tla, spec: f.spec, diagnostics: { outDir: blocked } });
		const diagnosticArgv = JSON.parse(fs.readFileSync(path.join(f.dir, "argv.json"), "utf8")) as string[];
		expect(diagnosticArgv).toContain("-Dtlc2.output.MP.noDebug=true");
		expect(fs.existsSync(path.dirname(diagnosticArgv[diagnosticArgv.indexOf("-metadir") + 1]))).toBe(false);
		expect(
			diagnosticArgv
				.filter(arg => arg !== "-Dtlc2.output.MP.noDebug=true")
				.map(arg => arg.replace(/ompdesk-tlc-[^/\\]+/g, "ompdesk-tlc-SCRATCH")),
		).toEqual(argv.map(arg => arg.replace(/ompdesk-tlc-[^/\\]+/g, "ompdesk-tlc-SCRATCH")));
		expect(withFailure.code).toBe(without.code);
		expect(withFailure.result).toEqual(without.result);
		expect(withFailure.text.replace(/ompdesk-tlc-[^/\\]+/g, "ompdesk-tlc-SCRATCH")).toBe(
			without.text.replace(/ompdesk-tlc-[^/\\]+/g, "ompdesk-tlc-SCRATCH"),
		);
		expect(fs.existsSync(path.join(f.dir, "tlc-diagnostics.jsonl"))).toBe(false);
	});

	it("handles split lines once, caps walks, and never follows scratch symlinks", () => {
		const f = fixture("bounds");
		const scratch = path.join(f.dir, "scratch");
		const metadir = path.join(scratch, "states");
		const javaTmp = path.join(scratch, "jtmp");
		fs.mkdirSync(metadir, { recursive: true });
		fs.mkdirSync(javaTmp);
		const outside = path.join(f.dir, "outside");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "secret-state"), "do not copy");
		fs.symlinkSync(outside, path.join(scratch, "link"), "dir");
		for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(metadir, `file-${i}`), "x");
		const outDir = path.join(f.dir, "out");
		const collector = createTlcDiagnostics({
			outDir,
			scratch,
			metadir,
			javaTmp,
			java: f.java,
			javaSource: "system",
			javaMajor: 21,
			jars: [f.jar],
			args: ["-workers", "1"],
			extraArgs: [],
		});
		collector.start();
		collector.data("Prog");
		collector.data("ress(1) done\nEr");
		collector.data("ror: first\nError: second\n");
		collector.close({ code: 7, signal: null, stdout: "", stderr: "", timedOut: false });
		const records = events(outDir);
		expect(records.map(record => record.event)).toEqual(["start", "progress", "first-error", "close"]);
		expect(records[2].files.truncated).toBe(true);
		expect(records[2].files.visited).toBe(2000);
		expect(records[2].files.topFiles.length).toBeLessThanOrEqual(30);
		expect(JSON.stringify(records)).not.toContain("secret-state");
		expect(JSON.stringify(records)).not.toContain("do not copy");
	});
});
