/**
 * Helpers for the composer queue specs on the dev harness (the real renderer over a fixture transport): seed the
 * queue, the held-after-Stop list and the edit state through the stores the page exposes (`window.__stores`), and
 * probe touch targets the way a finger would meet them (`elementFromPoint`).
 */
import type { Locator, Page } from "@playwright/test";

export const SAMPLE_QUEUE: Record<string, string> = {
	s1: "Also cover the 429 case with a test",
	s2: "Use exponential backoff, cap at 30 s",
	f1: "Please also double check the retry budget in sync/worker.ts: the current loop never resets `attempt` after a success, so a flaky network that recovers still waits the maximum delay. Add a regression test that fails first, then fix it.",
	f2: "When that is done, run the full suite and summarize any failures",
	f3: "Update the changelog entry",
	f4: "Rename retryDelay to backoffMs everywhere",
	f5: "Then open a draft PR with the summary",
	f6: "Check that the Windows path still works",
	f7: "Leave the old constants in place for now",
	f8: "Run the formatter over the touched files",
};

export interface QueueSeed {
	/** Ids of SAMPLE_QUEUE for each lane. */
	steering: string[];
	followUp: string[];
	/** A turn is running (the queue only matters then). Default true. */
	running?: boolean;
}

/** Put messages in the queue lanes (and a running turn behind them) the way a `queue_update` frame would. */
export async function seedQueue(page: Page, seed: QueueSeed): Promise<void> {
	await page.evaluate(
		({ steering, followUp, running, texts }) => {
			const stores = window.__stores;
			if (!stores) throw new Error("the harness stores are missing");
			const item = (id: string) => ({ id, text: texts[id] ?? id, editable: true, timestamp: 1 });
			stores.session.setState({ isStreaming: running, status: "ready" });
			stores.queue.setState({ steering: steering.map(item), followUp: followUp.map(item) });
		},
		{ steering: seed.steering, followUp: seed.followUp, running: seed.running ?? true, texts: SAMPLE_QUEUE },
	);
}

/** Hold messages as a Stop would have withdrawn them (`composer.restoredQueue`); nothing is sent. */
export async function seedPaused(page: Page, ids: Array<{ id: string; lane: "steering" | "followUp" }>): Promise<void> {
	await page.evaluate(
		({ entries, texts }) => {
			const composer = window.__stores?.composer;
			if (!composer) throw new Error("the harness stores are missing");
			const state = composer.getState() as {
				holdRestored: (items: Array<{ lane: string; text: string; images: unknown[] }>) => void;
			};
			state.holdRestored(entries.map(({ id, lane }) => ({ lane, text: texts[id] ?? id, images: [] })));
		},
		{ entries: ids, texts: SAMPLE_QUEUE },
	);
}

/** The composer box's and the transcript's heights and the box's top: what queuing must leave alone. */
export async function composerGeometry(page: Page): Promise<{ transcript: number; box: number; top: number }> {
	return page.evaluate(() => {
		const transcript = document.querySelector(".omp-transcript-scroll");
		const box = document.querySelector(".omp-composer-box");
		return {
			transcript: transcript?.clientHeight ?? -1,
			box: Math.round(box?.getBoundingClientRect().height ?? -1),
			top: Math.round(box?.getBoundingClientRect().top ?? -1),
		};
	});
}

export interface TapProbe {
	label: string;
	points: number;
	/** Points inside the control's own drawn box that a tap would deliver to a different control. */
	stolen: number;
}

/**
 * For every visible control matching `locator`: a grid of points over its drawn box, each resolved with
 * `elementFromPoint`; a point that lands on another control (not the control, a descendant or its hit-area) is stolen.
 */
export async function tapProbe(locator: Locator): Promise<TapProbe[]> {
	return locator.evaluateAll(nodes =>
		nodes.flatMap(node => {
			// Only what a finger can reach: the part of the box inside every scrolling or clipping ancestor and the window.
			let { left, top, right, bottom } = node.getBoundingClientRect();
			for (let parent = node.parentElement; parent; parent = parent.parentElement) {
				const style = getComputedStyle(parent);
				if (style.overflowX === "visible" && style.overflowY === "visible") continue;
				const clip = parent.getBoundingClientRect();
				left = Math.max(left, clip.left);
				top = Math.max(top, clip.top);
				right = Math.min(right, clip.right);
				bottom = Math.min(bottom, clip.bottom);
			}
			right = Math.min(right, window.innerWidth);
			bottom = Math.min(bottom, window.innerHeight);
			const width = right - left;
			const height = bottom - top;
			if (width <= 1 || height <= 1) return [];
			let points = 0;
			let stolen = 0;
			const steps = 5;
			for (let ix = 0; ix < steps; ix++) {
				for (let iy = 0; iy < steps; iy++) {
					const x = left + ((ix + 0.5) / steps) * width;
					const y = top + ((iy + 0.5) / steps) * height;
					const hit = document.elementFromPoint(x, y)?.closest("button, [role='menuitem'], a[href]") ?? null;
					points++;
					if (hit && hit !== node) stolen++;
				}
			}
			return [
				{ label: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? node.tagName, points, stolen },
			];
		}),
	);
}
