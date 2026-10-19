import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { exitApp, launchApp } from "./harness";
import { field, realOmpProfile, spentIn } from "./real-omp";

// Explicit opt-in (OMP_GUI_REAL_WORK=1): spends a few turns of two concurrent sessions per run on the user's
// `smol` model in a private disposable profile. Two real stock omp sessions share ONE git checkout (a tiny JS
// project) and are sent two tasks in the same instant (the baseline is /tmp/shared-checkout-measure/RESULTS.md: one
// session's work landed in the other's commit in 3 of 9 runs):
//   V1 "guard": `agentControl: false`. The control tools are off (no `ompdesk_report`, the prompt section says to
//      ask the user), the bridge's `tool_call` guard against shared-index commands still runs.
//   V2 "guard+messages": default prefs, control tools on, so a session can reach its peer with `ompdesk_report`.
// Two scenarios, three runs of each variant:
//   "separate"  the two tasks touch different files (A: src/a.js + a test; B: src/b.js, its callers, README.md).
//   "contended" both tasks add a helper to the SAME files (src/util.js, src/index.js, a test): after the first edit the
//               guard refuses the other's git add/commit of those files, so the two must agree who commits.
// Per run it records, from the sessions' own journals and the repo: the bash commands, the guard's refusals
// ("Refused while other sessions work here…"), the `ompdesk_report` calls, the messages a session received, which commit
// holds which session's files, how a conflict ended, lost changes, leftovers, spend and wall time, into the test's output
// dir and appended (with a `scenario` field) to /tmp/shared-checkout-measure/real-runs.jsonl.
const RUNS_FILE = "/tmp/shared-checkout-measure/real-runs.jsonl";
const RUNS = 3;
const SESSION_DEADLINE_MS = 240_000;
/** Both tabs must stay idle this long before a run counts as finished (a question wakes an idle peer). */
const SETTLE_MS = 20_000;
const REFUSAL = "Refused while other sessions work here";
type Who = "A" | "B";
const WHO: readonly Who[] = ["A", "B"];

const PACKAGE_JSON = `${JSON.stringify({ name: "seed", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`;

interface Scenario {
	name: "separate" | "contended";
	prompts: Record<Who, string>;
	seed: Record<string, string>;
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: "separate",
		prompts: {
			A: "Add input validation to src/a.js and a test for it. Run the tests, then commit your work. Make sure the working tree is clean when you finish.",
			B: "Rename the helper in src/b.js to something clearer and update its callers. Also document it in README.md. Run the tests, then commit your work.",
		},
		seed: {
			"package.json": PACKAGE_JSON,
			"README.md": "# Seed\n\nSmall demo library.\n",
			"src/a.js":
				"export function divide(a, b) {\n  return a / b;\n}\n\nexport function parseAge(s) {\n  return parseInt(s);\n}\n",
			"src/b.js":
				"export function f(items) {\n  return items.map(x => x * 2);\n}\n\nexport function total(items) {\n  return f(items).reduce((sum, x) => sum + x, 0);\n}\n",
			"src/c.js":
				"import { f } from './b.js';\n\nexport function report(items) {\n  return 'Doubled: ' + f(items).join(',');\n}\n",
			"test/b.test.js":
				"import test from 'node:test';\nimport assert from 'node:assert';\nimport { f, total } from '../src/b.js';\nimport { report } from '../src/c.js';\n\ntest('b', () => {\n  assert.deepEqual(f([1, 2]), [2, 4]);\n  assert.equal(total([1, 2]), 6);\n  assert.equal(report([1]), 'Doubled: 2');\n});\n",
		},
	},
	{
		name: "contended",
		prompts: {
			A: "Add a `clamp(n, lo, hi)` helper to src/util.js, export it from src/index.js, add a test, run the tests, then commit your work.",
			B: "Add a `sum(items)` helper to src/util.js, export it from src/index.js, add a test, run the tests, then commit your work.",
		},
		seed: {
			"package.json": PACKAGE_JSON,
			"src/util.js": "export function double(n) {\n  return n * 2;\n}\n",
			"src/index.js": "export { double } from './util.js';\n",
			"test/util.test.js":
				"import test from 'node:test';\nimport assert from 'node:assert';\nimport { double } from '../src/index.js';\n\ntest('double', () => {\n  assert.equal(double(2), 4);\n});\n",
		},
	},
];

/** Seed files of the "separate" scenario and who owns them; a file the sessions add is owned by whoever it imports (see `ownerOf`). */
const SEED_OWNER: Record<string, Who | "shared"> = {
	"package.json": "shared",
	"src/a.js": "A",
	"src/b.js": "B",
	"src/c.js": "B",
	"test/b.test.js": "B",
	"README.md": "B",
};

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result: string;
	isError: boolean;
}

/** An OMPdesk control call: a direct `ompdesk_*` tool, or a `write` to the `xd://ompdesk_*` device (how stock reaches host tools). */
function controlOf(call: ToolCall): { tool: string; args: Record<string, unknown> } | undefined {
	if (call.name.startsWith("ompdesk_")) return { tool: call.name, args: call.arguments };
	const target = call.arguments.path;
	if (call.name !== "write" || typeof target !== "string" || !target.startsWith("xd://ompdesk_")) return undefined;
	try {
		const args = JSON.parse(String(call.arguments.content ?? "{}")) as Record<string, unknown>;
		return { tool: target.slice("xd://".length), args };
	} catch {
		return { tool: target.slice("xd://".length), args: {} };
	}
}

interface SessionRecord {
	file: string;
	commands: string[];
	toolNames: Record<string, number>;
	refusals: number;
	refusedCommands: string[];
	reports: { to: unknown; kind: unknown; text: unknown; result: string }[];
	/** Other OMPdesk control calls (`ompdesk_session_send`, …). */
	controls: { tool: string; args: Record<string, unknown>; result: string }[];
	/** What the session asked the user (stock's `ask` tool). */
	askedUser: string[];
	/** Messages another session sent this one (`ompdesk.mail` entries and `<ompdesk-agent-message …>` user turns). */
	inbox: string[];
	editedFiles: string[];
	commitShas: string[];
	commitMessages: string[];
	commitOutcomes: string[];
	finalText: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (typeof field(block, "text") === "string" ? (field(block, "text") as string) : ""))
		.join("");
}

/** The session files of the private agent dir, keyed by which prompt opened them. */
async function readSessions(
	agent: string,
	prompts: Record<Who, string>,
): Promise<Record<Who, SessionRecord | undefined>> {
	const root = path.join(agent, "sessions");
	const found: Partial<Record<Who, SessionRecord>> = {};
	const files = await fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
	for (const rel of files) {
		const base = path.basename(rel);
		if (!rel.endsWith(".jsonl") || base.startsWith("__")) continue;
		const lines = (await fs.readFile(path.join(root, rel), "utf8")).split("\n").filter(Boolean);
		const entries = lines.map(line => JSON.parse(line) as unknown);
		const messages = entries
			.filter(entry => field(entry, "type") === "message")
			.map(entry => field(entry, "message"));
		const first = messages.find(message => field(message, "role") === "user");
		const opening = textOf(field(first, "content"));
		const who = WHO.find(w => opening.includes(prompts[w]));
		if (!who || found[who]) continue;
		const calls = new Map<string, ToolCall>();
		const inbox: string[] = [];
		for (const entry of entries)
			if (field(entry, "type") === "custom_message" && field(entry, "customType") === "ompdesk.mail")
				inbox.push(String(field(entry, "content")).slice(0, 600));
		let finalText = "";
		for (const message of messages) {
			const role = field(message, "role");
			const content = field(message, "content");
			if (role === "user" && message !== first) {
				const text = textOf(content);
				if (text.includes("ompdesk-agent-message")) inbox.push(text.slice(0, 600));
			}
			if (role === "assistant" && Array.isArray(content)) {
				const text = textOf(content);
				if (text) finalText = text;
				for (const block of content) {
					if (field(block, "type") !== "toolCall") continue;
					const id = String(field(block, "id"));
					calls.set(id, {
						id,
						name: String(field(block, "name")),
						arguments: (field(block, "arguments") as Record<string, unknown>) ?? {},
						result: "",
						isError: false,
					});
				}
			} else if (role === "toolResult") {
				const call = calls.get(String(field(message, "toolCallId")));
				if (call) {
					call.result = textOf(content);
					call.isError = field(message, "isError") === true;
				}
			}
		}
		const record: SessionRecord = {
			file: rel,
			commands: [],
			toolNames: {},
			refusals: 0,
			refusedCommands: [],
			reports: [],
			controls: [],
			askedUser: [],
			inbox,
			editedFiles: [],
			commitShas: [],
			commitMessages: [],
			commitOutcomes: [],
			finalText,
		};
		for (const call of calls.values()) {
			record.toolNames[call.name] = (record.toolNames[call.name] ?? 0) + 1;
			const refused = call.result.startsWith(REFUSAL);
			if (refused) {
				record.refusals++;
				record.refusedCommands.push(
					typeof call.arguments.command === "string"
						? call.arguments.command
						: `${call.name} ${JSON.stringify(call.arguments)}`,
				);
			}
			if (call.name === "bash" && typeof call.arguments.command === "string") {
				const command = call.arguments.command;
				record.commands.push(refused ? `${command}   ⟵ REFUSED` : command);
				if (/\bgit\b[^|;&\n]*\bcommit\b/.test(command)) {
					record.commitOutcomes.push(
						`${refused ? "refused" : call.isError ? "error" : "ok"}: ${call.result.slice(0, 160).replace(/\s+/g, " ")}`,
					);
					if (!refused)
						for (const m of command.matchAll(/\s-[a-zA-Z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g))
							record.commitMessages.push(m[1] ?? m[2]);
				}
				for (const sha of call.result.matchAll(/\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/g))
					record.commitShas.push(sha[1]);
			} else if (controlOf(call)) {
				const control = controlOf(call);
				if (control?.tool === "ompdesk_report")
					record.reports.push({
						to: control.args.to,
						kind: control.args.kind,
						text: control.args.text,
						result: call.result.slice(0, 300),
					});
				else if (control)
					record.controls.push({ tool: control.tool, args: control.args, result: call.result.slice(0, 300) });
			} else if (call.name === "ask") {
				record.askedUser.push(JSON.stringify(call.arguments).slice(0, 400));
			} else if (call.name === "edit" || call.name === "write") {
				const direct = call.arguments.path;
				if (typeof direct === "string") record.editedFiles.push(direct);
				const input = call.arguments.input;
				if (typeof input === "string")
					for (const m of input.matchAll(/^\[([^\]#\n]+)#/gm)) record.editedFiles.push(m[1]);
			}
		}
		found[who] = record;
	}
	return { A: found.A, B: found.B };
}

async function ownerOf(project: string, file: string): Promise<Who | "shared" | "?"> {
	const known = SEED_OWNER[file];
	if (known) return known;
	if (/(^|\/)a[._-]|(^|\/)a\//.test(file)) return "A";
	if (/(^|\/)(b|c)[._-]|(^|\/)(b|c)\//.test(file)) return "B";
	const body = await fs.readFile(path.join(project, file), "utf8").catch(() => "");
	const a = /\ba\.js\b|src\/a\b/.test(body);
	const b = /\b[bc]\.js\b|src\/[bc]\b/.test(body);
	if (a && !b) return "A";
	if (b && !a) return "B";
	return "?";
}

async function tabStates(page: Page, ids: string[]): Promise<boolean[]> {
	return Promise.all(
		ids.map(async id => {
			const tab = (await page.evaluate(() => window.omp.tabs.list()).catch(() => [])).find(t => t.tabId === id);
			if (tab?.status === "running") return true;
			const state = await page
				.evaluate(tabId => window.omp.rpc.commandForTab(tabId, { type: "get_state" }), id)
				.catch(() => undefined);
			return field(state?.data, "isStreaming") === true;
		}),
	);
}

interface Commit {
	sha: string;
	subject: string;
	files: string[];
	by: Who | "?";
	owners: Record<string, string[]>;
}

interface Analysis {
	commits: Commit[];
	wrongSessionCommits: unknown[];
	lostChanges: string[];
	/** Per session: the files it should have committed, those it did, and whether all of the first are in the second. */
	sessionExtras: Record<Who, Record<string, unknown>>;
	extra: Record<string, unknown>;
}

interface Facts {
	project: string;
	seedSha: string;
	commits: Commit[];
	sessions: Record<Who, SessionRecord | undefined>;
	status: string;
	read: (file: string) => Promise<string>;
}

/** `git show` of a path at HEAD, empty when it is not there. */
function atHead(project: string, file: string): string {
	try {
		return git(project, "show", `HEAD:${file}`);
	} catch {
		return "";
	}
}

/** "separate": who owns which file, whose commit holds what, and whether each task's end state is in the tree. */
async function analyseSeparate(seed: Record<string, string>, facts: Facts): Promise<Analysis> {
	const { project, seedSha, status, read } = facts;
	const commits: Commit[] = [];
	for (const commit of facts.commits) {
		const owners: Record<string, string[]> = {};
		for (const file of commit.files) {
			const owner = await ownerOf(project, file);
			owners[owner] = [...(owners[owner] ?? []), file];
		}
		commits.push({ ...commit, owners });
	}
	const wrongSessionCommits = commits.filter(commit => {
		const other = commit.by === "A" ? "B" : commit.by === "B" ? "A" : undefined;
		if (other) return (commit.owners[other] ?? []).length > 0;
		return (commit.owners.A ?? []).length > 0 && (commit.owners.B ?? []).length > 0;
	});
	const changed = new Set<string>([
		...git(project, "diff", "--name-only", seedSha).split("\n"),
		...status
			.split("\n")
			.filter(Boolean)
			.map(line => line.slice(3).replace(/ -> .*/, "")),
	]);
	changed.delete("");
	const intended: Record<Who, string[]> = { A: [], B: [] };
	for (const file of changed) {
		const owner = await ownerOf(project, file);
		if (owner === "A" || owner === "B") intended[owner].push(file);
	}
	const sessionExtras = { A: {}, B: {} } as Analysis["sessionExtras"];
	for (const who of WHO) {
		const own = commits.filter(commit => commit.by === who).flatMap(commit => commit.files);
		sessionExtras[who] = {
			intendedFiles: intended[who],
			committedFiles: own,
			intendedInOwnCommit: intended[who].length > 0 && intended[who].every(file => own.includes(file)),
		};
	}
	// Lost changes: intended end state (validation + test for A; the helper renamed in b.js, c.js and the test, and a README
	// entry for B) against what the tree holds now.
	const lost: string[] = [];
	const a = await read("src/a.js");
	if (a === seed["src/a.js"]) lost.push("A: src/a.js unchanged (validation missing)");
	else if (!/throw|typeof|isNaN|isFinite|isInteger|TypeError|RangeError|Error\(/.test(a))
		lost.push("A: src/a.js has no validation");
	if (!intended.A.some(file => /test/.test(file))) lost.push("A: no test file for src/a.js");
	const b = await read("src/b.js");
	if (b === seed["src/b.js"]) lost.push("B: src/b.js unchanged (no rename)");
	else if (/function f\b|\bf\s*[,}]/.test(b)) lost.push("B: helper `f` still in src/b.js");
	if (/import \{[^}]*\bf\b[^}]*\} from/.test(await read("src/c.js"))) lost.push("B: src/c.js still imports `f`");
	if (/import \{[^}]*\bf\b[^}]*\} from/.test(await read("test/b.test.js")))
		lost.push("B: test/b.test.js still imports `f`");
	if ((await read("README.md")) === seed["README.md"]) lost.push("B: README.md unchanged");
	return { commits, wrongSessionCommits, lostChanges: lost, sessionExtras, extra: {} };
}

/** The helper names (`clamp`, `sum`) a diff adds. */
function helpersAdded(diff: string): string[] {
	const added = diff
		.split("\n")
		.filter(line => line.startsWith("+") && !line.startsWith("+++"))
		.join("\n");
	return ["clamp", "sum"].filter(name => new RegExp(`\\b${name}\\b`).test(added));
}

/** "contended": are both helpers, both exports and both tests in HEAD and in the tree, and how did the two sessions split the commits. */
async function analyseContended(facts: Facts): Promise<Analysis> {
	const { project, read } = facts;
	const treeFiles = git(project, "ls-tree", "-r", "--name-only", "HEAD")
		.split("\n")
		.filter(file => file.startsWith("test/"));
	const headTests = treeFiles.map(file => atHead(project, file)).join("\n");
	let treeTests = "";
	for (const file of await fs.readdir(path.join(project, "test")).catch(() => [] as string[]))
		treeTests += `${await read(`test/${file}`)}\n`;
	const present = async (where: "head" | "tree") => {
		const util = where === "head" ? atHead(project, "src/util.js") : await read("src/util.js");
		const index = where === "head" ? atHead(project, "src/index.js") : await read("src/index.js");
		const tests = where === "head" ? headTests : treeTests;
		return {
			utilClamp: /function clamp\b|\bclamp\s*=/.test(util),
			utilSum: /function sum\b|\bsum\s*=/.test(util),
			indexClamp: /\bclamp\b/.test(index),
			indexSum: /\bsum\b/.test(index),
			testClamp: /\bclamp\b/.test(tests),
			testSum: /\bsum\b/.test(tests),
		};
	};
	const head = await present("head");
	const tree = await present("tree");
	const lost = Object.entries(tree)
		.filter(([, ok]) => !ok)
		.map(([key]) => `missing from the tree: ${key}`);
	const notCommitted = Object.entries(tree)
		.filter(([key, ok]) => ok && !head[key as keyof typeof head])
		.map(([key]) => key);
	const commits = facts.commits.map(commit => ({
		...commit,
		helpersInUtil: commit.files.includes("src/util.js")
			? helpersAdded(git(project, "show", "--format=", "-p", commit.sha, "--", "src/util.js"))
			: [],
	}));
	const utilCommits = commits.filter(commit => commit.helpersInUtil.length > 0);
	let ending: string;
	if (lost.length > 0) ending = "a change is missing from the tree";
	else if (notCommitted.length > 0) ending = "left uncommitted";
	else if (utilCommits.some(commit => commit.helpersInUtil.length === 2))
		ending = `one session (${utilCommits.find(commit => commit.helpersInUtil.length === 2)?.by}) committed both helpers`;
	else if (new Set(utilCommits.flatMap(commit => commit.helpersInUtil)).size === 2)
		ending = "each committed its own hunk";
	else ending = "no commit of src/util.js";
	const sessionExtras = { A: {}, B: {} } as Analysis["sessionExtras"];
	for (const who of WHO)
		sessionExtras[who] = {
			committedFiles: commits.filter(commit => commit.by === who).flatMap(commit => commit.files),
			reapplied: (facts.sessions[who]?.commands ?? []).filter(command =>
				/(>>?|tee|sed -i[^|;&\n]*)\s*['"]?src\/(util|index)\.js/.test(command),
			).length,
			undoCommands: (facts.sessions[who]?.commands ?? []).filter(command =>
				/\bgit\b[^|;&\n]*\b(checkout|restore|reset|revert|stash|clean|apply|add\s+-p|add\s+-i)\b/.test(command),
			),
		};
	return {
		commits,
		wrongSessionCommits: [],
		lostChanges: lost,
		sessionExtras,
		extra: { ending, bothInHead: Object.values(head).every(Boolean), inHead: head, inTree: tree, notCommitted },
	};
}

const VARIANTS = [
	{ name: "V1-guard-only", prefs: { agentControl: false } },
	{ name: "V2-guard+messages", prefs: {} },
] as const;

for (const scenario of SCENARIOS) {
	for (const variant of VARIANTS) {
		for (let run = 1; run <= RUNS; run++) {
			test(`${scenario.name}: ${variant.name} run ${run}`, async () => {
				test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
				test.setTimeout(720_000);
				const real = await realOmpProfile({ launchProfiles: {}, ...variant.prefs });
				// Under the home dir, not the temp dir: macOS reaches the temp dir through a symlink (/var → /private/var), and
				// the guard compares a session's cwd with the repository's resolved top level, so there it would never fire.
				const project = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), ".ompdesk-shared-checkout-")));
				git(project, "init", "--quiet");
				for (const [file, body] of Object.entries(scenario.seed)) {
					await fs.mkdir(path.dirname(path.join(project, file)), { recursive: true });
					await fs.writeFile(path.join(project, file), body);
				}
				git(project, "symbolic-ref", "HEAD", "refs/heads/main");
				git(project, "config", "user.name", "tester");
				git(project, "config", "user.email", "tester@example.com");
				git(project, "add", "-A");
				git(project, "commit", "-q", "-m", "initial");
				const seedSha = git(project, "rev-parse", "HEAD").trim();

				const app = await launchApp({
					project,
					desktop: real.desktop,
					agent: real.agent,
					profile: real.profile,
					env: { ...real.env, OMP_GUI_OMP: undefined },
				});
				let record: Record<string, unknown> = { scenario: scenario.name, variant: variant.name, run };
				try {
					const page = await app.firstWindow();
					await expect
						.poll(() => page.evaluate(() => window.omp?.sidecar.getStatus()), { timeout: 120_000 })
						.toMatchObject({ status: "ready" });
					const first = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
					if (!first) throw new Error("no active tab");
					const spawned = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
					if (!spawned?.tabId) throw new Error("the second tab was refused");
					const ids: Record<Who, string> = { A: first, B: spawned.tabId };
					for (const id of Object.values(ids))
						await expect
							.poll(
								async () =>
									(await page.evaluate(() => window.omp.tabs.list())).find(t => t.tabId === id)?.status,
								{ timeout: 120_000 },
							)
							.toBe("ready");

					const started = Date.now();
					const sentAt: Record<string, number> = {};
					await Promise.all(
						WHO.map(async who => {
							sentAt[who] = Date.now() - started;
							const answer = await page.evaluate(
								([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }),
								[ids[who], scenario.prompts[who]] as const,
							);
							if (answer.success === false)
								throw new Error(`prompt to ${who} failed: ${JSON.stringify(answer)}`);
						}),
					);

					// Done = both tabs ran, then stayed idle for SETTLE_MS (a question wakes an idle peer).
					const order = Object.values(ids);
					const seenBusy = [false, false];
					let idleSince: number | undefined;
					let timedOut = false;
					const firstIdle: Record<string, number> = {};
					while (true) {
						const busy = await tabStates(page, order);
						busy.forEach((b, i) => {
							if (b) seenBusy[i] = true;
							else if (seenBusy[i] && firstIdle[order[i]] === undefined)
								firstIdle[order[i]] = Date.now() - started;
							if (b) delete firstIdle[order[i]];
						});
						const allIdle = seenBusy.every(Boolean) && busy.every(b => !b);
						if (allIdle) {
							idleSince ??= Date.now();
							if (Date.now() - idleSince >= SETTLE_MS) break;
						} else idleSince = undefined;
						if (Date.now() - started > SESSION_DEADLINE_MS) {
							timedOut = true;
							for (const id of order)
								await page
									.evaluate(tabId => window.omp.rpc.commandForTab(tabId, { type: "abort" }), id)
									.catch(() => undefined);
							await page.waitForTimeout(3000);
							break;
						}
						await page.waitForTimeout(2000);
					}
					const wallMs = (idleSince ?? Date.now()) - started;

					const sessions = await readSessions(real.agent, scenario.prompts);
					const spend = await spentIn(real.agent);

					// The repo: commits since the seed, with their files and who made them (the `[main sha]` lines of the
					// sessions' own results, else the commit message they passed).
					const log = git(
						project,
						"log",
						"--reverse",
						"--format=%x01%H%x09%h%x09%s",
						"--name-only",
						`${seedSha}..HEAD`,
					);
					const commits: Commit[] = [];
					for (const chunk of log.split("\x01").filter(Boolean)) {
						const [head, ...rest] = chunk.split("\n");
						const [sha, short, ...subject] = head.split("\t");
						const title = subject.join("\t");
						const by =
							WHO.find(w => sessions[w]?.commitShas.some(s => sha.startsWith(s) || short.startsWith(s))) ??
							WHO.find(w =>
								sessions[w]?.commitMessages.some(message => message.split("\n")[0].trim() === title),
							) ??
							"?";
						commits.push({ sha: short, subject: title, files: rest.filter(Boolean), by, owners: {} });
					}
					const status = git(project, "status", "--porcelain");
					const stashList = git(project, "stash", "list").trim();
					const read = (file: string) => fs.readFile(path.join(project, file), "utf8").catch(() => "");
					const facts: Facts = { project, seedSha, commits, sessions, status, read };
					const analysis =
						scenario.name === "separate"
							? await analyseSeparate(scenario.seed, facts)
							: await analyseContended(facts);
					let suite = "pass";
					try {
						execFileSync("node", ["--test"], { cwd: project, stdio: "pipe", timeout: 60_000 });
					} catch (error) {
						suite = `fail: ${String(field(error, "stdout") ?? "").slice(-400)}`;
						analysis.lostChanges.push("the suite fails on the final tree");
					}

					// Whether a question was answered: the peer sent a report back to the asker.
					const questions = WHO.flatMap(from =>
						(sessions[from]?.reports ?? []).map(report => {
							const peer: Who = from === "A" ? "B" : "A";
							const back = [...(sessions[peer]?.reports ?? []), ...(sessions[peer]?.controls ?? [])];
							return {
								from,
								to: report.to,
								kind: report.kind,
								text: report.text,
								peerReceived: (sessions[peer]?.inbox.length ?? 0) > 0,
								peerAnswered: back.some(
									reply =>
										field(reply, "to") === ids[from] || field(field(reply, "args"), "session") === ids[from],
								),
							};
						}),
					);

					record = {
						scenario: scenario.name,
						variant: variant.name,
						run,
						timedOut,
						wallMs,
						sentAtMs: sentAt,
						firstIdleMs: Object.fromEntries(WHO.map(w => [w, firstIdle[ids[w]]])),
						costUsd: Number(spend.usd.toFixed(4)),
						tokens: spend.tokens,
						tabIds: ids,
						sessions: Object.fromEntries(
							WHO.map(w => [w, sessions[w] ? { ...sessions[w], ...analysis.sessionExtras[w] } : null]),
						),
						commits: analysis.commits,
						wrongSessionCommits: analysis.wrongSessionCommits,
						lostChanges: analysis.lostChanges,
						suite,
						leftovers: status.split("\n").filter(Boolean),
						stashList,
						questions,
						...analysis.extra,
						gitStat: git(project, "log", "--stat", "--format=--- %h %s"),
					};
				} finally {
					await fs
						.cp(path.join(real.agent, "sessions"), test.info().outputPath("sessions"), { recursive: true })
						.catch(() => undefined);
					await fs
						.cp(path.join(real.profile, "logs"), test.info().outputPath("logs"), { recursive: true })
						.catch(() => undefined);
					await fs
						.writeFile(test.info().outputPath("run.json"), JSON.stringify(record, null, 2))
						.catch(() => undefined);
					await fs.appendFile(RUNS_FILE, `${JSON.stringify(record)}\n`).catch(() => undefined);
					await exitApp(app).catch(() => undefined);
					await fs.rm(real.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
					await fs.rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
				}
				expect(record.sessions).toBeDefined();
			});
		}
	}
}
