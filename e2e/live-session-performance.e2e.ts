import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { countIpc, measure, PROBE, type Probe, type Ready } from "./frame-probe";
import { exitApp, fixtureOmp } from "./harness";

// Opt-in audit of the user's real shape: a very long session open while a live
// work card runs. OMP_GUI_LIVE_SESSION_SOURCE names a stock session file; the
// app only ever sees a private copy-on-write clone of it and its artifact dir.
// The fake omp serves that copy as its transcript and streams work frames, so
// no model is called. OMP_GUI_BASELINE_DIR (a checkout root holding a built
// `out/`) adds an interleaved "before" subject.

test("long real session with a live work card: open, scroll, idle and streaming cost", async () => {
	const source = process.env.OMP_GUI_LIVE_SESSION_SOURCE;
	test.skip(!source, "Explicit isolated live-session audit");
	if (!source) return;
	test.setTimeout(1_800_000);
	const runs = Number(process.env.OMP_GUI_LIVE_SESSION_RUNS ?? 2);
	const journal = (await fs.readFile(source, "utf8")).split("\n").filter(Boolean);
	const tail = journal
		.map(
			line =>
				JSON.parse(line) as { type: string; message?: { role: string; timestamp?: number; content?: unknown } },
		)
		.findLast(
			entry =>
				entry.type === "message" &&
				entry.message?.role === "assistant" &&
				Array.isArray(entry.message.content) &&
				entry.message.content.some(block => block.type === "text" && block.text.trim()),
		);
	if (tail?.message?.timestamp === undefined) throw new Error("Session has no terminal assistant row");
	const tailKey = `message-assistant-${tail.message.timestamp}`;
	const subjects = [
		{ name: "after", root: process.env.OMP_GUI_CANDIDATE_DIR ?? process.cwd() },
		...(process.env.OMP_GUI_BASELINE_DIR ? [{ name: "before", root: process.env.OMP_GUI_BASELINE_DIR }] : []),
	];
	const results: object[] = [];
	for (let run = 0; run < runs; run++)
		for (const subject of run % 2 ? [...subjects].reverse() : subjects) {
			const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-live-session-"));
			await fs.chmod(profile, 0o700);
			const project = path.join(profile, "project");
			const desktop = path.join(profile, "desktop");
			const agent = path.join(profile, "agent");
			const sessions = path.join(agent, "sessions", "-live-session-audit");
			await Promise.all([project, desktop, sessions].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
			const copy = path.join(sessions, path.basename(source));
			// APFS clones: instant, private, and the source is only ever read.
			execFileSync("cp", ["-c", source, copy]);
			const artifacts = source.slice(0, -".jsonl".length);
			if (await fs.stat(artifacts).catch(() => undefined)) execFileSync("cp", ["-c", "-R", artifacts, sessions]);
			await fs.writeFile(
				path.join(desktop, "prefs.json"),
				JSON.stringify({ language: "en", firstRunComplete: true }),
			);
			const env = {
				...process.env,
				PI_CODING_AGENT_DIR: agent,
				PI_CONFIG_DIR: path.relative(os.homedir(), profile),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_GUI_OMP: await fixtureOmp(profile),
				OMP_GUI_TEST_SEED_SESSION: copy,
			};
			Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
			const app = await electron.launch({
				args: [path.join(subject.root, "out/main/index.js"), project, `--user-data-dir=${desktop}`],
				env,
			});
			const errors: string[] = [];
			try {
				const page = await app.firstWindow();
				page.on("pageerror", error => errors.push(error.message));
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
				await page.waitForFunction(() => window.omp?.rpc != null);
				await expect
					.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, {
						timeout: 120_000,
					})
					.toBe("ready");
				await countIpc(app);
				await page.context().addInitScript(PROBE);
				const opened = performance.now();
				await page.reload();
				await expect(page.locator(`[data-row-key=${JSON.stringify(tailKey)}]`)).toBeVisible({ timeout: 120_000 });
				const openMs = Math.round(performance.now() - opened);
				// What-if knob: OMP_GUI_LIVE_SESSION_CSS adds a stylesheet (e.g. one animation
				// switched off) so a window's cost can be attributed to it.
				if (process.env.OMP_GUI_LIVE_SESSION_CSS)
					await page.addStyleTag({ content: process.env.OMP_GUI_LIVE_SESSION_CSS });
				const cdp = await page.context().newCDPSession(page);
				await cdp.send("HeapProfiler.collectGarbage");
				const openHeapMb = Math.round((await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576);
				await page.waitForTimeout(2000);
				// OMP_GUI_LIVE_SESSION_PHASES: a comma list of idle, scroll, stream, panel, type
				// and tab (default all of them, in that order).
				const phases = new Set(
					(process.env.OMP_GUI_LIVE_SESSION_PHASES ?? "idle,scroll,stream,panel,type,tab").split(","),
				);
				const idle = phases.has("idle") ? await measure(app, page, `${subject.name}-${run}-idle`, 10) : undefined;
				// Scroll up through history: the virtualizer mounts and measures new rows.
				const scroller = page.locator(".omp-transcript-scroll").first();
				const box = await scroller.boundingBox();
				if (!box) throw new Error("No transcript scroller");
				// Wheel in the transcript's left gutter: over the column a card's own scroller
				// (overscroll-behavior: contain) can sit under the pointer and swallow the
				// wheel once it reaches its top, which stalled the scroll mid-history.
				const pointer = { x: box.x + 12, y: box.y + box.height / 2 };
				await page.mouse.move(pointer.x, pointer.y);
				// OMP_GUI_LIVE_SESSION_WHEEL_STEPS shortens the scroll, e.g. to stop before
				// history a baseline cannot reach.
				const wheelSteps = phases.has("scroll") ? Number(process.env.OMP_GUI_LIVE_SESSION_WHEEL_STEPS ?? 60) : 0;
				const scroll = phases.has("scroll")
					? await measure(app, page, `${subject.name}-${run}-scroll`, 8, async () => {
							for (let step = 0; step < wheelSteps; step++) {
								await page.mouse.wheel(0, -700);
								await page.waitForTimeout(100);
							}
						})
					: undefined;
				// How far through history the scroll got (scrollTop / canvas height), so runs
				// that loaded different pages are told apart. Read after the window: a
				// read during it forces a layout of its own.
				const reached = await page.evaluate(({ x, y }) => {
					const element = document.querySelector(".omp-transcript-scroll");
					const canvas = element?.querySelector<HTMLElement>(".omp-transcript-canvas");
					const chain: string[] = [];
					for (
						let under = document.elementFromPoint(x, y);
						under && under !== element;
						under = under.parentElement
					) {
						const style = getComputedStyle(under);
						if (style.overflowY === "auto" || style.overflowY === "scroll")
							chain.push(
								`${under.className.split(" ")[0]}:${under.scrollTop}/${under.scrollHeight}/${under.clientHeight}:${style.overscrollBehaviorY}`,
							);
					}
					const status = document.querySelector("[data-testid=transcript-history-status]")?.textContent;
					return `${Math.round(element?.scrollTop ?? 0)}/${canvas?.style.height} under=[${chain.join(",")}] status=${status}`;
				}, pointer);
				if (phases.has("scroll")) {
					await page.getByRole("button", { name: "Jump to latest" }).click();
					await expect(page.locator(`[data-row-key=${JSON.stringify(tailKey)}]`)).toBeVisible();
				}
				const live = !phases.has("stream")
					? undefined
					: await (async () => {
							const control = (command: string) =>
								page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), command);
							// The stock session keeps growing while the run streams; main's index watches it.
							const appendJournal = async (seconds: number) => {
								const until = Date.now() + seconds * 1000;
								const line = journal[journal.length - 1];
								while (Date.now() < until) {
									await fs.appendFile(copy, `${line}\n`);
									await delay(250);
								}
							};
							const input = page.locator("textarea").first();
							await input.fill("fixture work view");
							await input.press("Enter");
							await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
								timeout: 30_000,
							});
							await control("fixture:work-next");
							const card = page.locator('.omp-execution-group > .omp-live-step[data-state="running"]');
							await expect(card).toHaveAttribute("data-surface", "bash", { timeout: 30_000 });
							await control("fixture:work-stream");
							const streamOutput = await measure(app, page, `${subject.name}-${run}-stream-output`, 10, () =>
								appendJournal(10),
							);
							for (let step = 0; step < 3; step++) await control("fixture:work-next");
							await expect(card.locator(".omp-execution-group-summary")).toHaveText("4 steps");
							await control("fixture:work-output");
							await page.waitForTimeout(1000);
							const cardIdle = await measure(app, page, `${subject.name}-${run}-card-idle`, 10);
							await control("fixture:work-stream");
							const streamAgents = await measure(app, page, `${subject.name}-${run}-stream-agents`, 10, () =>
								appendJournal(10),
							);
							return { streamOutput, cardIdle, streamAgents };
						})();
				// Interaction latency: from the latest key or pointer press to the first frame
				// (a frame callback, right before its paint) in which the probe's `ready`
				// check holds.
				const latency = async (check: keyof Ready, arg: string) =>
					Math.round(
						await (
							await page.waitForFunction(
								({ check, arg }) => {
									if (!(Reflect.get(window, "__ompReady") as Ready)[check](arg)) return 0;
									return performance.now() - (Reflect.get(window, "__ompPerf") as Probe).lastInput || 0.1;
								},
								{ check, arg },
								{ polling: "raf", timeout: 60_000 },
							)
						).jsonValue(),
					);
				// The right panel: open and close it twice with its shortcut (⌘J).
				const panelOpenMs: number[] = [];
				const panel = phases.has("panel")
					? await measure(app, page, `${subject.name}-${run}-panel`, 6, async () => {
							for (let step = 0; step < 4; step++) {
								const opening = step % 2 === 0;
								await page.keyboard.press("ControlOrMeta+j");
								const ms = await latency("panel", opening ? "open" : "closed");
								if (opening) panelOpenMs.push(ms);
								await page.waitForTimeout(1000);
							}
						})
					: undefined;
				// Typing in the composer, one key every 50 ms.
				const typing = phases.has("type")
					? await (async () => {
							const input = page.locator("textarea").first();
							await input.click();
							const typed = await measure(app, page, `${subject.name}-${run}-type`, 6, () =>
								input.pressSequentially("The transcript must stay still while I type this line. ", {
									delay: 50,
								}),
							);
							await input.fill("");
							return typed;
						})()
					: undefined;
				// Tabs: ⌘T opens a second tab (the fake omp seeds every tab with this
				// session, so it opens the same long transcript), then ⌃⇥ switches
				// between the two (OMP_GUI_LIVE_SESSION_SWITCH_KEY picks another chord,
				// e.g. Meta+Shift+BracketRight, v0.29's next-tab without the switcher).
				const tabs = phases.has("tab")
					? await (async () => {
							const list = () => page.evaluate(() => window.omp.tabs.list());
							const first = (await list()).find(tab => tab.active)?.tabId;
							if (!first) throw new Error("No active tab");
							let second = "";
							const openMs: number[] = [];
							const switchMs: number[] = [];
							const open = await measure(app, page, `${subject.name}-${run}-tab-open`, 6, async () => {
								await page.keyboard.press("ControlOrMeta+t");
								await expect.poll(async () => (await list()).length, { timeout: 60_000 }).toBe(2);
								second = (await list()).find(tab => tab.tabId !== first)?.tabId ?? "";
								openMs.push(await latency("pane", second));
							});
							const secondRows = await page.evaluate(
								id =>
									document.querySelector(
										`.omp-session-pane[data-tab-id="${CSS.escape(id)}"] .omp-transcript-rows`,
									)?.childElementCount ?? 0,
								second,
							);
							await page.waitForTimeout(1000);
							const switching = await measure(app, page, `${subject.name}-${run}-tab-switch`, 8, async () => {
								for (const target of [first, second, first, second]) {
									await page.keyboard.press(process.env.OMP_GUI_LIVE_SESSION_SWITCH_KEY ?? "Control+Tab");
									switchMs.push(await latency("pane", target));
									await page.waitForTimeout(1000);
								}
							});
							return { openMs, secondRows, open, switchMs, switching };
						})()
					: undefined;
				await cdp.send("HeapProfiler.collectGarbage");
				const endHeapMb = Math.round((await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576);
				if (live) await page.evaluate(() => window.omp.rpc.command({ type: "abort" }));
				await cdp.detach();
				const result = {
					subject: subject.name,
					run,
					openMs,
					openHeapMb,
					endHeapMb,
					idle,
					scroll: scroll && { ...scroll, reached },
					...live,
					panel: panel && { openMs: panelOpenMs, ...panel },
					typing,
					tabs,
					errors,
				};
				results.push(result);
				console.log(JSON.stringify(result));
				await fs.mkdir("test-results", { recursive: true });
				await fs.writeFile(
					process.env.OMP_GUI_LIVE_SESSION_OUT ?? "test-results/live-session-performance.json",
					JSON.stringify(results, null, 2),
				);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
});
