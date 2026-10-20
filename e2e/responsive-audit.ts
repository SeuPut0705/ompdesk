import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Browser, devices, expect, type Page } from "@playwright/test";

// The responsive audit: a named list of surfaces (e2e/responsive-surfaces.ts) opened on the dev harness
// (harness.html) at every phone and tablet width, measured in the page, written to <dir>/looks/*.json and merged
// into <dir>/report.json + <dir>/summary.md. Registered by e2e/responsive-audit.e2e.ts only with
// OMP_GUI_RESPONSIVE=<dir>; the default run's one smoke (e2e/responsive-smoke.e2e.ts) reuses `openLook`/`measure`.
//
// A "look" is one viewport × theme × language × device. Widths 320, 360, 390, 412 (DPR 3.5) are portrait phones; 768,
// 834 and 1024 are tablets in portrait (height = 1.4 × width) and landscape (height = 0.72 × width), 1133, 1180 and
// 1366 iPads held sideways, all with touch; 1100, 1280, 1440 and 1920 are desktop windows with a mouse, once as the
// web client and once painted as an Electron window. Dark is run at 390 and 1280.

export type IssueKind =
	| "overflow-page" // the document scrolls sideways
	| "overflow-el" // an element escapes the viewport and no clipping or scrolling ancestor holds it
	| "overflow-sideways" // a vertical list that must never scroll sideways (the work board) is wider than its box
	| "truncated" // an ellipsis on a control, heading, tab or label, where the full text is required
	| "clipped" // text cut by an overflow-hidden ancestor, or spilling out of its own box
	| "offscreen-popover" // a dialog, menu, listbox, tooltip or toast partly outside the viewport
	| "small-target" // a visible control whose hit box is under 44 px (40 on a list row, 36 on a field)
	| "small-text" // text under 11.5 px (after an SVG's own scale)
	| "overlap" // two interactive elements drawn over each other
	| "stolen-tap" // a point of a control's 44 px hit box resolves to another control, or to nothing
	| "safe-area"; // a control or text under the notch, the home indicator or a rounded corner

export const ISSUE_KINDS: readonly IssueKind[] = [
	"overflow-page",
	"overflow-el",
	"overflow-sideways",
	"truncated",
	"clipped",
	"offscreen-popover",
	"small-target",
	"small-text",
	"overlap",
	"stolen-tap",
	"safe-area",
];

/** How much one issue of a kind costs when surfaces are ranked: a sideways scroll hurts more than a 11 px caption. */
export const KIND_WEIGHT: Record<IssueKind, number> = {
	"overflow-page": 10,
	"offscreen-popover": 8,
	"overflow-el": 5,
	"overflow-sideways": 8,
	clipped: 4,
	overlap: 4,
	"stolen-tap": 5,
	"safe-area": 3,
	truncated: 2,
	"small-target": 1,
	"small-text": 0.5,
};

export interface Issue {
	kind: IssueKind;
	/** A short CSS-like path of the element. */
	at: string;
	/** What is wrong, in numbers. */
	detail: string;
}

export interface Look {
	width: number;
	height: number;
	dpr: number;
	orientation: "portrait" | "landscape";
	theme: "light" | "dark";
	lang: "en" | "ko";
	/**
	 * What draws the page: `touch` (default) a phone or tablet browser, `web` the web client in a desktop browser with
	 * a mouse, `electron` the harness painted as an Electron window (`?platform=darwin`: desktop layout, no mobile
	 * shell). Hit areas and safe areas are touch rules, so the two desktop devices are not measured for them.
	 */
	device?: "touch" | "web" | "electron";
}

const DEVICE_MARK: Record<NonNullable<Look["device"]>, string> = { touch: "", web: "W", electron: "E" };

/** The look's column in the summary: width, then L (touch landscape), W (desktop web) or E (Electron window). */
export const lookColumn = (look: Look): string =>
	`${look.width}${look.device && look.device !== "touch" ? DEVICE_MARK[look.device] : look.orientation === "landscape" ? "L" : ""}`;

export const lookTag = (look: Look): string =>
	`${look.width}${look.device && look.device !== "touch" ? DEVICE_MARK[look.device] : look.orientation === "landscape" ? "L" : "P"}-${look.theme}-${look.lang}`;

const PHONE_WIDTHS = [320, 360, 390, 412] as const;
const TABLET_WIDTHS = [768, 834, 1024] as const;
const PHONE_HEIGHT: Record<number, number> = { 320: 640, 360: 740, 390: 844, 412: 915 };
/** iPad mini, iPad Air 11" and iPad Pro 12.9" sideways. */
const IPAD_LANDSCAPE = [
	[1133, 744],
	[1180, 820],
	[1366, 1024],
] as const;
/** Desktop windows, each as the web client in a desktop browser and as an Electron window. */
const DESKTOP = [
	[1100, 800],
	[1280, 800],
	[1440, 900],
	[1920, 1080],
] as const;
/** Widths that also run dark: a phone and a desktop window. */
const DARK_WIDTHS = new Set([390, 1280]);

/** Every look the full matrix visits; `filter` narrows it by env (`OMP_GUI_RESPONSIVE_WIDTHS`, `_LANGS`, `_THEMES`). */
export function looksFor(
	filter: {
		widths?: number[];
		langs?: Look["lang"][];
		themes?: Look["theme"][];
		orientations?: string[];
		devices?: string[];
	} = {},
): Look[] {
	const looks: Look[] = [];
	const langs = filter.langs ?? ["en", "ko"];
	const themes = filter.themes ?? ["light", "dark"];
	const add = (
		width: number,
		height: number,
		orientation: Look["orientation"],
		dpr: number,
		device: NonNullable<Look["device"]> = "touch",
	) => {
		if (filter.widths && !filter.widths.includes(width)) return;
		if (filter.orientations && !filter.orientations.includes(orientation)) return;
		if (filter.devices && !filter.devices.includes(device)) return;
		for (const theme of themes) {
			if (theme === "dark" && !DARK_WIDTHS.has(width)) continue;
			for (const lang of langs)
				looks.push({ width, height, dpr, orientation, theme, lang, ...(device === "touch" ? {} : { device }) });
		}
	};
	for (const width of PHONE_WIDTHS) add(width, PHONE_HEIGHT[width] ?? 844, "portrait", width === 412 ? 3.5 : 3);
	for (const width of TABLET_WIDTHS) {
		add(width, Math.round(width * 1.4), "portrait", 2);
		add(width, Math.round(width * 0.72), "landscape", 2);
	}
	// iPads held sideways: wide enough that the work board docks beside the transcript (work-board.ts
	// `workBoardDocks`), so the docked board is measured at a tablet's touch sizes too.
	for (const [width, height] of IPAD_LANDSCAPE) add(width, height, "landscape", 2);
	for (const [width, height] of DESKTOP) {
		add(width, height, "landscape", 2, "web");
		add(width, height, "landscape", 2, "electron");
	}
	return looks;
}

/** Whether the look's main input is a finger: hit areas and the hardware insets are measured only then. */
export const touchLook = (look: Look): boolean => (look.device ?? "touch") === "touch";

/** Safe-area insets a device of this size has (CSS px): an iPhone's notch and home bar, an iPad's rounded corners. */
export function safeInsets(look: Look): { t: number; r: number; b: number; l: number } {
	if (!touchLook(look)) return { t: 0, r: 0, b: 0, l: 0 };
	if (look.width < 600) return { t: 47, r: 0, b: 34, l: 0 };
	return { t: 24, r: 0, b: 20, l: 0 };
}

export interface OpenOptions {
	/** Extra query string (`&stress=1&pwa=push`). */
	query?: string;
	/** The origin serving harness.html. */
	origin: string;
}

/** A fresh page of the harness at `look`, with the device's safe areas applied, once the shell has painted. */
export async function openLook(browser: Browser, look: Look, options: OpenOptions): Promise<Page> {
	const touch = touchLook(look);
	const context = await browser.newContext({
		...(touch ? devices["iPhone 15"] : devices["Desktop Chrome"]),
		viewport: { width: look.width, height: look.height },
		deviceScaleFactor: look.dpr,
		isMobile: touch,
		hasTouch: touch,
		reducedMotion: "reduce",
	});
	const page = await context.newPage();
	// A surface whose control is missing fails in seconds (reported as failed), never hangs the sweep.
	page.setDefaultTimeout(8_000);
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	// React logs a render error the boundary caught to the console; the crash screen's cause is in these.
	page.on("console", message => {
		if (message.type() === "error") errors.push(message.text().slice(0, 240));
	});
	Object.assign(page, { auditErrors: errors });
	await page.goto(
		`${options.origin}/harness.html?theme=${look.theme}&lang=${look.lang}&rail=all&stress=1${look.device === "electron" ? "&platform=darwin" : ""}${options.query ?? ""}`,
		{ timeout: 90_000 },
	);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 45_000 });
	await page.waitForFunction(() => window.__stores !== undefined, undefined, { timeout: 45_000 });
	const inset = safeInsets(look);
	await page.addStyleTag({
		content: `:root:root{--safe-t:${inset.t}px;--safe-r:${inset.r}px;--safe-b:${inset.b}px;--safe-l:${inset.l}px}`,
	});
	return page;
}

/** What the page's error and console-error handlers saw so far. */
export function pageErrors(page: Page): string[] {
	return (page as unknown as { auditErrors?: string[] }).auditErrors ?? [];
}

/** Whether the app's root error boundary is on screen ("Reload interface"): the surface crashed the renderer. */
export async function crashed(page: Page): Promise<boolean> {
	return (await page.getByText(/Reload interface|인터페이스 다시 불러오기/).count()) > 0;
}

/**
 * Close whatever a surface opened: every open flag of the ui store goes back to its initial value, the toasts and
 * cards go, Escape presses away a popover. Returns false when something modal is still on screen (the caller then
 * reloads the page).
 */
export async function resetPage(page: Page): Promise<boolean> {
	await page.evaluate(() => {
		const stores = window.__stores;
		if (!stores) return;
		const ui = stores.ui as unknown as {
			getState(): Record<string, unknown>;
			getInitialState(): Record<string, unknown>;
			setState(partial: Record<string, unknown>): void;
		};
		const initial = ui.getInitialState();
		const current = ui.getState();
		const patch: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(initial)) {
			if (typeof value === "function" || value === current[key]) continue;
			if (value === false || value === null || key === "destination" || key === "panelTab") patch[key] = value;
		}
		ui.setState(patch);
		const toast = stores.toast as unknown as { setState(partial: unknown): void };
		toast.setState({ toasts: [] });
		// What the other surfaces leave in front of the session: ask/approval cards, a plan, host sheets, a banner.
		const call = (store: string, action: string) => {
			const state = stores[store]?.getState() as Record<string, (() => void) | undefined> | undefined;
			state?.[action]?.();
		};
		call("extensionUi", "clearAll");
		call("planApproval", "clearProposal");
		call("hostUi", "reset");
		stores.updater?.setState({ status: { state: "idle" } });
	});
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	const dialogs = await page
		.locator('[role="dialog"]:visible, [role="menu"]:visible, [role="listbox"]:visible, [data-drawer]:visible')
		.count();
	return dialogs === 0;
}

/** Measure the page as it is now. */
export async function measure(page: Page, look: Look): Promise<Issue[]> {
	// Typing into or clicking a control scrolls its overflow-hidden ancestors to show it (the session pane, the
	// page); the user never sees that shift as a layout, so measure from the unscrolled layout.
	await page.evaluate(() => {
		for (const element of document.querySelectorAll<HTMLElement>("*")) {
			if (element.scrollTop === 0 && element.scrollLeft === 0) continue;
			const computed = getComputedStyle(element);
			if (computed.overflowX === "hidden" || computed.overflowY === "hidden" || computed.overflow === "clip") {
				element.scrollTop = 0;
				element.scrollLeft = 0;
			}
		}
		window.scrollTo(0, 0);
	});
	return page.evaluate(measureInPage, { safe: safeInsets(look), touch: touchLook(look) });
}

/** Runs in the page (serialized by Playwright): nothing outside this function is in scope there. */
function measureInPage(options: { safe: { t: number; r: number; b: number; l: number }; touch: boolean }): Issue[] {
	const issues: Issue[] = [];
	const vw = document.documentElement.clientWidth;
	const vh = window.innerHeight;
	const cap: Record<string, number> = {};
	const CAP = 14;

	const describe = (element: Element): string => {
		const parts: string[] = [];
		let node: Element | null = element;
		for (let depth = 0; node && node !== document.body && depth < 4; depth++, node = node.parentElement) {
			let part = node.tagName.toLowerCase();
			if (node.id) part += `#${node.id.slice(0, 24)}`;
			const marks = [...node.attributes]
				.filter(attribute => attribute.name.startsWith("data-") && attribute.name !== "data-state")
				.slice(0, 1)
				.map(attribute => `[${attribute.name}]`);
			part += marks.join("");
			const classes = String(node.getAttribute("class") ?? "")
				.split(/\s+/)
				.filter(name => name.startsWith("omp-") || name.startsWith("settings-") || name.startsWith("sc-"))
				.slice(0, 2);
			if (classes.length > 0) part += `.${classes.join(".")}`;
			parts.unshift(part);
			if (node.id || node.hasAttribute("role") || node.hasAttribute("aria-label")) {
				if (depth > 0) break;
			}
		}
		const label = element.getAttribute("aria-label") ?? element.textContent?.trim().replace(/\s+/g, " ").slice(0, 28);
		return `${parts.join(" > ")}${label ? ` "${label}"` : ""}`;
	};
	const push = (kind: IssueKind, element: Element, detail: string) => {
		cap[kind] = (cap[kind] ?? 0) + 1;
		issues.push({ kind, at: describe(element), detail });
	};

	const style = (element: Element) => getComputedStyle(element);
	/** In the layout and painted: sized, not display:none, not visibility:hidden, not transparent. */
	const shown = (element: Element): boolean => {
		const rect = element.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return false;
		for (let node: Element | null = element; node; node = node.parentElement) {
			const computed = style(node);
			if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
			if (node.hasAttribute("inert")) return false;
		}
		return true;
	};
	/** Text meant for screen readers only: a clipped 1 px box. */
	const srOnly = (element: Element): boolean => {
		for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
			const rect = node.getBoundingClientRect();
			if (rect.width <= 1.5 && rect.height <= 1.5 && style(node).overflow !== "visible") return true;
			if (node.classList.contains("sr-only")) return true;
		}
		return false;
	};
	const inSvg = (element: Element) => element instanceof SVGElement && !(element instanceof SVGSVGElement);

	const all = [...document.body.querySelectorAll("*")].filter(
		element => !["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"].includes(element.tagName),
	);
	/**
	 * Something that is not this element, and not part of it, is on top at its centre: a dialog's backdrop over the
	 * page, a sheet over the transcript. What a layer hides is not measured as part of the surface in front of it.
	 */
	const covered = (element: Element): boolean => {
		const rect = element.getBoundingClientRect();
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
		const top = document.elementFromPoint(x, y);
		if (!top || element.contains(top) || top.contains(element) || top.closest("label")?.contains(element))
			return false;
		// A neighbouring control on top is a stolen tap, which the hit test reports; a layer on top hides the element.
		const layer = top.closest(
			"[role='presentation'], [data-drawer-scrim], [data-scrim], [aria-modal='true'], [role='dialog'], [role='menu'], [role='listbox'], [data-action-sheet], [data-work-strip-panel]",
		);
		return (
			!!layer ||
			!top.closest(
				"button, a[href], input, select, textarea, summary, [role='button'], [role='tab'], [role='switch'], [role='option'], [role='menuitem']",
			)
		);
	};

	// ── Page overflow and escaping elements ─────────────────────────────────────────────────────────
	const doc = document.documentElement;
	const pageOverflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth;
	if (pageOverflow > 1) push("overflow-page", doc, `scrolls sideways by ${pageOverflow}px (viewport ${vw})`);

	/** The nearest ancestor that clips or scrolls on x and whose own box is inside the viewport: it holds the element. */
	const heldByAncestor = (element: Element): boolean => {
		for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
			const computed = style(node);
			if (computed.overflowX === "visible") continue;
			const rect = node.getBoundingClientRect();
			if (rect.right <= vw + 1 && rect.left >= -1) return true;
		}
		return false;
	};
	for (const element of all) {
		if (inSvg(element) || srOnly(element)) continue;
		const rect = element.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue;
		const escapesRight = rect.right > vw + 1;
		const escapesLeft = rect.left < -1 && rect.right > 1;
		if (!escapesRight && !escapesLeft) continue;
		if (!shown(element)) continue;
		if (element.closest("[aria-hidden='true']") && style(element).position === "fixed") continue;
		if (element.closest(".xterm-helpers, .xterm-screen, [data-sheet-handle]")) continue;
		if (heldByAncestor(element)) continue;
		// A parent that also escapes is the culprit; report each box once, the outermost.
		const parent = element.parentElement;
		if (parent && parent !== document.body) {
			const parentRect = parent.getBoundingClientRect();
			if ((parentRect.right > vw + 1 || parentRect.left < -1) && !heldByAncestor(parent) && shown(parent)) continue;
		}
		if (cap["overflow-el"] >= CAP) continue;
		push(
			"overflow-el",
			element,
			escapesRight ? `right edge ${Math.round(rect.right)} > ${vw}` : `left edge ${Math.round(rect.left)} < 0`,
		);
	}

	// ── Vertical lists that never scroll sideways ──────────────────────────────────────────────────
	// The work board (docked, and inside the phone strip) scrolls down only: a row wider than it (a branch, a path,
	// a title that does not truncate) gives it a horizontal scrollbar, which no viewport check sees.
	for (const list of document.querySelectorAll("[data-work-board-panel], .omp-work-strip-body")) {
		if (!shown(list)) continue;
		const extra = list.scrollWidth - list.clientWidth;
		if (extra > 1) push("overflow-sideways", list, `scrolls sideways by ${extra}px (box ${list.clientWidth})`);
	}

	// ── Text: truncated, clipped, small ─────────────────────────────────────────────────────────────
	/** A control, heading or tab whose full text is required; a row of a list may truncate (the full text is one tap away). */
	const labelish = (element: Element) =>
		!!element.closest(
			'button, a, label, summary, h1, h2, h3, h4, h5, h6, th, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="switch"], [role="heading"], [role="dialog"] > header, [data-label-required]',
		) && !element.closest(".omp-list-row, li, td, [role='option'], [data-model-option], [data-list-item]");
	/** The nearest ancestor that scrolls vertically (content longer than its box). */
	const scrollerOf = (element: Element): Element | null => {
		for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
			const overflowY = style(node).overflowY;
			if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
		}
		return null;
	};
	const ownText = (element: Element): Text[] =>
		[...element.childNodes].filter(
			(node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
		);
	for (const element of all) {
		const texts = ownText(element);
		if (texts.length === 0) continue;
		if (!shown(element) || srOnly(element) || covered(element)) continue;
		const computed = style(element);
		const rect = element.getBoundingClientRect();
		// Small text: an SVG's text is measured through its own scale.
		let size = Number.parseFloat(computed.fontSize);
		if (element instanceof SVGGraphicsElement) size *= element.getScreenCTM()?.a ?? 1;
		if (size < 11.5 && !element.closest("[data-audit-ignore], .xterm")) {
			push("small-text", element, `${size.toFixed(1)}px`);
		}
		const overflowsBox = element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0;
		const clamp = computed.webkitLineClamp !== "none" && computed.webkitLineClamp !== "";
		if (computed.textOverflow === "ellipsis" && overflowsBox) {
			if (labelish(element))
				push("truncated", element, `${element.scrollWidth}px of text in ${element.clientWidth}px`);
		} else if (clamp && element.scrollHeight > element.clientHeight + 1) {
			if (labelish(element))
				push("truncated", element, `line-clamp cuts ${element.scrollHeight - element.clientHeight}px`);
		} else if (
			overflowsBox &&
			(computed.overflowX === "hidden" || computed.overflowX === "clip") &&
			computed.whiteSpace !== "pre" &&
			!element.closest("pre, code, table, [data-scroll-x]")
		) {
			push("clipped", element, `${element.scrollWidth}px of content in ${element.clientWidth}px, hidden`);
		} else if (
			computed.overflowX === "visible" &&
			(computed.whiteSpace === "nowrap" || computed.whiteSpace === "pre") &&
			!element.closest("pre, code, table")
		) {
			// Single-line text that paints beyond its own box.
			const range = document.createRange();
			range.selectNodeContents(element);
			const text = range.getBoundingClientRect();
			const box = element.getBoundingClientRect();
			if (text.right > box.right + 2 && box.width > 0 && !heldByAncestor(element)) {
				push("clipped", element, `text runs ${Math.round(text.right - box.right)}px past its box`);
			}
		}
		void rect;
	}

	// ── Popovers, menus, dialogs, tooltips, toasts ──────────────────────────────────────────────────
	const floating = document.querySelectorAll(
		'[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [role="alert"], [role="status"], [data-sheet-panel], [data-drawer]',
	);
	for (const element of floating) {
		if (!shown(element) || srOnly(element)) continue;
		// An inline notice is role=status too; only a status or alert pinned to the screen (a toast) is floating.
		if (element.matches('[role="alert"], [role="status"]')) {
			// A toast stack is a portal: a direct child of <body> other than the app root, and fixed.
			let top: Element = element;
			while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
			const pinned = top.id !== "root" && ["fixed", "absolute"].includes(style(top).position);
			if (!pinned) continue;
		}
		const rect = element.getBoundingClientRect();
		if (rect.width < 2 || rect.height < 2) continue;
		// A dialog's wrapper that spans the viewport is the overlay, not a floating box.
		const over = [
			rect.left < -1 ? `left ${Math.round(rect.left)}` : "",
			rect.right > vw + 1 ? `right ${Math.round(rect.right)}>${vw}` : "",
			rect.top < -1 ? `top ${Math.round(rect.top)}` : "",
			rect.bottom > vh + 1 ? `bottom ${Math.round(rect.bottom)}>${vh}` : "",
		].filter(Boolean);
		if (over.length > 0) push("offscreen-popover", element, over.join(", "));
	}

	// ── Tap targets, overlaps and stolen taps ───────────────────────────────────────────────────────
	/** The part of the element a scroller or clipping ancestor lets through (null when none of it shows). */
	interface Box {
		left: number;
		top: number;
		right: number;
		bottom: number;
	}
	const visibleRect = (element: Element): Box | null => {
		const own = element.getBoundingClientRect();
		let left = Math.max(own.left, 0);
		let top = Math.max(own.top, 0);
		let right = Math.min(own.right, vw);
		let bottom = Math.min(own.bottom, vh);
		for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
			const computed = style(node);
			if (computed.overflowX === "visible" && computed.overflowY === "visible") continue;
			const box = node.getBoundingClientRect();
			if (computed.overflowX !== "visible") {
				left = Math.max(left, box.left);
				right = Math.min(right, box.right);
			}
			if (computed.overflowY !== "visible") {
				top = Math.max(top, box.top);
				bottom = Math.min(bottom, box.bottom);
			}
		}
		return right - left > 0.5 && bottom - top > 0.5 ? { left, top, right, bottom } : null;
	};
	const controlSelector =
		'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [role="tab"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="checkbox"], [role="radio"], [role="slider"], [contenteditable="true"]';
	const controls: Element[] = [];
	for (const element of document.querySelectorAll(controlSelector)) {
		if ((element as HTMLButtonElement).disabled) continue;
		if (element.closest("[aria-hidden='true'], [inert], .xterm, [data-sheet-handle]")) continue;
		if (!shown(element) || srOnly(element) || !visibleRect(element) || covered(element)) continue;
		controls.push(element);
	}
	const hitBox = (element: Element): { width: number; height: number; row: boolean; field: boolean } => {
		const row = element.closest(".omp-list-row") ?? (element.matches('[role="option"]') ? element : null);
		// The composer's textarea is one target with the box around it.
		const composer = element.matches("[data-composer-input]") ? element.closest(".omp-composer-box") : null;
		const field =
			element instanceof HTMLInputElement ||
			element instanceof HTMLSelectElement ||
			(element instanceof HTMLTextAreaElement && !composer);
		const label =
			element instanceof HTMLInputElement && /checkbox|radio/.test(element.type) ? element.closest("label") : null;
		const own = (row ?? composer ?? label ?? element).getBoundingClientRect();
		const after = getComputedStyle(element, "::after");
		const reach = !row && !field && after.content !== "none" && after.position === "absolute";
		return {
			width: Math.max(own.width, reach ? Number.parseFloat(after.width) || 0 : 0),
			height: Math.max(own.height, reach ? Number.parseFloat(after.height) || 0 : 0),
			row: !!row,
			field,
		};
	};
	// A mouse needs no 44 px reach: hit areas and stolen taps are measured for touch looks only.
	for (const element of options.touch ? controls : []) {
		// A link inside a sentence is exempt.
		if (element instanceof HTMLAnchorElement && style(element).display === "inline") continue;
		const hit = hitBox(element);
		// A cluster that declares `--hit-gap-x|y` (mobile.css) splits the reach between neighbours on purpose.
		const bounded =
			style(element).getPropertyValue("--hit-gap-x").trim() !== "" ||
			style(element).getPropertyValue("--hit-gap-y").trim() !== "";
		const need = hit.row ? 39.5 : hit.field || bounded ? 35.5 : 43.5;
		if (Math.min(hit.width, hit.height) < need) {
			push("small-target", element, `${Math.round(hit.width)}×${Math.round(hit.height)} (need ${Math.ceil(need)})`);
		}
	}
	// Overlap: two controls' visible boxes cross, neither holds the other, and both are on top where they meet.
	const boxes = controls
		.map(element => ({ element, rect: visibleRect(element) }))
		.filter(
			(entry): entry is { element: Element; rect: Box } =>
				entry.rect !== null && entry.rect.right - entry.rect.left > 4 && entry.rect.bottom - entry.rect.top > 4,
		);
	for (let i = 0; i < boxes.length && (cap.overlap ?? 0) < CAP; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i];
			const b = boxes[j];
			if (!a || !b) continue;
			if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
			const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
			const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
			if (width < 4 || height < 4) continue;
			const smaller = Math.min(
				(a.rect.right - a.rect.left) * (a.rect.bottom - a.rect.top),
				(b.rect.right - b.rect.left) * (b.rect.bottom - b.rect.top),
			);
			if ((width * height) / smaller < 0.2) continue;
			// One box inside the other (an action over its stretched row) is a layered control, not a collision.
			if ((width * height) / smaller > 0.95) continue;
			const x = Math.max(a.rect.left, b.rect.left) + width / 2;
			const y = Math.max(a.rect.top, b.rect.top) + height / 2;
			const top = document.elementFromPoint(x, y);
			if (
				!top ||
				!(a.element.contains(top) || b.element.contains(top) || top.contains(a.element) || top.contains(b.element))
			)
				continue;
			// A label wrapping an input, or two parts of one control (a switch and its label), are one target.
			if (a.element.closest("label") && a.element.closest("label") === b.element.closest("label")) continue;
			push("overlap", a.element, `crosses ${describe(b.element)} by ${Math.round(width)}×${Math.round(height)}`);
			break;
		}
	}
	// Stolen taps: nine points across each control's hit box (the visual box grown by its ::after, centred); a point
	// that resolves to another control, or to nothing, is a tap the user aims at this control and loses.
	for (const element of options.touch ? controls : []) {
		if ((cap["stolen-tap"] ?? 0) >= CAP) break;
		if (element instanceof HTMLAnchorElement && style(element).display === "inline") continue;
		const hit = hitBox(element);
		if (hit.row) continue;
		const own = element.getBoundingClientRect();
		const clip = visibleRect(element);
		if (!clip) continue;
		const cx = own.left + own.width / 2;
		const cy = own.top + own.height / 2;
		// A field has no ::after: its hit box is its own box (the composer's input too, whatever box wraps it).
		const ownOnly = hit.field || element.matches("[data-composer-input]");
		const halfW = (ownOnly ? own.width : Math.max(hit.width, own.width)) / 2 - 1.5;
		const halfH = (ownOnly ? own.height : Math.max(hit.height, own.height)) / 2 - 1.5;
		const points: Array<[number, number, string]> = [
			[cx, cy, "centre"],
			[cx, cy - halfH, "top"],
			[cx, cy + halfH, "bottom"],
			[cx - halfW, cy, "left"],
			[cx + halfW, cy, "right"],
			[cx - halfW, cy - halfH, "top-left"],
			[cx + halfW, cy - halfH, "top-right"],
			[cx - halfW, cy + halfH, "bottom-left"],
			[cx + halfW, cy + halfH, "bottom-right"],
		];
		const label = element.closest("label");
		const lost: string[] = [];
		let thief = "";
		for (const [x, y, name] of points) {
			// Only the part of the box that is on screen and inside the clipping ancestors can be tapped.
			if (x < 0 || y < 0 || x > vw || y > vh) continue;
			const topEl = document.elementFromPoint(x, y);
			if (!topEl || element.contains(topEl) || label?.contains(topEl)) continue;
			// Inside the control's own scroller bounds only: a point past the clip belongs to the clipper.
			const owner = topEl.closest(controlSelector);
			if (owner && (owner.contains(element) || element.contains(owner))) continue;
			if (!owner && (ownOnly || x < clip.left || x > clip.right || y < clip.top || y > clip.bottom)) continue;
			// A bar or chip floating over a scroller covers content that scrolls under it by design.
			const scroller = scrollerOf(element);
			if (owner && scroller && !scroller.contains(owner)) continue;
			lost.push(name);
			if (!thief) thief = owner ? describe(owner) : `nothing (${describe(topEl)})`;
		}
		if (lost.length > 0) push("stolen-tap", element, `${lost.length}/9 points (${lost.join(", ")}) → ${thief}`);
	}

	// ── Safe areas ──────────────────────────────────────────────────────────────────────────────────
	const { t, r, b, l } = options.safe;
	const bands = (rect: { left: number; top: number; right: number; bottom: number }): string[] => {
		const found: string[] = [];
		if (t > 0 && rect.top < t - 1 && rect.bottom > 2) found.push(`top ${Math.round(t - rect.top)}px`);
		if (b > 0 && rect.bottom > vh - b + 1 && rect.top < vh - 2)
			found.push(`bottom ${Math.round(rect.bottom - (vh - b))}px`);
		if (l > 0 && rect.left < l - 1 && rect.right > 2) found.push(`left ${Math.round(l - rect.left)}px`);
		if (r > 0 && rect.right > vw - r + 1 && rect.left < vw - 2)
			found.push(`right ${Math.round(rect.right - (vw - r))}px`);
		return found;
	};
	const seen = new Set<Element>();
	for (const element of [
		...controls,
		...all.filter(
			candidate => ownText(candidate).length > 0 && shown(candidate) && !srOnly(candidate) && !covered(candidate),
		),
	]) {
		if (seen.has(element)) continue;
		seen.add(element);
		if (cap["safe-area"] >= CAP) break;
		if (element.closest(".xterm, [data-drawer-scrim], [role='tooltip']")) continue;
		const rect = visibleRect(element);
		if (!rect) continue;
		// Content in a scroller passes through the inset band as it scrolls; a fixed bar or panel must stay clear.
		if (scrollerOf(element)) continue;
		const found = bands(rect);
		if (found.length > 0) push("safe-area", element, `under the ${found.join(", ")} inset`);
	}

	return issues;
}

export interface SurfaceResult {
	surface: string;
	area: "A" | "B";
	look: Look;
	/** Set when the surface could not be opened (its error), so the report shows a gap rather than a clean pass. */
	failed?: string;
	counts: Partial<Record<IssueKind, number>>;
	score: number;
	issues: Issue[];
	/** Density figures (`measureDensity`), only on the idle session surface. */
	metrics?: Density;
}

/** How much of the screen the chrome takes and how tight the transcript sits, at the idle session. */
export interface Density {
	/** Height of the app's header, in px, below the top safe area (the transcript scroller's top edge minus the inset). */
	header: number;
	/** Height under the transcript — dock cards and composer — above the bottom safe area. */
	bottom: number;
	/** The simulated hardware insets (notch + home bar) inside those two edges, not counted in the share. */
	insets: number;
	/** The composer box itself. */
	composer: number;
	/** App chrome: (header + bottom) / viewport height, in percent, insets excluded. The smoke gates this at ≤ 22 % (AGENTS.md phone budget; the status chip row is part of it). */
	chromeShare: number;
	/** Smallest distance from a screen edge to a transcript row's text, left and right. */
	gutter: number;
	/** Body text size of the first prose row, in px. */
	bodyFont: number;
}

/** The idle session's chrome share and gutters (the phone targets: share ≤ 22 %, gutter ≤ 16 px, body 13–15 px). */
export async function measureDensity(page: Page, look: Look): Promise<Density | undefined> {
	return page.evaluate((inset): Density | undefined => {
		const rows = [...document.querySelectorAll<HTMLElement>("[data-transcript-kind]")];
		const first = rows[0];
		if (!first) return undefined;
		let scroller: HTMLElement | null = first.parentElement;
		while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
		if (!scroller) return undefined;
		const vw = document.documentElement.clientWidth;
		const vh = window.innerHeight;
		const box = scroller.getBoundingClientRect();
		const composer = (
			document.querySelector(".omp-composer-box") ?? document.querySelector("[data-composer-mode]")
		)?.getBoundingClientRect();
		let gutter = Number.POSITIVE_INFINITY;
		let bodyFont = 0;
		for (const row of rows) {
			const rect = row.getBoundingClientRect();
			if (rect.bottom < box.top || rect.top > box.bottom) continue;
			const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (!(node.textContent ?? "").trim() || !node.parentElement) continue;
				const range = document.createRange();
				range.selectNodeContents(node);
				const inside = node.parentElement.closest("pre, table, [data-figure]");
				if (inside) continue;
				const text = range.getBoundingClientRect();
				if (text.width === 0) continue;
				gutter = Math.min(gutter, Math.max(text.left, 0), Math.max(vw - text.right, 0));
				if (!bodyFont && node.parentElement.closest("p, li"))
					bodyFont = Number.parseFloat(getComputedStyle(node.parentElement).fontSize);
			}
		}
		const topInset = Math.min(inset.t, box.top);
		const bottomInset = Math.min(inset.b, vh - box.bottom);
		const header = Math.round(box.top - topInset);
		const bottom = Math.round(vh - box.bottom - bottomInset);
		return {
			header,
			bottom,
			insets: Math.round(topInset + bottomInset),
			composer: Math.round(composer?.height ?? 0),
			chromeShare: Math.round(((header + bottom) / vh) * 1000) / 10,
			gutter: Math.round(Number.isFinite(gutter) ? gutter : 0),
			bodyFont,
		};
	}, safeInsets(look));
}

export function summarize(
	surface: { id: string; area: "A" | "B" },
	look: Look,
	issues: Issue[],
	failed?: string,
	metrics?: Density,
): SurfaceResult {
	const counts: Partial<Record<IssueKind, number>> = {};
	let score = 0;
	for (const issue of issues) {
		counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
		score += KIND_WEIGHT[issue.kind];
	}
	return { surface: surface.id, area: surface.area, look, failed, counts, score, issues, metrics };
}

const totalOf = (result: SurfaceResult): number =>
	Object.values(result.counts).reduce((sum, count) => sum + (count ?? 0), 0);

/** Write one look's results; the merge below reads every look file. */
export async function writeLook(dir: string, look: Look, results: SurfaceResult[]): Promise<void> {
	await fs.mkdir(path.join(dir, "looks"), { recursive: true });
	const file = path.join(dir, "looks", `${lookTag(look)}.json`);
	await fs.writeFile(`${file}.tmp`, JSON.stringify(results));
	await fs.rename(`${file}.tmp`, file);
}

/** Merge every look file of `dir` into report.json (all results) and summary.md (ranked counts). */
export async function mergeReport(
	dir: string,
): Promise<{ total: number; score: number; byArea: Record<string, number> }> {
	const names = (await fs.readdir(path.join(dir, "looks")).catch(() => [])).filter(name => name.endsWith(".json"));
	const results: SurfaceResult[] = [];
	for (const name of names) {
		const text = await fs.readFile(path.join(dir, "looks", name), "utf8").catch(() => "[]");
		try {
			results.push(...(JSON.parse(text) as SurfaceResult[]));
		} catch {
			// A look file being renamed into place mid-read: the next merge has it.
		}
	}
	const total = results.reduce((sum, result) => sum + totalOf(result), 0);
	const score = results.reduce((sum, result) => sum + result.score, 0);
	const byArea: Record<string, number> = {};
	for (const result of results) byArea[result.area] = (byArea[result.area] ?? 0) + totalOf(result);
	const bySurface = new Map<
		string,
		{
			area: string;
			total: number;
			score: number;
			kinds: Record<string, number>;
			failed: number;
			widths: Map<string, number>;
		}
	>();
	for (const result of results) {
		const entry = bySurface.get(result.surface) ?? {
			area: result.area,
			total: 0,
			score: 0,
			kinds: {},
			failed: 0,
			widths: new Map<string, number>(),
		};
		entry.total += totalOf(result);
		entry.score += result.score;
		if (result.failed) entry.failed++;
		for (const [kind, count] of Object.entries(result.counts))
			entry.kinds[kind] = (entry.kinds[kind] ?? 0) + (count ?? 0);
		const key = lookColumn(result.look);
		entry.widths.set(key, (entry.widths.get(key) ?? 0) + totalOf(result));
		bySurface.set(result.surface, entry);
	}
	const ranked = [...bySurface.entries()].sort((a, b) => b[1].score - a[1].score);
	const widthKeys = [...new Set(results.map(result => lookColumn(result.look)))].sort(
		(a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b),
	);
	const lines = [
		`# Responsive audit — ${new Date().toISOString()}`,
		"",
		`Looks: ${new Set(results.map(result => lookTag(result.look))).size}; surfaces: ${bySurface.size}; issues: ${total} (weighted ${score.toFixed(1)}); by area: ${Object.entries(
			byArea,
		)
			.map(([area, count]) => `${area} ${count}`)
			.join(", ")}.`,
		"",
		`By kind: ${ISSUE_KINDS.map(kind => `${kind} ${results.reduce((sum, result) => sum + (result.counts[kind] ?? 0), 0)}`).join(", ")}.`,
		"",
		`Weights: ${ISSUE_KINDS.map(kind => `${kind} ${KIND_WEIGHT[kind]}`).join(", ")}. A cell is the issue count at that width (portrait; L = touch landscape; W = desktop web client; E = Electron window), light and dark, en and ko added. Desktop looks measure no hit areas and no safe areas (mouse input).`,
		"",
		`| surface | area | score | total | ${widthKeys.join(" | ")} | top kinds |`,
		`| --- | --- | ---: | ---: | ${widthKeys.map(() => "---:").join(" | ")} | --- |`,
		...ranked.map(([surface, entry]) => {
			const kinds = Object.entries(entry.kinds)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([kind, count]) => `${kind} ${count}`)
				.join(", ");
			return `| ${surface}${entry.failed ? ` (⚠ ${entry.failed} failed)` : ""} | ${entry.area} | ${entry.score.toFixed(0)} | ${entry.total} | ${widthKeys.map(key => entry.widths.get(key) ?? "·").join(" | ")} | ${kinds} |`;
		}),
		"",
		"## Density of the idle session (targets on a phone: chrome ≤ 22 %, gutter ≤ 16 px, body 13–15 px)",
		"",
		"| look | app header | app bottom (dock + composer) | composer | insets (not counted) | app chrome share | text gutter | body font |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...results
			.filter(result => result.metrics)
			.sort((a, b) => a.look.width - b.look.width || a.look.orientation.localeCompare(b.look.orientation))
			.map(({ look, metrics }) =>
				metrics
					? `| ${lookTag(look)} | ${metrics.header} | ${metrics.bottom} | ${metrics.composer} | ${metrics.insets} | ${metrics.chromeShare} % | ${metrics.gutter} | ${metrics.bodyFont} |`
					: "",
			),
		"",
	];
	await fs.writeFile(path.join(dir, "summary.md"), lines.join("\n"));
	await fs.writeFile(
		path.join(dir, "report.json"),
		JSON.stringify({ generatedAt: new Date().toISOString(), total, score, byArea, results }, null, 1),
	);
	return { total, score, byArea };
}
