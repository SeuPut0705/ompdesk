import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// Opt-in audit of the work card through whole flows on the fake omp's `fixture flow` run:
// steers and queue changes, stop and resume, plan approval, a question, a mid-run compaction,
// a tab switch, four live cards in a 2×2 split, a relaunch mid-run and a remote tab.
// OMP_GUI_CARD_FLOWS=<dir> enables it and receives captures plus per-flow card probes.
const OUT = process.env.OMP_GUI_CARD_FLOWS ?? "";
test.skip(!OUT, "OMP_GUI_CARD_FLOWS=<dir> runs the work card flow audit");
test.describe.configure({ mode: "parallel" });

interface Launched {
	app: ElectronApplication;
	page: Page;
	errors: string[];
}

async function launch(root: string, extraEnv: Record<string, string> = {}): Promise<Launched> {
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([
		fs.mkdir(project, { recursive: true }),
		fs.mkdir(desktop, { recursive: true }),
		fs.mkdir(agent, { recursive: true }),
	]);
	// A relaunch keeps the profile it ran on.
	await fs
		.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }), {
			flag: "wx",
		})
		.catch(() => undefined);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		...extraEnv,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	await installProbe(page);
	return { app, page, errors };
}

/**
 * Every frame: each top-level card's state, head narrative, sub line, summary, head height and
 * narrative visibility; a change is one transition. Clocks are sampled once a second. Frame gaps
 * over 50 ms and long animation frames are kept with their times.
 */
async function installProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		const probe = {
			frames: 0,
			gaps: [] as { at: number; gap: number }[],
			longFrames: [] as { at: number; duration: number; blocking: number }[],
			transitions: [] as { at: number; card: number; pane: string; sig: string }[],
			clocks: [] as { at: number; card: number; clock: string }[],
			minNarrative: {} as Record<number, number>,
			mounts: 0,
		};
		Reflect.set(window, "__cardProbe", probe);
		new PerformanceObserver(list => {
			for (const entry of list.getEntries()) {
				const frame = entry as PerformanceEntry & { blockingDuration?: number };
				probe.longFrames.push({
					at: Math.round(frame.startTime),
					duration: Math.round(frame.duration),
					blocking: Math.round(frame.blockingDuration ?? 0),
				});
			}
		}).observe({ type: "long-animation-frame" });
		const ids = new WeakMap<Element, number>();
		const signatures = new Map<number, string>();
		let last = performance.now();
		let lastClock = 0;
		const text = (root: Element, selector: string) => root.querySelector(selector)?.textContent?.trim() ?? "";
		const tick = (now: number) => {
			const gap = now - last;
			last = now;
			probe.frames++;
			if (gap > 50) probe.gaps.push({ at: Math.round(now), gap: Math.round(gap) });
			const sampleClock = now - lastClock > 1000;
			if (sampleClock) lastClock = now;
			for (const group of document.querySelectorAll<HTMLElement>(".omp-execution-group")) {
				const card = group.querySelector<HTMLElement>(":scope > .omp-live-step");
				if (!card) continue;
				let id = ids.get(card);
				if (id === undefined) {
					id = ++probe.mounts;
					ids.set(card, id);
				}
				const pane = group.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId ?? "";
				const head = card.querySelector<HTMLElement>(":scope > .omp-work-head");
				const opacity = (selector: string) => {
					const layer = head?.querySelector<HTMLElement>(`.omp-work-frame${selector}`);
					return layer ? Number(getComputedStyle(layer).opacity) : 1;
				};
				const incoming = opacity("[data-incoming]");
				const visible = incoming + opacity("[data-outgoing]") * (1 - incoming);
				probe.minNarrative[id] = Math.min(probe.minNarrative[id] ?? 1, visible);
				const narrative = head
					? text(head, "[data-incoming] .omp-work-narrative") || text(head, ".omp-work-narrative")
					: "";
				const sig = [
					group.dataset.state,
					narrative,
					head ? text(head, ".omp-work-sub") : "",
					card.querySelector(".omp-execution-group-header")?.getAttribute("aria-label") ?? "",
					`h${head?.offsetHeight ?? 0}`,
					text(card, ".omp-work-catch-up"),
					`lanes:${[...card.querySelectorAll(".omp-work-card-button")].map(lane => lane.textContent?.trim()).join(" | ")}`,
				].join(" ¦ ");
				if (signatures.get(id) !== sig) {
					signatures.set(id, sig);
					probe.transitions.push({ at: Math.round(now), card: id, pane, sig });
				}
				if (sampleClock) {
					const clock = head ? text(head, ".omp-work-head-clock") : "";
					if (clock) probe.clocks.push({ at: Math.round(now), card: id, clock });
				}
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

async function saveProbe(page: Page, name: string): Promise<void> {
	const probe = await page.evaluate(() => Reflect.get(window, "__cardProbe"));
	await fs.writeFile(path.join(OUT, `${name}-probe.json`), JSON.stringify(probe, null, 1));
}

async function capture(page: Page, name: string): Promise<void> {
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(OUT, `${name}.png`), scale: "css", animations: "disabled" });
}

async function activeTab(page: Page): Promise<string> {
	const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active)?.tabId;
	if (!tab) throw new Error("No active tab");
	return tab;
}

function driver(page: Page, tab: string) {
	const bash = (command: string) =>
		page.evaluate(([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }), [
			tab,
			command,
		] as const);
	return {
		bash,
		op: async (spec: Record<string, unknown>) => {
			const response = await bash(`fixture:flow:${JSON.stringify(spec)}`);
			if (!response.success) throw new Error(`flow op ${JSON.stringify(spec)}: ${response.error}`);
		},
		prompt: (message: string) =>
			page.evaluate(([id, text]) => window.omp.rpc.commandForTab(id, { type: "prompt", message: text }), [
				tab,
				message,
			] as const),
	};
}

const cards = (page: Page) => page.locator(".omp-execution-group");
const head = (page: Page, index = -1) =>
	cards(page).nth(index).locator(":scope > .omp-live-step > .omp-work-head [data-incoming] > .omp-work-narrative");

async function startFlow(page: Page, count = 1) {
	const input = page.locator("textarea").first();
	await input.fill("fixture flow");
	await input.press("Enter");
	await expect(cards(page)).toHaveCount(count, { timeout: 15_000 });
}

/** Focus a tab the way a person does: its sidebar row. */
async function focusTab(page: Page, tabId: string) {
	const row = page.locator(`[data-session-path="tab:${tabId}"] button[data-roving-item]`);
	await ((await row.count())
		? row.first()
		: page.locator("[data-device-session] button[data-roving-item]").first()
	).click();
	await expect.poll(async () => await activeTab(page)).toBe(tabId);
}

async function profileDir(name: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), `ompdesk-card-${name}-`));
}

test.beforeAll(async () => {
	if (OUT) await fs.mkdir(OUT, { recursive: true });
});

test("steers, a removed steer and a follow-up during a long multi-agent run", async () => {
	test.setTimeout(240_000);
	const root = await profileDir("steer");
	const { app, page, errors } = await launch(root);
	try {
		await startFlow(page);
		const run = driver(page, await activeTab(page));
		const input = page.locator("textarea").first();
		await run.op({
			op: "call",
			id: "b1",
			name: "bash",
			args: { command: "bun run check:types", intent: "Checking types" },
		});
		await run.op({ op: "output", id: "b1", text: "$ tsc --noEmit\nok" });
		await run.op({ op: "end", id: "b1", text: "$ tsc --noEmit\nok" });
		await run.op({
			op: "call",
			id: "t1",
			name: "task",
			args: {
				tasks: [
					{ name: "Scout", task: "Map the code" },
					{ name: "Review", task: "Review the diff" },
				],
			},
			agents: ["Scout", "Review"],
		});
		await expect(page.locator(".omp-work-card-button")).toHaveCount(2);
		await input.fill("Also check the docs");
		await input.press("Enter");
		await input.fill("And the changelog");
		await input.press("Enter");
		await page.evaluate(() => window.omp.rpc.followUp("Then summarize the run"));
		const tray = page.getByRole("region", { name: "Queued", exact: true });
		await expect(tray.locator("li")).toHaveCount(3);
		await capture(page, "steer-1-queued");
		await tray.locator("li", { hasText: "And the changelog" }).getByRole("button", { name: "Remove" }).click();
		await expect(tray.locator("li")).toHaveCount(2);
		await run.op({ op: "steer" });
		await capture(page, "steer-2-delivered");
		await page.waitForTimeout(2500);
		await run.op({ op: "end", id: "t1", text: "Both agents finished" });
		await run.op({ op: "call", id: "b2", name: "bash", args: { command: "bun test", intent: "Running the tests" } });
		await run.op({ op: "output", id: "b2", text: "12 pass\n0 fail" });
		await capture(page, "steer-3-after-agents");
		await run.op({ op: "end", id: "b2", text: "12 pass\n0 fail" });
		await run.op({ op: "reply", text: "Checked types, docs and tests." });
		await expect(tray).toHaveCount(0);
		await run.op({ op: "call", id: "r1", name: "read", args: { path: "CHANGELOG.md" } });
		await capture(page, "steer-4-follow-up-running");
		await run.op({ op: "end", id: "r1", text: "# Changelog" });
		await run.op({ op: "reply", text: "Summary: all green." });
		await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0);
		await capture(page, "steer-5-finished");
		await saveProbe(page, "steer");
		const live = await cards(page).evaluateAll(groups =>
			groups.map(group => group.querySelector(".omp-execution-group-header")?.getAttribute("aria-label")),
		);
		await page.reload();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect(cards(page).first()).toBeVisible({ timeout: 30_000 });
		await capture(page, "steer-6-reloaded");
		const reloaded = await cards(page).evaluateAll(groups =>
			groups.map(group => group.querySelector(".omp-execution-group-header")?.getAttribute("aria-label")),
		);
		await fs.writeFile(path.join(OUT, "steer-summary.json"), JSON.stringify({ live, reloaded, errors }, null, 1));
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("stop mid-run with agents, then resume with a new run", async () => {
	test.setTimeout(180_000);
	const root = await profileDir("stop");
	const { app, page, errors } = await launch(root);
	try {
		await startFlow(page);
		const run = driver(page, await activeTab(page));
		await run.op({ op: "call", id: "b1", name: "bash", args: { command: "bun run build", intent: "Building" } });
		await run.op({ op: "end", id: "b1", text: "built" });
		await run.op({
			op: "call",
			id: "t1",
			name: "task",
			args: {
				tasks: [
					{ name: "Scout", task: "Map the code" },
					{ name: "Review", task: "Review the diff" },
				],
			},
			agents: ["Scout", "Review"],
		});
		await run.op({
			op: "call",
			id: "b2",
			name: "bash",
			args: { command: "sleep 30", intent: "Waiting on the server" },
		});
		await page.waitForTimeout(3200);
		await capture(page, "stop-1-running");
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0);
		await page.waitForTimeout(1500);
		await capture(page, "stop-2-stopped");
		const stopped = await head(page).textContent();
		await startFlow(page, 2);
		await expect(cards(page)).toHaveCount(2);
		const again = driver(page, await activeTab(page));
		await again.op({
			op: "call",
			id: "b3",
			name: "bash",
			args: { command: "bun run build", intent: "Building again" },
		});
		await capture(page, "stop-3-resumed");
		await again.op({ op: "end", id: "b3", text: "built" });
		await again.op({ op: "reply", text: "Built after the stop." });
		await capture(page, "stop-4-finished");
		await saveProbe(page, "stop");
		const heads = await cards(page).evaluateAll(groups =>
			groups.map(group => ({
				state: (group as HTMLElement).dataset.state,
				head: group.querySelector(".omp-work-head .omp-work-narrative")?.textContent,
				summary: group.querySelector(".omp-execution-group-header")?.getAttribute("aria-label"),
			})),
		);
		await page.reload();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect(cards(page)).toHaveCount(2, { timeout: 30_000 });
		await capture(page, "stop-5-reloaded");
		const reloaded = await cards(page).evaluateAll(groups =>
			groups.map(group => ({
				state: (group as HTMLElement).dataset.state,
				head: group.querySelector(".omp-work-head .omp-work-narrative")?.textContent,
				summary: group.querySelector(".omp-execution-group-header")?.getAttribute("aria-label"),
			})),
		);
		await fs.writeFile(
			path.join(OUT, "stop-summary.json"),
			JSON.stringify({ stopped, heads, reloaded, errors }, null, 1),
		);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a plan proposal mid-run, approved with its context", async () => {
	test.setTimeout(180_000);
	const root = await profileDir("plan");
	const { app, page, errors } = await launch(root);
	try {
		await startFlow(page);
		const run = driver(page, await activeTab(page));
		await run.op({ op: "call", id: "r1", name: "read", args: { path: "src/app.ts" } });
		await run.op({ op: "end", id: "r1", text: "export const app = 1;" });
		await run.op({ op: "call", id: "w1", name: "write", args: { path: "local://PLAN.md", content: "## Steps" } });
		await run.op({ op: "end", id: "w1", text: "Wrote local://PLAN.md" });
		await run.op({ op: "propose" });
		await expect(page.getByText("Flow rollout plan").first()).toBeVisible({ timeout: 15_000 });
		await capture(page, "plan-1-proposed");
		const proposed = {
			state: await cards(page).first().getAttribute("data-state"),
			head: await head(page, 0).textContent(),
			stopped: await page.locator(".omp-turn-stopped").count(),
		};
		await page.getByText("Keep context", { exact: true }).click();
		await expect(page.getByText("Flow rollout plan")).toHaveCount(0, { timeout: 15_000 });
		await page.waitForTimeout(600);
		await capture(page, "plan-2-approved");
		const run2 = driver(page, await activeTab(page));
		await run2.op({
			op: "call",
			id: "b1",
			name: "bash",
			args: { command: "bun test", intent: "Running the plan's tests" },
		});
		await expect(cards(page)).toHaveCount(2, { timeout: 15_000 });
		await capture(page, "plan-3-executing");
		await run2.op({ op: "end", id: "b1", text: "12 pass" });
		await run2.op({ op: "reply", text: "Plan executed." });
		await capture(page, "plan-4-finished");
		await saveProbe(page, "plan");
		await page.reload();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect(cards(page)).toHaveCount(2, { timeout: 30_000 });
		await capture(page, "plan-5-reloaded");
		const after = {
			state: await cards(page).first().getAttribute("data-state"),
			head: await head(page, 0).textContent(),
			stopped: await page.locator(".omp-turn-stopped").count(),
		};
		await fs.writeFile(path.join(OUT, "plan-summary.json"), JSON.stringify({ proposed, after, errors }, null, 1));
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a question asked mid-run", async () => {
	test.setTimeout(180_000);
	const root = await profileDir("ask");
	const { app, page, errors } = await launch(root);
	try {
		await startFlow(page);
		const run = driver(page, await activeTab(page));
		await run.op({ op: "call", id: "b1", name: "bash", args: { command: "bun run lint", intent: "Linting" } });
		await run.op({ op: "end", id: "b1", text: "clean" });
		await run.op({ op: "ask" });
		const question = page.getByRole("region", { name: "Question" });
		await expect(question).toContainText("Which environment should the checks use?");
		await page.waitForTimeout(2500);
		await capture(page, "ask-1-asking");
		const asking = {
			head: await head(page).textContent(),
			sub: await cards(page).last().locator(".omp-work-sub").first().textContent(),
		};
		await page.keyboard.press("1");
		const submit = question.getByRole("button", { name: "Submit", exact: true });
		if (await submit.count()) await submit.click();
		await expect(question).toHaveCount(0);
		await capture(page, "ask-2-answered");
		await run.op({
			op: "call",
			id: "b2",
			name: "bash",
			args: { command: "bun test --env staging", intent: "Testing on staging" },
		});
		await run.op({ op: "end", id: "b2", text: "12 pass" });
		await run.op({ op: "reply", text: "Checks ran on staging." });
		await capture(page, "ask-3-finished");
		await saveProbe(page, "ask");
		await fs.writeFile(path.join(OUT, "ask-summary.json"), JSON.stringify({ asking, errors }, null, 1));
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a compaction during a run", async () => {
	test.setTimeout(180_000);
	const root = await profileDir("compact");
	const { app, page, errors } = await launch(root);
	try {
		await startFlow(page);
		const run = driver(page, await activeTab(page));
		for (const index of [1, 2, 3]) {
			await run.op({
				op: "call",
				id: `b${index}`,
				name: "bash",
				args: { command: `step ${index}`, intent: `Step ${index}` },
			});
			await run.op({ op: "end", id: `b${index}`, text: `step ${index} ok` });
		}
		await run.op({ op: "call", id: "b4", name: "bash", args: { command: "step 4", intent: "Step 4" } });
		const before = await cards(page).last().locator(".omp-execution-group-header").getAttribute("aria-label");
		await run.op({ op: "compact-start" });
		await capture(page, "compact-1-compacting");
		await run.op({ op: "compact-end" });
		await page.waitForTimeout(1500);
		await capture(page, "compact-2-compacted");
		const mid = {
			cards: await cards(page).count(),
			summary: await cards(page).last().locator(".omp-execution-group-header").getAttribute("aria-label"),
		};
		await run.op({ op: "end", id: "b4", text: "step 4 ok" });
		await run.op({ op: "call", id: "b5", name: "bash", args: { command: "step 5", intent: "Step 5" } });
		await run.op({ op: "end", id: "b5", text: "step 5 ok" });
		await run.op({ op: "reply", text: "Five steps done." });
		await capture(page, "compact-3-finished");
		await saveProbe(page, "compact");
		const finished = {
			cards: await cards(page).count(),
			summaries: await cards(page).evaluateAll(groups =>
				groups.map(group => group.querySelector(".omp-execution-group-header")?.getAttribute("aria-label")),
			),
		};
		await page.reload();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect(cards(page).first()).toBeVisible({ timeout: 30_000 });
		await capture(page, "compact-4-reloaded");
		const reloaded = {
			cards: await cards(page).count(),
			summaries: await cards(page).evaluateAll(groups =>
				groups.map(group => group.querySelector(".omp-execution-group-header")?.getAttribute("aria-label")),
			),
		};
		await fs.writeFile(
			path.join(OUT, "compact-summary.json"),
			JSON.stringify({ before, mid, finished, reloaded, errors }, null, 1),
		);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("switching tabs away and back mid-run", async () => {
	test.setTimeout(180_000);
	const root = await profileDir("tabs");
	const { app, page, errors } = await launch(root);
	try {
		await startFlow(page);
		const first = await activeTab(page);
		const run = driver(page, first);
		const started = Date.now();
		await run.op({ op: "call", id: "b1", name: "bash", args: { command: "bun run build", intent: "Building" } });
		await page.waitForTimeout(1500);
		await capture(page, "tabs-1-before");
		const spawned = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
		if (!spawned?.tabId) throw new Error("No spawned tab");
		await focusTab(page, spawned.tabId);
		await run.op({ op: "end", id: "b1", text: "built" });
		await run.op({
			op: "call",
			id: "t1",
			name: "task",
			args: { tasks: [{ name: "Scout", task: "Map the code" }] },
			agents: ["Scout"],
		});
		await run.op({ op: "end", id: "t1", text: "Scout finished" });
		await run.op({ op: "call", id: "b2", name: "bash", args: { command: "bun test", intent: "Testing" } });
		await page.waitForTimeout(4000);
		await focusTab(page, first);
		await expect.poll(async () => await activeTab(page)).toBe(first);
		const back = Date.now();
		await page.waitForTimeout(150);
		await capture(page, "tabs-2-back");
		const backState = {
			elapsedSeconds: Math.round((back - started) / 1000),
			clock: await cards(page).last().locator(".omp-work-head-clock").textContent(),
			catchUp: await page.locator(".omp-work-catch-up").allTextContents(),
			head: await head(page).textContent(),
		};
		await page.waitForTimeout(1500);
		await capture(page, "tabs-3-settled");
		await run.op({ op: "end", id: "b2", text: "12 pass" });
		await run.op({ op: "reply", text: "Built and tested." });
		await capture(page, "tabs-4-finished");
		await saveProbe(page, "tabs");
		await fs.writeFile(path.join(OUT, "tabs-summary.json"), JSON.stringify({ backState, errors }, null, 1));
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("four live cards in a 2×2 split", async () => {
	test.setTimeout(240_000);
	const root = await profileDir("split");
	const { app, page, errors } = await launch(root);
	try {
		const first = await activeTab(page);
		const tabs = [first];
		for (let index = 0; index < 3; index++) {
			const tab = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
			if (!tab?.tabId) throw new Error("No spawned tab");
			await expect
				.poll(
					async () =>
						(await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tab.tabId)?.status,
				)
				.toBe("ready");
			tabs.push(tab.tabId);
		}
		await focusTab(page, first);
		const drag = async (id: string, targetIndex: number, x: number, y: number) => {
			const source = await page.locator(`[data-session-path="tab:${id}"]`).boundingBox();
			const target = await page.locator(".omp-session-pane").nth(targetIndex).boundingBox();
			if (!source || !target) throw new Error("Missing split drag geometry");
			await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
			await page.mouse.down();
			await page.mouse.move(source.x + source.width / 2 + 20, source.y + source.height / 2, { steps: 4 });
			await page.mouse.move(target.x + target.width * x + 2, target.y + target.height * y, { steps: 12 });
			await page.mouse.move(target.x + target.width * x, target.y + target.height * y, { steps: 2 });
			await expect(page.locator("[data-split-ghost]")).toHaveCount(1);
			await page.mouse.up();
		};
		await drag(tabs[1] ?? "", 0, 0.92, 0.5);
		await expect(page.locator(".omp-session-pane")).toHaveCount(2);
		await drag(tabs[2] ?? "", 0, 0.5, 0.92);
		await drag(tabs[3] ?? "", 2, 0.5, 0.92);
		await expect(page.locator(".omp-session-pane")).toHaveCount(4);
		const runs = tabs.map(tab => driver(page, tab));
		for (const run of runs) await run.prompt("fixture flow");
		await expect(cards(page)).toHaveCount(4, { timeout: 20_000 });
		for (const [index, run] of runs.entries())
			await run.op({
				op: "call",
				id: "b1",
				name: "bash",
				args: { command: `bun run job ${index}`, intent: `Job ${index}` },
			});
		await capture(page, "split-1-four-live");
		for (let step = 0; step < 6; step++) {
			for (const [index, run] of runs.entries()) {
				await run.op({ op: "output", id: `b${step + 1}`, text: `line ${step}\n`.repeat(step + 3) });
				await run.op({ op: "end", id: `b${step + 1}`, text: `job ${index} step ${step} ok` });
				if (step === 2)
					await run.op({
						op: "call",
						id: "b4",
						name: "task",
						args: { tasks: [{ name: `Agent${index}`, task: "Look around" }] },
						agents: [`Agent${index}`],
					});
				else
					await run.op({
						op: "call",
						id: `b${step + 2}`,
						name: "bash",
						args: { command: `bun run job ${index} step ${step + 1}`, intent: `Job ${index} step ${step + 1}` },
					});
			}
			await page.waitForTimeout(700);
			if (step === 3) await capture(page, "split-2-mid");
		}
		for (const [index, run] of runs.entries()) {
			await run.op({ op: "end", id: "b7", text: `job ${index} done` });
			await run.op({ op: "reply", text: `Job ${index} finished.` });
		}
		await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0);
		await capture(page, "split-3-finished");
		await saveProbe(page, "split");
		await fs.writeFile(path.join(OUT, "split-summary.json"), JSON.stringify({ errors }, null, 1));
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("relaunching the app mid-run", async () => {
	test.setTimeout(240_000);
	const root = await profileDir("relaunch");
	const env = { OMP_GUI_TEST_SESSION_FILES: "1" };
	let launched = await launch(root, env);
	try {
		await startFlow(launched.page);
		const run = driver(launched.page, await activeTab(launched.page));
		await run.bash("fixture:title:Relaunch audit");
		await run.op({ op: "call", id: "b1", name: "bash", args: { command: "bun run build", intent: "Building" } });
		await run.op({ op: "end", id: "b1", text: "built" });
		await run.op({
			op: "call",
			id: "t1",
			name: "task",
			args: { tasks: [{ name: "Scout", task: "Map the code" }] },
			agents: ["Scout"],
		});
		await run.op({ op: "call", id: "b2", name: "bash", args: { command: "bun test", intent: "Testing" } });
		await launched.page.waitForTimeout(2000);
		await capture(launched.page, "relaunch-1-before");
		await exitApp(launched.app);
		launched = await launch(root, env);
		const page = launched.page;
		await capture(page, "relaunch-2-fresh");
		await page
			.getByRole("button", { name: /^Relaunch audit/ })
			.first()
			.click();
		await expect(cards(page).first()).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(2500);
		await capture(page, "relaunch-3-reopened");
		const reopened = await cards(page).evaluateAll(groups =>
			groups.map(group => ({
				state: (group as HTMLElement).dataset.state,
				head: group.querySelector(".omp-work-head .omp-work-narrative")?.textContent,
				clock: group.querySelector(".omp-work-head-clock")?.textContent ?? null,
				summary: group.querySelector(".omp-execution-group-header")?.getAttribute("aria-label"),
				lanes: [...group.querySelectorAll(".omp-work-card-button")].map(lane => lane.textContent),
			})),
		);
		await saveProbe(page, "relaunch");
		await fs.writeFile(
			path.join(OUT, "relaunch-summary.json"),
			JSON.stringify({ reopened, errors: launched.errors }, null, 1),
		);
	} finally {
		await exitApp(launched.app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a remote tab on a paired host", async () => {
	test.setTimeout(240_000);
	const root = await profileDir("remote");
	const discovery = 49_000 + Math.floor(Math.random() * 500) * 2;
	const host = await launch(path.join(root, "b"), {
		OMP_GUI_REMOTE_PORT: "0",
		OMP_GUI_REMOTE_DISCOVERY_PORT: String(discovery),
	});
	const client = await launch(path.join(root, "a"), {
		OMP_GUI_REMOTE_PORT: "0",
		OMP_GUI_REMOTE_DISCOVERY_PORT: String(discovery + 1),
	});
	try {
		const b = host.page;
		const a = client.page;
		const openRemote = async (page: Page) => {
			await page.keyboard.press("ControlOrMeta+Comma");
			await page.locator('[data-settings-page] [data-settings-section="connections"]').click();
			await expect(page.locator("[data-remote-section]")).toBeVisible();
		};
		await b.evaluate(() => window.omp.remote.setDeviceName("Host B"));
		await openRemote(b);
		await b.getByRole("switch", { name: "Let other devices use this computer" }).click();
		const codeRow = b.locator("[data-remote-section] [data-remote-code]");
		await expect(codeRow).toContainText(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
		const port = /:(\d+)/.exec((await b.locator("[data-remote-addresses] li").first().textContent()) ?? "")?.[1];
		const code = /[0-9A-Z]{4}-[0-9A-Z]{4}/.exec((await codeRow.textContent()) ?? "")?.[0];
		await openRemote(a);
		await a.locator("[data-remote-connect]").click();
		const dialog = a.getByRole("dialog", { name: "Connect to a device" });
		await dialog.locator("input[data-remote-address]").fill(`127.0.0.1:${port}`);
		await dialog.locator("input[data-remote-code]").fill(code ?? "");
		await dialog.locator("[data-remote-connect-submit]").click();
		await expect(dialog).toHaveCount(0);
		const hostRow = a.locator("[data-remote-hosts] [data-remote-host]");
		await expect(hostRow).toContainText("Online");
		const deviceId = (await hostRow.getAttribute("data-remote-host")) ?? "";
		await a.keyboard.press("Escape");
		const hostProject = await fs.realpath(path.join(root, "b", "project"));
		const tab = await a.evaluate(([device, cwd]) => window.omp.tabs.spawn({ kind: "agent", device, cwd }), [
			deviceId,
			hostProject,
		] as const);
		if (!tab?.tabId) throw new Error("No remote tab");
		await expect
			.poll(
				async () =>
					(await a.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tab.tabId)?.status,
				{
					timeout: 60_000,
				},
			)
			.toBe("ready");
		await focusTab(a, tab.tabId);
		await startFlow(a);
		const run = driver(a, tab.tabId);
		await run.op({
			op: "call",
			id: "b1",
			name: "bash",
			args: { command: "bun run build", intent: "Building on Host B" },
		});
		await run.op({ op: "output", id: "b1", text: "bundling…" });
		await run.op({
			op: "call",
			id: "t1",
			name: "task",
			args: { tasks: [{ name: "Scout", task: "Map the code" }] },
			agents: ["Scout"],
		});
		await a.waitForTimeout(2500);
		await capture(a, "remote-1-running");
		await run.op({ op: "end", id: "b1", text: "built" });
		await run.op({ op: "end", id: "t1", text: "Scout finished" });
		await run.op({ op: "reply", text: "Built on Host B." });
		await expect(a.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0);
		await capture(a, "remote-2-finished");
		await saveProbe(a, "remote");
		await fs.writeFile(
			path.join(OUT, "remote-summary.json"),
			JSON.stringify({ errors: [...client.errors, ...host.errors] }, null, 1),
		);
	} finally {
		await exitApp(client.app);
		await exitApp(host.app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
