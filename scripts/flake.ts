/**
 * Run one test file many times to catch a flaky test, instead of a hand-made probe branch:
 *
 *   bun run flake <spec> [--grep <regex>] [--repeat <n>]            here, under the machine-wide lock
 *   bun run flake <spec> [--grep <regex>] [--repeat <n>] --ci [--os macos|windows|ubuntu|all]
 *                                                                    on GitHub's runners (flake-probe.yml)
 *
 * `<spec>` is an e2e spec (`*.e2e.ts`: Playwright `--repeat-each`, after `bun run build`) or a vitest file (vitest
 * 3 has no repeat flag, only a per-test `repeats` option, so the file runs as `n` separate `vitest run`s, each
 * taking its own `vitest` slot so a waiter gets in between). Retries are off, a failure never stops the rest, and
 * the end prints the passes and failures, the failures per test and the first failure's message (also to
 * `$GITHUB_STEP_SUMMARY` on a runner). Exit 1 when anything failed, 2 when nothing ran or the call was wrong.
 * `--ci` dispatches flake-probe.yml on the current branch, which must be pushed as it is, and prints the run's URL.
 * See .omp/rules/e2e-ci-windows.md › Flaky tests.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run, runLocked } from "./build-lock";
import { browsersNeeded, missingBrowsers, missingBrowsersNotice } from "./e2e-browsers";

type Runner = "vitest" | "playwright";
const OS_CHOICES = ["all", "macos", "windows", "ubuntu"] as const;
type OsChoice = (typeof OS_CHOICES)[number];

interface Probe {
	runner: Runner;
	/** Repository-relative, forward slashes: the same on every OS and in the workflow's input. */
	spec: string;
	grep?: string;
	repeat: number;
}

/** One execution of one test. */
interface Outcome {
	test: string;
	ok: boolean;
	message?: string;
}

const ROOT = path.resolve(import.meta.dirname, "..");

function usage(message: string): never {
	console.error(
		`${message}\nusage: bun run flake <spec> [--grep <regex>] [--repeat <n>] [--ci [--os ${OS_CHOICES.join("|")}]]`,
	);
	process.exit(2);
}

function parse(argv: string[]): { probe: Probe; ci: boolean; os: OsChoice } {
	let spec: string | undefined;
	let grep: string | undefined;
	let repeat = 10;
	let ci = false;
	let osChoice: OsChoice = "all";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const value = () => argv[++i] ?? usage(`${arg} needs a value`);
		if (arg === "--grep") grep = value();
		else if (arg === "--repeat") {
			repeat = Number(value());
			if (!Number.isInteger(repeat) || repeat < 1) usage(`--repeat takes a count of 1 or more; got "${argv[i]}"`);
		} else if (arg === "--ci") ci = true;
		else if (arg === "--os") {
			const choice = value();
			if (!OS_CHOICES.includes(choice as OsChoice)) usage(`--os takes one of ${OS_CHOICES.join(", ")}`);
			osChoice = choice as OsChoice;
		} else if (arg.startsWith("-")) usage(`Unknown option ${arg}`);
		else if (spec) usage(`One spec at a time; got "${spec}" and "${arg}"`);
		else spec = arg;
	}
	if (!spec) usage("No spec");
	const absolute = path.resolve(spec);
	const relative = path.relative(ROOT, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) usage(`${spec} is outside this checkout`);
	if (!existsSync(absolute)) usage(`${spec} does not exist`);
	const posix = relative.split(path.sep).join("/");
	const runner: Runner = posix.endsWith(".e2e.ts") ? "playwright" : "vitest";
	return { probe: { runner, spec: posix, grep, repeat }, ci, os: osChoice };
}

interface VitestReport {
	testResults?: {
		name: string;
		status: string;
		message?: string;
		assertionResults?: { fullName: string; status: string; failureMessages?: string[] }[];
	}[];
}

/** A vitest JSON report's executions; a file that failed to load (no test ran in it) is one failed execution. */
function vitestOutcomes(report: VitestReport): Outcome[] {
	const outcomes: Outcome[] = [];
	for (const file of report.testResults ?? []) {
		const ran = (file.assertionResults ?? []).filter(test => test.status === "passed" || test.status === "failed");
		if (ran.length === 0 && file.status === "failed") {
			outcomes.push({ test: `${path.relative(ROOT, file.name)} (file)`, ok: false, message: file.message });
		}
		for (const test of ran) {
			outcomes.push({
				test: test.fullName,
				ok: test.status === "passed",
				message: test.failureMessages?.join("\n"),
			});
		}
	}
	return outcomes;
}

interface PlaywrightSuite {
	title: string;
	specs?: {
		title: string;
		tests: {
			projectName?: string;
			status: string;
			results: { error?: { message?: string }; errors?: { message?: string }[] }[];
		}[];
	}[];
	suites?: PlaywrightSuite[];
}

interface PlaywrightReport {
	suites?: PlaywrightSuite[];
	errors?: { message?: string }[];
}

/** A Playwright JSON report's executions (one per `--repeat-each` copy); a run-level error is one failed execution. */
function playwrightOutcomes(report: PlaywrightReport): Outcome[] {
	const outcomes: Outcome[] = (report.errors ?? []).map(error => ({
		test: "(run)",
		ok: false,
		message: error.message,
	}));
	const walk = (suite: PlaywrightSuite, titles: string[]) => {
		const here = suite.title ? [...titles, suite.title] : titles;
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests) {
				if (test.status === "skipped") continue;
				const failed = test.results.find(result => result.error ?? result.errors?.length);
				outcomes.push({
					test: [...here.slice(1), spec.title].join(" › "),
					ok: test.status === "expected",
					message: failed?.error?.message ?? failed?.errors?.[0]?.message,
				});
			}
		}
		for (const child of suite.suites ?? []) walk(child, here);
	};
	for (const suite of report.suites ?? []) walk(suite, []);
	return outcomes;
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function probeVitest(probe: Probe, scratch: string): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	for (let i = 1; i <= probe.repeat; i++) {
		const report = path.join(scratch, `vitest-${i}.json`);
		const command = ["bunx", "vitest", "run", probe.spec, "--retry=0", "--reporter=default", "--reporter=json"];
		command.push(`--outputFile.json=${report}`);
		if (probe.grep) command.push("-t", probe.grep);
		const result = await runLocked("vitest", command, { via: "flake", capture: true });
		const parsed = readJson<VitestReport>(report);
		const these = parsed ? vitestOutcomes(parsed) : [];
		// A run that crashed or wrote no report still counts as a failure, with the end of its output as the message.
		if (result.code !== 0 && these.every(outcome => outcome.ok)) {
			these.push({ test: "(vitest run)", ok: false, message: result.output.split("\n").slice(-40).join("\n") });
		}
		const failed = these.filter(outcome => !outcome.ok).length;
		console.log(
			`[flake] run ${i}/${probe.repeat}: ${these.length - failed} passed, ${failed} failed (${(result.ms / 1000).toFixed(1)}s)`,
		);
		outcomes.push(...these);
	}
	return outcomes;
}

async function probePlaywright(probe: Probe, scratch: string): Promise<Outcome[]> {
	if (process.platform === "linux") usage("The e2e specs launch the app, which runs on macOS and Windows only");
	const browsers = browsersNeeded(readFileSync(path.join(ROOT, probe.spec), "utf8"));
	const missing = await missingBrowsers(browsers);
	if (missing.length > 0) {
		// A runner is ephemeral and starts with none; on a developer's machine installing is the developer's call.
		if (process.env.GITHUB_ACTIONS) {
			if ((await run(["bunx", "playwright", "install", ...missing])).code !== 0) process.exit(1);
		} else {
			console.log(
				`[flake] warning: ${missingBrowsersNotice([probe.spec], new Map([[probe.spec, browsers]]), missing)}`,
			);
		}
	}
	const build = await runLocked("build", ["bun", "run", "build"], { via: "flake" });
	if (build.code !== 0) process.exit(1);
	const report = path.join(scratch, "playwright.json");
	process.env.PLAYWRIGHT_JSON_OUTPUT_NAME = report;
	process.env.PLAYWRIGHT_HTML_OPEN = "never";
	// A runner uploads test-results/ and playwright-report/; here a private folder, since other agents' runs wipe
	// the shared test-results/.
	const output = process.env.GITHUB_ACTIONS ? "test-results" : path.join(scratch, "test-results");
	const command = ["bunx", "playwright", "test", probe.spec, `--repeat-each=${probe.repeat}`, "--retries=0"];
	command.push(`--reporter=${process.env.GITHUB_ACTIONS ? "list,json,html" : "list,json"}`, `--output=${output}`);
	if (probe.grep) command.push(`--grep=${probe.grep}`);
	const result = await runLocked("playwright", command, { via: "flake" });
	const parsed = readJson<PlaywrightReport>(report);
	const outcomes = parsed ? playwrightOutcomes(parsed) : [];
	if (result.code !== 0 && outcomes.every(outcome => outcome.ok)) {
		outcomes.push({ test: "(playwright run)", ok: false, message: `Playwright ended with exit ${result.code}` });
	}
	if (!process.env.GITHUB_ACTIONS) console.log(`[flake] traces and screenshots of failures: ${output}`);
	return outcomes;
}

const OS_LABEL =
	process.env.RUNNER_OS?.toLowerCase() ?? { darwin: "macos", win32: "windows" }[process.platform as string] ?? "linux";

function report(probe: Probe, outcomes: readonly Outcome[]): number {
	const failures = outcomes.filter(outcome => !outcome.ok);
	const passed = outcomes.length - failures.length;
	const perTest = new Map<string, number>();
	for (const failure of failures) perTest.set(failure.test, (perTest.get(failure.test) ?? 0) + 1);
	const first = failures[0];
	const message = first
		? (first.message ?? "(no message)")
				.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
				.split("\n")
				.slice(0, 30)
				.join("\n")
				.trim()
		: "";
	const what = `${probe.spec}${probe.grep ? ` (grep ${probe.grep})` : ""} ×${probe.repeat}`;
	const verdict =
		outcomes.length === 0
			? "no test ran: a wrong path or --grep, or every test skipped"
			: `${passed} passed, ${failures.length} failed of ${outcomes.length}`;

	console.log(`\n[flake] ${OS_LABEL}: ${what}: ${verdict}`);
	for (const [test, count] of perTest) console.log(`  ${count}× ${test}`);
	if (first) console.log(`\n[flake] first failure: ${first.test}\n${message}`);

	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) {
		const lines = [`### ${OS_LABEL}: \`${what}\`: ${verdict}`, ""];
		if (perTest.size > 0) {
			lines.push("| failures | test |", "| ---: | --- |");
			for (const [test, count] of perTest) lines.push(`| ${count} | ${test.replaceAll("|", "\\|")} |`);
			lines.push("", `First failure, \`${first?.test}\`:`, "", "```", message, "```");
		}
		appendFileSync(summary, `${lines.join("\n")}\n`);
	}
	if (outcomes.length === 0) return 2;
	return failures.length > 0 ? 1 : 0;
}

function git(...args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

/** Dispatch flake-probe.yml for the pushed head of the current branch through the check queue's front door (scripts/ci-run.ts). */
function dispatch(probe: Probe, osChoice: OsChoice): number {
	const branch = git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch === "HEAD") usage("--ci needs a branch, not a detached HEAD");
	const head = git("rev-parse", "HEAD");
	const remote = git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0];
	if (remote !== head) {
		usage(`origin/${branch} is ${remote ? remote.slice(0, 9) : "missing"}, HEAD is ${head.slice(0, 9)}: push first`);
	}
	if (probe.runner === "playwright" && osChoice === "ubuntu") usage("The e2e specs run on macOS and Windows only");
	const fields = { spec: probe.spec, grep: probe.grep ?? "", repeat: String(probe.repeat), os: osChoice };
	const args = [path.join(ROOT, "scripts", "ci-run.ts"), "flake-probe", "--ref", branch];
	for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`);
	return spawnSync("bun", args, { cwd: ROOT, stdio: "inherit" }).status ?? 1;
}

if (import.meta.main) {
	const { probe, ci, os: osChoice } = parse(process.argv.slice(2));
	if (ci) process.exit(dispatch(probe, osChoice));
	const scratch = mkdtempSync(path.join(os.tmpdir(), "ompdesk-flake-"));
	console.log(`[flake] ${probe.runner}: ${probe.spec}${probe.grep ? ` -g ${probe.grep}` : ""} ×${probe.repeat}`);
	const outcomes =
		probe.runner === "playwright" ? await probePlaywright(probe, scratch) : await probeVitest(probe, scratch);
	process.exit(report(probe, outcomes));
}
