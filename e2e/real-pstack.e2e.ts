import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron, type Page } from "playwright";
import { exitApp } from "./harness";
import { field, realOmpProfile, spentIn } from "./real-omp";

// Explicit opt-in (OMP_GUI_REAL_WORK=1): a few turns on the user's `smol` model in a private disposable profile, real
// stock omp with the built-in pstack pack (on by default). What it measures, with the spend of each case recorded:
//  1. A bug-fix prompt follows the bug-fix playbook: the agent reads `playbooks/bug-fix.md` and its `todo` list is the
//     playbook's steps copied in, then the bug is fixed (the repo's check passes).
//  2. A trivial greeting gets a plain answer: no `todo`, no `skill://` read (the routing gate).
//  3. The same bug prompt with the switch off (pref `pstack`): no playbook read, the control for case 1.
const RESULT_FILE = "/tmp/real-pstack.json";
const PLAYBOOK = path.resolve(
	import.meta.dirname,
	"../resources/omp-builtin/pstack/skills/poteto-mode/playbooks/bug-fix.md",
);
const results: Record<string, unknown>[] = [];

test.afterAll(async () => {
	if (results.length > 0) await fs.writeFile(RESULT_FILE, JSON.stringify(results, null, 2));
});

interface Call {
	name: string;
	text: string;
}

/** Every tool call the profile's journals hold, in order, with its arguments as one string. */
async function toolCalls(agent: string): Promise<Call[]> {
	const calls: Call[] = [];
	const root = path.join(agent, "sessions");
	for (const file of (await fs.readdir(root, { recursive: true }).catch(() => [])).sort()) {
		if (!file.endsWith(".jsonl")) continue;
		for (const line of (await fs.readFile(path.join(root, file), "utf8")).split("\n")) {
			if (!line.includes('"toolCall"')) continue;
			const content = field(field(JSON.parse(line), "message"), "content");
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (field(block, "type") !== "toolCall") continue;
				const name = field(block, "name");
				if (typeof name === "string") calls.push({ name, text: JSON.stringify(field(block, "arguments") ?? {}) });
			}
		}
	}
	return calls;
}

/** The first five words of each numbered step of the bug-fix playbook, lower-cased: what a copied todo item starts with. */
async function playbookStarts(): Promise<string[]> {
	const text = await fs.readFile(PLAYBOOK, "utf8");
	return [...text.matchAll(/^\d+\. (.+)$/gm)].map(match =>
		match[1]
			.replace(/[^\p{L}\p{N} ]/gu, "")
			.toLowerCase()
			.split(/\s+/)
			.slice(0, 4)
			.join(" "),
	);
}

function normalized(text: string): string {
	return text.replace(/[^\p{L}\p{N} ]/gu, "").toLowerCase();
}

async function launch(prompt: string, prefs: Record<string, unknown> = {}) {
	const real = await realOmpProfile({ launchProfiles: {}, ...prefs });
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: real.project });
	execFileSync("git", ["config", "user.name", "t"], { cwd: real.project });
	await fs.writeFile(path.join(real.project, "sum.js"), "exports.sum = (list) => list.reduce((a, b) => a + b, 1);\n");
	await fs.writeFile(
		path.join(real.project, "test.js"),
		'const assert = require("node:assert");\nconst { sum } = require("./sum");\nassert.strictEqual(sum([1, 2, 3]), 6);\nconsole.log("ok");\n',
	);
	execFileSync("git", ["add", "."], { cwd: real.project });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: real.project });
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			real.project,
			`--user-data-dir=${real.desktop}`,
		],
		env: { ...real.env, OMP_GUI_HEADLESS: "1" },
	});
	const page = await app.firstWindow();
	await expect
		.poll(() => page.evaluate(() => window.omp?.sidecar.getStatus()), { timeout: 120_000 })
		.toMatchObject({ status: "ready" });
	const main = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const composer = page.locator("textarea").first();
	await composer.fill(prompt);
	await composer.press("Enter");
	return { real, app, page, main };
}

async function untilTurnEnds(page: Page, tab: string): Promise<void> {
	await expect
		.poll(
			async () => {
				const state = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), tab);
				return field(state.data, "isStreaming") === false && (await lastAnswer(page, tab)).length > 0;
			},
			{ timeout: 420_000, intervals: [2_000] },
		)
		.toBe(true);
}

async function lastAnswer(page: Page, tab: string): Promise<string> {
	const response = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "get_last_assistant_text" }),
		tab,
	);
	const text = field(response.data, "text");
	return typeof text === "string" ? text : "";
}

const BUG_PROMPT = "node test.js fails. Find the bug and fix it.";

async function bugCase(name: string, prefs: Record<string, unknown>) {
	const { real, app, page, main } = await launch(BUG_PROMPT, prefs);
	try {
		await untilTurnEnds(page, main);
		const calls = await toolCalls(real.agent);
		const reads = calls.filter(call => call.name === "read" && call.text.includes("playbooks/bug-fix.md"));
		const todos = calls.filter(call => call.name === "todo");
		const starts = await playbookStarts();
		const firstTodo = normalized(todos[0]?.text ?? "");
		const copied = starts.filter(start => start.length > 0 && firstTodo.includes(start));
		let checkPasses = true;
		try {
			execFileSync("node", ["test.js"], { cwd: real.project, stdio: "ignore" });
		} catch {
			checkPasses = false;
		}
		const cost = await spentIn(real.agent);
		results.push({
			case: name,
			playbookRead: reads.length > 0,
			todoCalls: todos.length,
			playbookStepsCopied: `${copied.length}/${starts.length}`,
			checkPasses,
			toolCalls: calls.map(call => `${call.name} ${call.text.slice(0, 120)}`),
			cost,
			summary: await lastAnswer(page, main),
		});
		console.log(
			`[real-pstack] ${name}: playbook read ${reads.length > 0}, ${copied.length}/${starts.length} steps in the first todo, check ${checkPasses}, $${cost.usd.toFixed(4)}, ${cost.tokens} tokens`,
		);
		return { reads, todos, copied, checkPasses };
	} finally {
		await exitApp(app);
		await fs.rm(real.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

test("a bug-fix prompt follows the bug-fix playbook: it is read and its steps are the todo items", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(900_000);
	// The model decides whether to follow the playbook (a small model skips it on a one-line bug now and then), so the
	// case runs three times, every run's outcome is recorded, and one full follow is the pass (measured 3 of 5 on the
	// first single runs of the final wording; each attempt also has to leave the repo's check green).
	const attempts = [];
	for (let attempt = 1; attempt <= 3; attempt++) {
		const outcome = await bugCase(`bug fix, pstack on, attempt ${attempt}`, {});
		expect(outcome.checkPasses).toBe(true);
		attempts.push(outcome.reads.length > 0 && outcome.todos.length > 0 && outcome.copied.length >= 2);
	}
	const followed = attempts.filter(Boolean).length;
	console.log(`[real-pstack] bug fix followed the playbook in ${followed} of ${attempts.length} runs`);
	results.push({ case: "bug fix follow rate", followed, attempts: attempts.length });
	expect(followed).toBeGreaterThanOrEqual(1);
});

test("a greeting gets a plain answer: no todo, no skill read", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(300_000);
	const { real, app, page, main } = await launch("안녕");
	try {
		await untilTurnEnds(page, main);
		const calls = await toolCalls(real.agent);
		const cost = await spentIn(real.agent);
		results.push({ case: "greeting, pstack on", toolCalls: calls.map(call => call.name), cost });
		console.log(`[real-pstack] greeting: ${calls.length} tool calls, $${cost.usd.toFixed(4)}, ${cost.tokens} tokens`);
		expect(calls.filter(call => call.name === "todo")).toHaveLength(0);
		expect(calls.filter(call => call.text.includes("skill://"))).toHaveLength(0);
	} finally {
		await exitApp(app);
		await fs.rm(real.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("control: the same bug prompt with the switch off never reads the playbook", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(600_000);
	const outcome = await bugCase("bug fix, pstack off", { pstack: false });
	expect(outcome.reads).toHaveLength(0);
});
