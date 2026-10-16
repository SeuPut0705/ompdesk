import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

async function withLiveWorkApp(history: number, body: (page: Page) => Promise<void>): Promise<void> {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-steps-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_HISTORY: String(history),
		},
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await body(page);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

// A multi-step turn must keep one running work group and one work card: the
// pending head, then the run's card, which its streaming row hands to its history row intact.
test("a multi-step turn keeps one live work group and work surface", async () => {
	await withLiveWorkApp(0, async page => {
		await page.evaluate(() => {
			const w = window as unknown as { __probe: string[]; __panels: number };
			w.__probe = [];
			w.__panels = 0;
			let last = "";
			const seen = new WeakSet<Element>();
			setInterval(() => {
				const groups = document.querySelectorAll(".omp-execution-group").length;
				const running = document.querySelectorAll('.omp-execution-group[data-state="running"]').length;
				const panels = [...document.querySelectorAll(".omp-live-step")];
				for (const panel of panels)
					if (!seen.has(panel)) {
						seen.add(panel);
						w.__panels++;
					}
				const tag = `groups=${groups} running=${running} panels=${panels.length}`;
				if (tag !== last) {
					w.__probe.push(tag);
					last = tag;
				}
			}, 10);
		});
		const input = page.locator("textarea").first();
		await input.fill("fixture steps");
		await input.press("Enter");
		await expect(page.locator("[data-transcript-kind]").filter({ hasText: "Steps finished" })).toHaveCount(1, {
			timeout: 30_000,
		});
		const result = await page.evaluate(() => {
			const w = window as unknown as { __probe: string[]; __panels: number };
			return { probe: w.__probe, panelMounts: w.__panels };
		});
		// Never two work groups; the pending head and one card, never a remount.
		expect(result.probe.filter(state => !state.startsWith("groups=0") && !state.startsWith("groups=1"))).toEqual([]);
		expect(result.panelMounts).toBeLessThanOrEqual(2);
	});
});

// The bounded work surface must not create overflow beneath transcript rows.
test("the live work surface never stretches the transcript below its rows", async () => {
	await withLiveWorkApp(40, async page => {
		const input = page.locator("textarea").first();
		await input.fill("fixture edits");
		await input.press("Enter");
		const surface = page.locator(".omp-work-stage > .omp-work-crossfade > [data-incoming] .omp-live-step-scroll");
		await expect(surface).toContainText("step 7 output 8", { timeout: 30_000 });
		await expect(
			page.locator(
				'.omp-execution-group[data-state="running"] > .omp-live-step > .omp-live-work-strip [data-step-id]',
			),
		).toHaveCount(7);

		const layout = () =>
			page.evaluate(() => {
				const scroll = document.querySelector<HTMLElement>(".omp-transcript-scroll");
				const canvas = document.querySelector<HTMLElement>(".omp-transcript-canvas");
				const rows = [
					...(canvas?.querySelectorAll<HTMLElement>(":scope > .omp-transcript-rows > [data-index]") ?? []),
				];
				if (!scroll || !canvas || rows.length === 0) return null;
				const contentBottom = Math.max(...rows.map(row => row.getBoundingClientRect().bottom));
				return {
					// Scrollable height the rows do not account for.
					overflow: scroll.scrollHeight - canvas.offsetHeight,
					// Empty band between the last row and the bottom of the viewport.
					emptyBelow: scroll.getBoundingClientRect().bottom - contentBottom,
				};
			});
		// Let the tail follower settle on the finished log, then the transcript must
		// end at its last row and the view must sit on it.
		await expect.poll(async () => (await layout())?.emptyBelow, { timeout: 5_000 }).toBeLessThan(40);
		const settled = await layout();
		expect(settled?.overflow).toBe(0);
		expect(settled?.emptyBelow).toBeLessThan(40);
	});
});

test("live work follows tool kinds, streams output and replays past steps", async () => {
	test.setTimeout(process.env.OMP_GUI_WORK_SCREENSHOTS ? 300_000 : 120_000);
	await withLiveWorkApp(0, async page => {
		const directory = process.env.OMP_GUI_WORK_SCREENSHOTS;
		// Frame data for the live card: every painted frame records the head's and the open stage's
		// heights and how much of the head's narrative shows (the opaque incoming layer over the
		// outgoing one: in + out × (1 − in)).
		await page.evaluate(() => {
			const samples: {
				at: number;
				card: number;
				head: number;
				shell: number;
				stage: number;
				narrative: number;
				pending: boolean;
				step: string;
			}[] = [];
			const sampler = { samples, running: true };
			Reflect.set(window, "__ompCardFrames", sampler);
			// Which card element a frame saw: a remount shows up as a new number.
			const cards = new WeakMap<Element, number>();
			const tick = () => {
				const card = document.querySelector<HTMLElement>(
					'.omp-execution-group[data-state="running"] > .omp-live-step',
				);
				if (card) {
					if (!cards.has(card)) cards.set(card, samples.length);
					const shell = card.querySelector<HTMLElement>(':scope > .omp-work-stage-shell[data-open="true"]');
					const opacity = (selector: string) => {
						const layer = card.querySelector<HTMLElement>(`.omp-work-head .omp-work-frame${selector}`);
						return layer ? Number(getComputedStyle(layer).opacity) : 0;
					};
					const incoming = opacity("[data-incoming]");
					const narrative = incoming + opacity("[data-outgoing]") * (1 - incoming);
					samples.push({
						at: performance.now(),
						card: cards.get(card) ?? -1,
						head: card.querySelector<HTMLElement>(".omp-work-head")?.offsetHeight ?? 0,
						shell: card.querySelector<HTMLElement>(":scope > .omp-work-stage-shell")?.offsetHeight ?? 0,
						stage: shell?.querySelector<HTMLElement>(".omp-work-stage")?.offsetHeight ?? 0,
						narrative,
						pending: card.hasAttribute("data-pending"),
						step: card.dataset.surface ?? "",
					});
				}
				if (sampler.running) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		const input = page.locator("textarea").first();
		await input.fill("fixture work view");
		await input.press("Enter");
		const surface = page.locator(".omp-execution-group > .omp-live-step");
		const content = surface.locator(".omp-work-stage > .omp-work-crossfade > [data-incoming] .omp-live-step-scroll");
		const control = (command: string) =>
			page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), command);
		const capture = async (kind: string) => {
			if (!directory) return;
			await fs.mkdir(directory, { recursive: true });
			for (const [theme, label] of [
				["light", "Porcelain"],
				["dark", "Graphite"],
			]) {
				await input.fill("/theme");
				await page.getByRole("button", { name: "Send", exact: true }).first().click();
				const picker = page.getByRole("dialog");
				await picker.getByPlaceholder("Search themes…").fill(label);
				await picker
					.locator("button[aria-pressed]")
					.filter({ hasText: new RegExp(label, "i") })
					.click();
				await expect(picker).toHaveCount(0);
				const noticeClose = page.getByRole("button", { name: "Close", exact: true });
				if (await noticeClose.count()) await noticeClose.click();
				await expect(noticeClose).toHaveCount(0);
				await page.screenshot({
					path: path.join(directory, `${kind}-${theme}.png`),
					scale: "css",
					animations: "disabled",
				});
			}
		};
		await expect(surface).toHaveAttribute("data-surface", "thinking");
		await expect(surface.locator(".omp-work-sub")).toContainText("Preparing the workspace");
		await expect(content).toHaveCount(0);
		await capture("thinking");
		const kinds = [
			"bash",
			"write",
			"read",
			"task",
			"wait",
			"wait",
			"browser",
			"computer",
			"edit",
			"eval",
			"grep",
			"glob",
			"web_search",
		];
		let stageHeight = 0;
		for (const [index, kind] of kinds.entries()) {
			await control("fixture:work-next");
			await expect(surface).toHaveAttribute("data-surface", kind);
			await expect(surface.locator(`[data-step-id="work-view-${index}"]`)).toHaveAttribute("aria-pressed", "true");
			const height = await surface.locator(".omp-work-stage").evaluate(element => element.clientHeight);
			if (index === 0) stageHeight = height;
			else expect(height).toBe(stageHeight);
			if (kind === "bash") {
				await expect(content).toContainText("Checking renderer components");
				await expect(surface.locator(".omp-work-notes-line")).toHaveCount(2);
				await expect(surface.locator(".omp-work-notes")).toContainText("Workspace coordination is ready.");
				await expect(surface.locator(".omp-work-notes")).toContainText(
					"Check keyboard reachability before finishing.",
				);
				await expect(page.locator(".omp-custom-turn")).toHaveCount(0);
				await capture("notes");
				await surface.locator(".omp-work-notes-line").first().click();
				await expect(surface.locator(".omp-work-notes-body")).toBeVisible();
				await capture("notes-expanded");
				await surface.locator(".omp-work-notes-line").first().click();
				await control("fixture:work-output");
				await expect(content.locator(".omp-bash-line")).toHaveText([
					"$ tsc --noEmit",
					"Checking renderer components…",
					"Checking workspace state…",
					"All types are valid",
				]);
			} else if (kind === "write" || kind === "read") {
				await expect(content).toContainText("title: 'Live work'");
			} else if (kind === "task") {
				// Agent lanes stay above the stage; the selected agent owns its viewport.
				const lanes = surface.locator(".omp-work-card-button");
				await expect(lanes.filter({ hasText: "WorkspaceScout" })).toContainText("Reading source files");
				await expect(lanes.filter({ hasText: "WorkspaceReview" })).toContainText("Reviewing keyboard navigation");
				await expect(surface.locator(".omp-work-stage")).toBeVisible();
			} else if (kind === "wait") {
				await expect(surface.locator(".omp-work-sub")).toContainText("Waiting for");
				await expect(surface.locator(".omp-work-stage")).toBeVisible();
				// One strip: an auto-followed agent draws none of its own, the card's strip stays.
				await expect(surface.locator(".omp-live-work-strip")).toHaveCount(1);
				await expect(surface.locator(":scope > .omp-live-work-strip [data-step-id]")).toHaveCount(5);
			} else if (kind === "browser" || kind === "computer") {
				await expect(content.locator("img")).toBeVisible();
				// The capture fits the stage whole: nothing to scroll, its bottom above the strip.
				await expect
					.poll(() =>
						content.evaluate(scroller => {
							const image = scroller.querySelector("img")?.getBoundingClientRect();
							const view = scroller.getBoundingClientRect();
							return (
								image !== undefined &&
								image.height > 40 &&
								scroller.scrollHeight <= scroller.clientHeight + 1 &&
								image.bottom <= view.bottom + 0.5
							);
						}),
					)
					.toBe(true);
			} else if (kind === "edit") {
				// The stage follows the newest change to its first changed line — below the first
				// change, above the tail — and holds it inside the stage's visible rect.
				const changed = content.locator("[data-live-focus]").last();
				await expect(changed).toContainText("export function start() {}");
				await expect
					.poll(async () => {
						const [line, view] = await Promise.all([changed.boundingBox(), content.boundingBox()]);
						return (
							line !== null && view !== null && line.y >= view.y && line.y + line.height <= view.y + view.height
						);
					})
					.toBe(true);
				// Shown by following, not by an unscrolled stage: the scrollers between them moved.
				const scrolled = await changed.evaluate(element => {
					let total = 0;
					for (let node = element.parentElement; node; node = node.parentElement) {
						total += node.scrollTop;
						if (node.classList.contains("omp-live-step-scroll")) break;
					}
					return total;
				});
				expect(scrolled).toBeGreaterThan(0);
			} else if (kind === "web_search") {
				await expect(content).toContainText("Keyboard accessibility");
				await expect(content).toContainText("Make every control reachable with the keyboard.");
			}
			// One scroller per stage: a renderer's own capped box never scrolls inside a scrolling stage
			// (seen as two scrollbars side by side on a long diff).
			const scrollers = await surface
				.locator(".omp-work-stage > .omp-work-crossfade > [data-incoming]")
				.evaluate(frame =>
					[...frame.querySelectorAll("*")]
						.filter(element => {
							const style = getComputedStyle(element);
							return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
						})
						.map(element => element.className),
				);
			expect(scrollers.length, `${kind}: ${scrollers.join(" | ")}`).toBeLessThanOrEqual(1);
			if (index !== 5) await capture(kind);
			if (index === 2) {
				const past = surface.locator('[data-step-id="work-view-0"]');
				await past.focus();
				await past.press("Enter");
				await expect(surface).toHaveAttribute("data-following", "false");
				await expect(surface).toHaveAttribute("data-surface", "bash");
				await expect(content).toContainText("All types are valid");
				await capture("replay");
				await surface.getByRole("button", { name: "Back to current step", exact: true }).click();
				// Following again: no status label is drawn, only the step strip.
				await expect(surface.locator(".omp-live-work-follow")).toHaveCount(0);
				await expect(surface).toHaveAttribute("data-following", "true");
				await expect(surface).toHaveAttribute("data-surface", "read");
			}
		}
		const frames = await page.evaluate(() => {
			const sampler = Reflect.get(window, "__ompCardFrames") as {
				running: boolean;
				samples: {
					at: number;
					card: number;
					head: number;
					shell: number;
					stage: number;
					narrative: number;
					pending: boolean;
					step: string;
				}[];
			};
			sampler.running = false;
			return sampler.samples;
		});
		if (directory) await fs.writeFile(path.join(directory, "live-card-frames.json"), JSON.stringify(frames));
		expect(frames.length).toBeGreaterThan(100);
		// The head keeps one height all run long: the sub line is reserved from the first frame.
		expect(new Set(frames.map(frame => frame.head)).size, "head heights").toBe(1);
		// Once open, the stage holds one height for every tool kind.
		const stages = frames.filter(frame => frame.stage > 0).map(frame => frame.stage);
		expect(Math.max(...stages) - Math.min(...stages), "stage height range").toBeLessThanOrEqual(1);
		// One card for the whole run: the streaming row finalizes into its history row under the
		// same element (the pending head before it is a separate placeholder in the same frame).
		expect(new Set(frames.filter(frame => !frame.pending).map(frame => frame.card)).size, "card mounts").toBe(1);
		// The head's narrative is never thinner than one full line, from the pending head through
		// every step change: the incoming line dissolves over the departing one held at full opacity.
		expect(Math.min(...frames.map(frame => frame.narrative)), "narrative visibility").toBeGreaterThanOrEqual(0.999);
		// The stage opens by unfolding, never in one frame.
		const opening = frames.findIndex(frame => frame.shell > 0);
		expect(frames[opening]?.shell ?? 0, "stage first open frame").toBeLessThan(frames.at(-1)?.shell ?? 0);
		await surface.locator('[data-step-id="work-view-1"]').click();
		await expect(surface).toHaveAttribute("data-surface", "write");
		// Exercise the exact drag-to-split path, including a 2×2 pane layout.
		if (directory) {
			const tabs = await page.evaluate(() => window.omp.tabs.list());
			const first = tabs.find(tab => tab.active)?.tabId;
			if (!first) throw new Error("No active tab");
			const spawned = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
			if (!spawned?.tabId) throw new Error("No spawned tab");
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
			await expect
				.poll(
					async () =>
						(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === spawned.tabId)?.status,
				)
				.toBe("ready");
			await drag(spawned.tabId, 0, 0.92, 0.5);
			await expect(page.locator(".omp-session-pane")).toHaveCount(2);
			for (const targetIndex of [0, 2]) {
				const tab = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
				if (!tab?.tabId) throw new Error("No spawned split tab");
				await expect
					.poll(
						async () =>
							(await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tab.tabId)
								?.status,
					)
					.toBe("ready");
				await drag(tab.tabId, targetIndex, 0.5, 0.92);
			}
			await expect(page.locator(".omp-session-pane")).toHaveCount(4);
			const pane = page.locator(`[data-tab-id="${first}"]`);
			await capture("two-by-two-split");
			const box = await pane.boundingBox();
			const work = await pane.locator(".omp-live-step").boundingBox();
			if (!box || !work) throw new Error("Missing live split surface");
			expect(work.height).toBeLessThan(box.height * 0.5);
			expect(await pane.locator(".omp-work-stage").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(
				96,
			);
			for (const chip of [pane.locator('.omp-live-work-chips [aria-pressed="true"]')]) {
				await expect
					.poll(async () => {
						const bounds = await chip.boundingBox();
						return (
							bounds !== null &&
							bounds.x >= work.x &&
							bounds.x + bounds.width <= work.x + work.width &&
							bounds.y >= work.y &&
							bounds.y + bounds.height <= work.y + work.height
						);
					})
					.toBe(true);
			}
			await page.screenshot({
				path: path.join(directory, "split-2x2-dark.png"),
				scale: "css",
				animations: "disabled",
			});
			// Finish the held turn in its original pane, not the focused sibling.
			await page.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:work-next" }),
				first,
			);
		} else {
			await control("fixture:work-next");
		}
		await expect(page.locator('.omp-live-step[data-following="true"]')).toHaveCount(0);
		await expect(page.locator(".omp-execution-group-header").first()).toHaveAttribute("aria-expanded", "false");
		await page.locator(".omp-execution-group-header").first().click();
		await expect(page.locator(".omp-execution-group-body").first()).toBeVisible();
	});
});

// A subagent's read screenshots reach the outcome as stock persisted them (blob
// references in its JSONL): the row draws the stored picture and shows one whose
// blob is gone as its file, never a broken image or a path as alt text.
test("outcome thumbnails draw a subagent's read screenshots from stock's blob store", async () => {
	await withLiveWorkApp(0, async page => {
		const input = page.locator("textarea").first();
		await input.fill("fixture subagent screenshots");
		await input.press("Enter");
		const row = page.locator(".omp-work-images").first();
		const thumbnail = row.locator(".omp-work-image img");
		await expect(thumbnail).toHaveCount(1, { timeout: 30_000 });
		await expect(thumbnail).toHaveAttribute("alt", "home.png");
		await expect
			.poll(() => thumbnail.evaluate(image => (image as HTMLImageElement).naturalWidth), { timeout: 10_000 })
			.toBeGreaterThan(0);
		const chip = row.locator("[data-image-unavailable]");
		await expect(chip).toHaveCount(1);
		await expect(chip).toContainText("gone.png");
		await expect(chip.locator("img")).toHaveCount(0);
		const directory = process.env.OMP_GUI_WORK_SCREENSHOTS;
		if (directory) {
			await fs.mkdir(directory, { recursive: true });
			await page
				.locator(".omp-execution-group")
				.first()
				.screenshot({
					path: path.join(directory, "outcome-images.png"),
					animations: "disabled",
				});
		}
	});
});
