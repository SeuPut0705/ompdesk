/**
 * The check queue is managed by the workflows, not by whoever dispatches (.omp/rules/e2e-ci-windows.md › CI › The check
 * queue). Four rules, each pinned where a later edit would silently lose it:
 *
 *  1. Overlapping runs cancel themselves: main has one run going and the newest waiting, any other ref its newest run.
 *  2. Every macOS job of a dispatchable workflow sits behind the queue gate and in an account-wide lane.
 *  3. macOS is admitted to main and to MAC_REFS branches only.
 *  4. A commit with a green run of the same name is not run again.
 *
 * GitHub's own side of 1 and 2 (one holder and one waiting request per concurrency group, the newest waiting request
 * replacing an older one, `cancel-in-progress` read from the arriving run) was observed on the runners, not here; this
 * file keeps the workflows shaped so that side applies, and runs the gate's two shell steps as they run there.
 */
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = path.join(__dirname, "../..");
const WORKFLOWS = path.join(REPO, ".github", "workflows");

interface Step {
	id?: string;
	name?: string;
	run?: string;
	if?: string;
	"continue-on-error"?: boolean;
	env?: Record<string, string>;
}

interface Job {
	"runs-on"?: unknown;
	uses?: string;
	needs?: string | string[];
	if?: string | boolean;
	with?: Record<string, unknown>;
	concurrency?: { group?: string; "cancel-in-progress"?: unknown };
	strategy?: { matrix?: { os?: string } };
	steps?: Step[];
	secrets?: string | Record<string, string>;
}

interface Workflow {
	"run-name"?: string;
	on: Record<string, { inputs?: Record<string, unknown> } | null>;
	concurrency?: { group: string; "cancel-in-progress": unknown };
	jobs: Record<string, Job>;
}

const load = (name: string): Workflow => parse(fs.readFileSync(path.join(WORKFLOWS, name), "utf8")) as Workflow;
const files = fs.readdirSync(WORKFLOWS).filter(name => name.endsWith(".yml"));
const workflows = new Map(files.map(name => [name, load(name)]));

/** release.yml and skills-bump.yml are outside the queue rules: the release always runs first, the bump is one scheduled job with a group of its own. */
const OUTSIDE_THE_QUEUE: Record<string, true> = { "release.yml": true, "skills-bump.yml": true };

function localCall(job: Job): string | undefined {
	return job.uses?.startsWith("./.github/workflows/") ? path.basename(job.uses) : undefined;
}

function needsOf(job: Job): string[] {
	return typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
}

/** A job takes a macOS runner: it runs on one, runs on a matrix that lists one, or calls a workflow whose jobs do. */
function bearsMac(job: Job, seen = new Set<string>()): boolean {
	const runsOn = String(job["runs-on"] ?? "");
	if (runsOn.includes("macos")) return true;
	if (runsOn.includes("matrix.") && JSON.stringify(job.strategy?.matrix ?? {}).includes("macos")) return true;
	const called = localCall(job);
	if (!called || seen.has(called)) return false;
	seen.add(called);
	return Object.values(workflows.get(called)?.jobs ?? {}).some(inner => bearsMac(inner, seen));
}

/** The jobs of a workflow a person can dispatch (or the schedule starts), which the queue rules cover. */
const queued = [...workflows].filter(([name, wf]) => {
	if (OUTSIDE_THE_QUEUE[name]) return false;
	return "workflow_dispatch" in wf.on || "schedule" in wf.on;
});

function chain(wf: Workflow, id: string, seen = new Set<string>()): string[] {
	if (seen.has(id)) return [];
	seen.add(id);
	return [id, ...needsOf(wf.jobs[id] ?? {}).flatMap(dep => chain(wf, dep, seen))];
}

describe("every macOS job of a dispatchable workflow", () => {
	const macJobs = queued.flatMap(([name, wf]) =>
		Object.entries(wf.jobs)
			.filter(([, job]) => bearsMac(job))
			.map(([id, job]) => ({ name, id, job, wf })),
	);

	it("is found where it is expected, so this test cannot pass by finding none", () => {
		const found = macJobs.map(({ name, id }) => `${name}:${id}`).sort();
		expect(found).toEqual([
			"ci.yml:e2e",
			"ci.yml:mac",
			"e2e-nightly.yml:e2e",
			"e2e-nightly.yml:parity",
			"flake-probe.yml:probe",
		]);
	});

	it("holds the account-wide lane for as long as it runs, and never cancels the holder", () => {
		for (const { name, id, job } of macJobs) {
			const group = job.concurrency?.group ?? "";
			expect(group, `${name}:${id}`).toMatch(/mac-dispatch|mac-nightly/);
			expect(job.concurrency?.["cancel-in-progress"], `${name}:${id}`).toBe(false);
		}
	});

	it("starts only after the queue gate has run", () => {
		for (const { name, id, wf } of macJobs) {
			const trail = chain(wf, id);
			expect(trail, `${name}:${id}`).toContain("gate");
			expect(wf.jobs.gate?.uses, name).toBe("./.github/workflows/queue-gate.yml");
			// A dispatch is admitted by the gate's output, which is read by the first job on the way to the gate.
			const reads = trail.some(job => String(wf.jobs[job]?.if ?? "").includes("needs.gate.outputs.mac_ok"));
			expect(reads, `${name}:${id}`).toBe(true);
		}
	});

	it("uses only the lanes the queue knows", () => {
		// The dispatch lane every dispatched macOS job shares, and the nightly's own.
		for (const { job } of macJobs) {
			const lanes = [...(job.concurrency?.group ?? "").matchAll(/'(mac-[a-z-]+)'/g)].map(match => match[1]);
			for (const lane of lanes) expect(["mac-dispatch", "mac-nightly"]).toContain(lane);
		}
	});
});

describe("main and any other ref", () => {
	const ci = workflows.get("ci.yml") as Workflow;

	it("gives a push to main one run going and the newest waiting, never a cancelled running run", () => {
		expect(ci.concurrency?.group).toMatch(/^\$\{\{ github\.event_name == 'push' && 'ci-main' \|\| /);
		const cancel = String(ci.concurrency?.["cancel-in-progress"]);
		expect(cancel).toContain("github.event_name != 'push'");
		// Only a release commit, whose jobs are all skipped, cancels what runs, so release.yml's runners are free.
		expect(cancel).toContain("startsWith(github.event.head_commit.message, 'release: v')");
	});

	it("names a dispatch by what it was asked to run, in step with its group, so the same inputs are the same run", () => {
		const key = (text: string, before: string, after: string) => {
			const start = text.indexOf(before);
			const end = text.lastIndexOf(after);
			expect(start, text).toBeGreaterThanOrEqual(0);
			return text.slice(start + before.length, end);
		};
		const inName = key(ci["run-name"] ?? "", "format('ci [{0}]', ", ")) || ''");
		const inGroup = key(ci.concurrency?.group ?? "", "format('ci-{0}-{1}', github.ref, ", ")) }}");
		expect(inName).toBe(inGroup);
		// A new input that changes what runs must change the name, or two different runs read as one. `force` and the
		// admission `ticket` change nothing that runs (and a ticket is new on every dispatch).
		for (const input of Object.keys(ci.on.workflow_dispatch?.inputs ?? {})) {
			if (input === "force" || input === "ticket") continue;
			expect(inName, input).toContain(`inputs.${input}`);
		}
	});

	it("names the nightly's dispatches by their inputs too", () => {
		const nightly = workflows.get("e2e-nightly.yml") as Workflow;
		for (const input of Object.keys(nightly.on.workflow_dispatch?.inputs ?? {})) {
			if (input === "force" || input === "ticket") continue;
			expect(nightly["run-name"], input).toContain(`inputs.${input}`);
		}
	});

	it("leaves release.yml first in line: never cancelled, no gate, no lane", () => {
		const release = workflows.get("release.yml") as Workflow;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched as written
		expect(release.concurrency).toEqual({ group: "release-${{ github.ref }}", "cancel-in-progress": false });
		for (const job of Object.values(release.jobs)) {
			expect(job.uses ?? "").not.toContain("queue-gate");
			expect(job.concurrency).toBeUndefined();
		}
	});
});

describe("the macOS checks of a push to main", () => {
	const mac = workflows.get("mac-checks.yml") as Workflow;
	const main = workflows.get("mac-main.yml") as Workflow & { on: { push: { branches: string[] } } };

	it("are the four macOS checks, each on a macOS runner and none reading the caller's flags", () => {
		expect(Object.keys(mac.jobs).sort()).toEqual(["mac-native", "mac-smoke", "memory", "native"]);
		for (const [id, job] of Object.entries(mac.jobs)) {
			expect(job["runs-on"], id).toBe("macos-latest");
			// In a called workflow `inputs` is its own, not the dispatch's: admission is the caller's `if`.
			expect(String(job.if ?? ""), id).not.toContain("inputs.");
			expect(JSON.stringify(job.steps), id).not.toContain("inputs.");
		}
	});

	it("run from mac-main.yml, a queue of their own: one run going, the newest push waiting, a release commit ends both", () => {
		expect(Object.keys(main.on)).toEqual(["push"]);
		expect(main.on.push.branches).toEqual(["main"]);
		expect(main.concurrency?.group).toBe("mac-main");
		expect(String(main.concurrency?.["cancel-in-progress"])).toBe(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched as written
			"${{ startsWith(github.event.head_commit.message, 'release: v') }}",
		);
		expect(Object.keys(main.jobs)).toEqual(["mac"]);
		expect(main.jobs.mac?.uses).toBe("./.github/workflows/mac-checks.yml");
		expect(main.jobs.mac?.if).toContain("!startsWith(github.event.head_commit.message, 'release: v')");
		// The same pushes ci.yml answers: a macOS check of a push ci.yml skips (docs only) would be a run nobody reads.
		const ci = workflows.get("ci.yml") as Workflow & { on: { push: { "paths-ignore": string[] } } };
		expect(main.on.push).toEqual(ci.on.push);
	});

	it("are reached by no other workflow's job, so each macOS run of a push is in that queue", () => {
		const callers = [...workflows]
			.flatMap(([name, wf]) => Object.entries(wf.jobs).map(([id, job]) => ({ name, id, uses: localCall(job) })))
			.filter(call => call.uses === "mac-checks.yml")
			.map(call => `${call.name}:${call.id}`);
		expect(callers.sort()).toEqual(["ci.yml:mac", "mac-main.yml:mac"]);
	});
});

describe("the queue gate's steps, run as the runner runs them", () => {
	const gate = workflows.get("queue-gate.yml") as Workflow;
	const step = (id: string): Step => {
		const found = gate.jobs.gate?.steps?.find(candidate => candidate.id === id || candidate.name === id);
		if (!found?.run) throw new Error(`queue-gate.yml has no step ${id}`);
		return found;
	};
	// The gate's steps run on ubuntu-latest only. Each case starts bash (and the dedupe case jq and a fake gh script) per
	// call, which took 120 s for this file on a loaded Windows runner (run 43452782575, a 20 s timeout), so they run
	// where the steps run and on a developer's POSIX machine.
	const posix = process.platform !== "win32";
	const bash = posix && spawnSync("bash", ["--version"]).status === 0;
	const jq = posix && spawnSync("jq", ["--version"]).status === 0;
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-queue-gate-"));
	afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

	function admit(env: Record<string, string>): { status: number | null; macOk: string } {
		const output = path.join(scratch, `output-${Math.random().toString(36).slice(2)}`);
		// The runner sets every key of the step's `env`, an expression with no value as "" (the step runs `set -u`).
		const unset = Object.fromEntries(Object.keys(step("admit").env ?? {}).map(key => [key, ""]));
		const result = spawnSync("bash", ["-c", step("admit").run ?? ""], {
			env: { ...unset, PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, ...env },
			encoding: "utf8",
		});
		return { status: result.status, macOk: fs.readFileSync(output, "utf8").trim() };
	}
	const dispatch = (ref: string, macRefs: string, mac = "true") => ({
		EVENT: "workflow_dispatch",
		MAC: mac,
		MAC_REFS: macRefs,
		REF: `refs/heads/${ref}`,
		REF_NAME: ref,
	});

	it.skipIf(!bash)(
		"admits macOS to main, to a listed branch (space or comma separated), and to anything not asking for it",
		() => {
			expect(admit(dispatch("main", ""))).toEqual({ status: 0, macOk: "mac_ok=true" });
			expect(admit(dispatch("omp/agent/a", "omp/agent/a omp/agent/b"))).toEqual({ status: 0, macOk: "mac_ok=true" });
			expect(admit(dispatch("omp/agent/b", "omp/agent/a,omp/agent/b"))).toEqual({ status: 0, macOk: "mac_ok=true" });
			expect(admit(dispatch("feature", "", "false"))).toEqual({ status: 0, macOk: "mac_ok=true" });
			expect(admit({ ...dispatch("feature", ""), EVENT: "push" })).toEqual({ status: 0, macOk: "mac_ok=true" });
			expect(admit({ ...dispatch("x", ""), EVENT: "schedule" })).toEqual({ status: 0, macOk: "mac_ok=true" });
		},
	);

	it.skipIf(!bash)("refuses macOS to a branch that is not listed, however the list is written", () => {
		const denied = { status: 1, macOk: "mac_ok=false" };
		expect(admit(dispatch("feature", ""))).toEqual(denied);
		expect(admit(dispatch("feature", "other"))).toEqual(denied);
		// A name is not a prefix or a pattern: neither the list's glob characters nor part of a name match.
		expect(admit(dispatch("feature", "*"))).toEqual(denied);
		expect(admit(dispatch("feature", "feat"))).toEqual(denied);
		expect(admit(dispatch("feat", "feature"))).toEqual(denied);
		expect(admit(dispatch("feature/x", "feature"))).toEqual(denied);
	});

	/**
	 * The ticket the hub mints (native/ompdesk/crates/core/src/checks/ticket.rs `VECTOR`, pinned by its own test), checked
	 * by the two steps as the runner runs them under a `date` that says 2026-11-14, before the ticket's expiry: the first
	 * names the ticket's computer, GitHub then hands the second that computer's secret (modelled by `secrets`).
	 */
	const VECTOR = {
		device: "MACBOOK",
		key: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
		repo: "SeuPut0705/ompdesk",
		ref: "omp/agent/feature",
		sha: "0123456789abcdef0123456789abcdef01234567",
		ticket: "v1.MACBOOK.1800000000000.a5db0c6c659da7c94e6cb1bb0510878465d311d6485aeb71123e613ad6b71c1e",
	};
	const SECRETS: Record<string, string> = { CHECKS_ADMISSION_KEY_MACBOOK: VECTOR.key };
	const openssl = bash && spawnSync("openssl", ["version"]).status === 0;
	function deviceOf(ticket: string): string {
		const output = path.join(scratch, `device-${Math.random().toString(36).slice(2)}`);
		spawnSync("bash", ["-c", step("device").run ?? ""], {
			env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, TICKET: ticket },
		});
		return fs
			.readFileSync(output, "utf8")
			.trim()
			.replace(/^device=/, "");
	}
	function ticketed(overrides: Record<string, string>, now = 1_763_100_000, secrets = SECRETS) {
		const dir = fs.mkdtempSync(path.join(scratch, "date-"));
		fs.writeFileSync(path.join(dir, "date"), `#!/bin/sh\necho ${now}\n`, { mode: 0o755 });
		const ticket = overrides.TICKET ?? VECTOR.ticket;
		const device = deviceOf(ticket);
		return admit({
			...dispatch(VECTOR.ref, VECTOR.ref),
			PATH: `${dir}:${process.env.PATH ?? ""}`,
			REPO: VECTOR.repo,
			SHA: VECTOR.sha,
			DEVICES: "MACBOOK MINI",
			DEVICE: device,
			ADMISSION_KEY: secrets[`CHECKS_ADMISSION_KEY_${device}`] ?? "",
			...overrides,
			TICKET: ticket,
		});
	}

	it("reads one computer's key, by the device the ticket names, and every caller hands the gate the device list", () => {
		// A GitHub expression as the workflow file spells it.
		const expr = (inner: string) => `$\{{ ${inner} }}`;
		expect(step("admit").env).toMatchObject({
			DEVICE: expr("steps.device.outputs.device"),
			DEVICES: expr("inputs.admission-devices"),
			ADMISSION_KEY: expr("secrets[format('CHECKS_ADMISSION_KEY_{0}', steps.device.outputs.device)]"),
		});
		const callers = [...workflows.values()].flatMap(workflow =>
			Object.values(workflow.jobs).filter(job => localCall(job) === "queue-gate.yml"),
		);
		expect(callers.length).toBeGreaterThan(0);
		for (const job of callers) {
			expect(job.with?.["admission-devices"]).toBe(expr("vars.CHECKS_ADMISSION_DEVICES"));
			expect(job.secrets).toBe("inherit");
		}
	});

	it.skipIf(!bash)("names the ticket's computer only when it is one", () => {
		expect(deviceOf(VECTOR.ticket)).toBe("MACBOOK");
		for (const ticket of ["", "v1.garbage", "v1.macbook.1.ab", "v1.MAC-BOOK.1.ab", `v1.${"A".repeat(41)}.1.ab`]) {
			expect(deviceOf(ticket), ticket).toBe("");
		}
	});

	it.skipIf(!openssl)(
		"admits a macOS dispatch with the ticket its computer's hub minted for its repo, ref and commit",
		() => {
			expect(ticketed({})).toEqual({ status: 0, macOk: "mac_ok=true" });
			// While no computer has a key nothing is checked, ticket or not.
			expect(ticketed({ DEVICES: "", TICKET: "" }, undefined, {})).toEqual({ status: 0, macOk: "mac_ok=true" });
			// A dispatch that asks for no macOS needs none.
			expect(ticketed({ MAC: "false", TICKET: "" })).toEqual({ status: 0, macOk: "mac_ok=true" });
		},
	);

	it.skipIf(!openssl || !jq)("requires a fresh receipt for each rerun attempt before macOS work", () => {
		const dir = fs.mkdtempSync(path.join(scratch, "rerun-"));
		const output = path.join(dir, "output");
		const statuses = path.join(dir, "statuses.json");
		fs.writeFileSync(path.join(dir, "gh"), '#!/bin/sh\ncat "$STATUS_FILE"\n', { mode: 0o755 });
		fs.writeFileSync(path.join(dir, "date"), "#!/bin/sh\necho 1763100000\n", { mode: 0o755 });
		const scope = {
			PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
			GITHUB_OUTPUT: output,
			STATUS_FILE: statuses,
			EVENT: "workflow_dispatch",
			DEVICES: "MACBOOK MINI",
			REPO: VECTOR.repo,
			REF_NAME: VECTOR.ref,
			SHA: VECTOR.sha,
			RUN_ID: "12345",
			RUN_ATTEMPT: "2",
			GH_TOKEN: "test",
		};
		const message = [
			"ompdesk-checks-rerun-v1",
			VECTOR.device,
			VECTOR.repo,
			VECTOR.ref,
			VECTOR.sha,
			"12345",
			"2",
			"1800000000000",
		].join("\n");
		const mac = createHmac("sha256", Buffer.from(VECTOR.key, "hex")).update(message).digest("hex");
		const receipt = `v1.MACBOOK.1800000000000.${mac}`;
		const run = (attempt: string, rows: unknown[], overrides: Record<string, string> = {}) => {
			fs.writeFileSync(statuses, JSON.stringify(rows));
			fs.writeFileSync(output, "");
			const env = { ...scope, RUN_ATTEMPT: attempt, ...overrides };
			const fetch = spawnSync("bash", [path.join(REPO, "scripts/check-rerun-admission.sh"), "fetch"], { env });
			if (fetch.status !== 0) return fetch.status;
			const values = Object.fromEntries(
				fs
					.readFileSync(output, "utf8")
					.trim()
					.split("\n")
					.map(line => line.split("=")),
			);
			return spawnSync("bash", [path.join(REPO, "scripts/check-rerun-admission.sh"), "verify"], {
				env: {
					...env,
					NEEDED: values.needed ?? "",
					RECEIPT: values.receipt ?? "",
					ADMISSION_KEY: SECRETS[`CHECKS_ADMISSION_KEY_${values.device}`] ?? "",
				},
			}).status;
		};
		const row = { id: 1, context: "ompdesk-rerun/12345/2", state: "success", description: receipt };
		expect(run("1", [])).toBe(0);
		expect(run("2", [])).not.toBe(0);
		expect(run("2", [row])).toBe(0);
		expect(run("3", [row])).not.toBe(0);
		expect(run("3", [{ ...row, context: "ompdesk-rerun/12345/3" }])).not.toBe(0);
		expect(run("2", [row], { SHA: "1123456789abcdef0123456789abcdef01234567" })).not.toBe(0);
		expect(run("2", [row], { DEVICES: "MINI" })).not.toBe(0);
		expect(run("2", [row], { REF_NAME: "main" })).not.toBe(0);
		expect(run("2", [row], { REPO: "SeuPut0705/other" })).not.toBe(0);
		expect(run("2", [{ ...row, description: `${receipt.slice(0, -1)}0` }])).not.toBe(0);
		expect(run("2", [{ ...row, description: "v1.MACBOOK.1.bad" }])).not.toBe(0);
		expect(run("2", [row, { ...row, id: 2, state: "failure" }])).not.toBe(0);
		expect(run("2", [], { DEVICES: "" })).toBe(0);
	});

	it.skipIf(!openssl)(
		"refuses a macOS dispatch started by hand, from an unknown computer, or with another dispatch's ticket",
		() => {
			const denied = { status: 1, macOk: "mac_ok=false" };
			expect(ticketed({ TICKET: "" })).toEqual(denied);
			expect(ticketed({ TICKET: "v1.garbage" })).toEqual(denied);
			expect(ticketed({ SHA: "1123456789abcdef0123456789abcdef01234567" })).toEqual(denied);
			expect(ticketed({ REPO: "SeuPut0705/other" })).toEqual(denied);
			// main needs no MAC_REFS entry, but a ticket for main all the same.
			expect(ticketed({ REF: "refs/heads/main", REF_NAME: "main" })).toEqual(denied);
			// A computer the list does not name, even with a secret of its own, and a listed one without a secret.
			expect(ticketed({ DEVICES: "MINI" })).toEqual(denied);
			const desktop = VECTOR.ticket.replace("v1.MACBOOK.", "v1.DESKTOP.");
			expect(ticketed({ TICKET: desktop, DEVICES: "MACBOOK DESKTOP" })).toEqual(denied);
			// Relabelled as another listed computer: that computer's key does not make its mac.
			const mini = VECTOR.ticket.replace("v1.MACBOOK.", "v1.MINI.");
			expect(
				ticketed({ TICKET: mini }, undefined, { ...SECRETS, CHECKS_ADMISSION_KEY_MINI: "ab".repeat(32) }),
			).toEqual(denied);
			// A later expiry written over a real mac does not extend it, and an expired ticket admits nothing.
			expect(ticketed({ TICKET: VECTOR.ticket.replace(".1800000000000.", ".1900000000000.") })).toEqual(denied);
			expect(ticketed({}, 1_800_000_000)).toEqual(denied);
		},
	);

	/** A `gh` and a `sleep` on PATH that answer the two lookups the step makes and record a cancel; `jq` is the real one. `gh run cancel` fails as it did on a runner with no checkout (run 43445139041): the cancel must go through the API. */
	function dedupe(title: string, runs: { id: number; display_title: string }[], env: Record<string, string> = {}) {
		const dir = fs.mkdtempSync(path.join(scratch, "bin-"));
		const cancelled = path.join(dir, "cancelled");
		fs.writeFileSync(path.join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs }));
		fs.writeFileSync(
			path.join(dir, "gh"),
			[
				"#!/bin/sh",
				'case "$1 $2" in',
				`  "api repos/o/r/actions/runs/7") echo '${title}' ;;`,
				`  "api repos/o/r/actions/workflows/ci.yml/runs?head_sha=abc&event=workflow_dispatch&status=success&per_page=100") cat "${dir}/runs.json" ;;`,
				`  "api --method") echo "$4" | sed 's#.*/runs/\\([0-9]*\\)/cancel#\\1#' >> "${cancelled}" ;;`,
				'  "run cancel") echo "failed to determine base repo: not a git repository" >&2; exit 1 ;;',
				'  *) echo "unexpected gh $*" >&2; exit 9 ;;',
				"esac",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		fs.writeFileSync(path.join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const result = spawnSync("bash", ["-c", step("The same commit and inputs are checked once").run ?? ""], {
			env: {
				PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
				GH_TOKEN: "t",
				GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
				REPO: "o/r",
				RUN_ID: "7",
				SHA: "abc",
				WORKFLOW: "ci.yml",
				...env,
			},
			encoding: "utf8",
		});
		const cancels = fs.existsSync(cancelled) ? fs.readFileSync(cancelled, "utf8").trim().split("\n") : [];
		return { status: result.status, cancels, out: result.stdout };
	}

	it.skipIf(!bash || !jq)("cancels a run whose commit already has a green run of the same name, and only that", () => {
		const mine = "ci [batch mac ]";
		const green = [{ id: 5, display_title: mine }];
		const twin = dedupe(mine, green);
		expect(twin.cancels).toEqual(["7"]);
		expect(twin.out).toContain("https://github.com/o/r/actions/runs/5");
		// Another name, no green run, the run itself, or a name that carries no inputs: nothing to cancel.
		expect(dedupe(mine, [{ id: 5, display_title: "ci [batch ]" }]).cancels).toEqual([]);
		expect(dedupe(mine, []).cancels).toEqual([]);
		expect(dedupe(mine, [{ id: 7, display_title: mine }]).cancels).toEqual([]);
		const unnamed = dedupe("ci", [{ id: 5, display_title: "ci" }]);
		expect(unnamed).toMatchObject({ status: 0, cancels: [] });
	});

	it("runs only for a first attempt of a dispatch that did not ask to be forced, and fails open", () => {
		const dedupeStep = step("The same commit and inputs are checked once");
		expect(dedupeStep.if).toContain("github.event_name == 'workflow_dispatch'");
		expect(dedupeStep.if).toContain("!inputs.force");
		expect(dedupeStep.if).toContain("inputs.dedupe");
		expect(dedupeStep.if).toContain("github.run_attempt == 1");
		expect(dedupeStep["continue-on-error"]).toBe(true);
		expect(gate.jobs.gate?.steps?.find(candidate => candidate.id === "admit")).not.toHaveProperty(
			"continue-on-error",
		);
	});
});
