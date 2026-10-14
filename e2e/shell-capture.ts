import * as path from "node:path";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";

// Capture helpers shared by the opt-in shell audits (shell-audit, shell-flows):
// each screenshot also records horizontal overflow, clipped text, popups that
// leave the window and motion under reduced motion, so a review starts from facts.

export interface Finding {
	shot: string;
	kind: string;
	detail: string;
}

export async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
	await app.evaluate(
		({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
		{ width, height },
	);
}

/** Text clipped without an ellipsis and controls overflowing their window. */
export async function inspect(page: Page, shot: string): Promise<Finding[]> {
	const found = await page.evaluate(() => {
		const out: { kind: string; detail: string }[] = [];
		const describe = (element: Element) => {
			const label = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60) ?? "";
			return `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.split(" ").slice(0, 3).join(".")}` : ""} "${label}"`;
		};
		if (document.documentElement.scrollWidth > innerWidth + 1)
			out.push({ kind: "page-overflow", detail: `${document.documentElement.scrollWidth} > ${innerWidth}` });
		for (const element of document.querySelectorAll("button, [role=menuitem], [role=option], a, h1, h2, h3, label")) {
			const box = element.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			const style = getComputedStyle(element);
			if (style.visibility === "hidden") continue;
			if (box.right > innerWidth + 1 || box.left < -1)
				out.push({
					kind: "offscreen",
					detail: `${describe(element)} x=${Math.round(box.left)}..${Math.round(box.right)}`,
				});
			const overflowing = element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0;
			if (overflowing && style.textOverflow !== "ellipsis" && style.overflowX === "hidden")
				out.push({ kind: "clipped", detail: describe(element) });
		}
		// Popups stay inside the window and never cover the control that opened them.
		const trigger = document.querySelector('[aria-expanded="true"][aria-haspopup]');
		for (const popup of document.querySelectorAll(
			"[role=menu], [role=listbox], [role=dialog], [role=status], [role=alert]",
		)) {
			const box = popup.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1)
				out.push({
					kind: "popup-outside",
					detail: `${describe(popup)} ${Math.round(box.left)},${Math.round(box.top)}..${Math.round(box.right)},${Math.round(box.bottom)} in ${innerWidth}x${innerHeight}`,
				});
			if (popup.getAttribute("role") !== "menu" || !trigger) continue;
			const anchor = trigger.getBoundingClientRect();
			const overlapX = Math.min(box.right, anchor.right) - Math.max(box.left, anchor.left);
			const overlapY = Math.min(box.bottom, anchor.bottom) - Math.max(box.top, anchor.top);
			if (overlapX > 2 && overlapY > 2) out.push({ kind: "menu-covers-trigger", detail: describe(trigger) });
		}
		// Reduced motion: nothing animates longer than a frame.
		if (matchMedia("(prefers-reduced-motion: reduce)").matches)
			for (const animation of document.getAnimations()) {
				const timing = animation.effect?.getComputedTiming();
				const duration = typeof timing?.duration === "number" ? timing.duration : 0;
				if (animation.playState === "running" && duration > 20 && timing?.iterations !== Number.POSITIVE_INFINITY) {
					const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
					out.push({
						kind: "motion-under-reduce",
						detail: `${target ? describe(target) : "?"} ${Math.round(duration)}ms ${animation instanceof CSSAnimation ? animation.animationName : animation instanceof CSSTransition ? animation.transitionProperty : ""}`,
					});
				}
			}
		return out;
	});
	return found.map(entry => ({ shot, ...entry }));
}

export function capturer(page: Page, directory: string | undefined, prefix: string, findings: Finding[]) {
	let index = 0;
	return async (name: string) => {
		if (!directory) return;
		index += 1;
		const shot = `${prefix}-${String(index).padStart(2, "0")}-${name}`;
		await page.screenshot({ path: path.join(directory, `${shot}.png`), scale: "css", animations: "disabled" });
		findings.push(...(await inspect(page, shot)));
	};
}
