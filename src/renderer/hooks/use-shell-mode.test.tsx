import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { keyboardInset } from "../lib/keyboard-inset";
import {
	applyShellAttributes,
	currentShellInput,
	currentShellMode,
	isDrawerMode,
	maxSplitPanes,
	PHONE_QUERY,
	resetShellModeForTests,
	shellModeFor,
	TABLET_DOCK_QUERY,
	TABLET_PORTRAIT_QUERY,
	TOUCH_QUERY,
	useDrawerMode,
	useShellMode,
} from "./use-shell-mode";

const { document, window } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.IS_REACT_ACT_ENVIRONMENT = true;

/** matchMedia answering from a width, height and pointer, the way the three shell queries read them. */
function stubViewport(width: number, height: number, coarse: boolean): void {
	const answers: Record<string, boolean> = {
		[PHONE_QUERY]: width < 600 || (height < 500 && width > height),
		[TABLET_PORTRAIT_QUERY]: width < 1000,
		[TOUCH_QUERY]: coarse,
		[TABLET_DOCK_QUERY]: width >= 800,
	};
	Object.assign(window, {
		matchMedia: (query: string) => ({
			matches: answers[query] ?? false,
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
		location: { search: "" },
	});
}

function setPlatform(platform: string | undefined): void {
	if (platform === undefined) delete document.documentElement.dataset.platform;
	else document.documentElement.dataset.platform = platform;
}

afterEach(() => {
	resetShellModeForTests();
	setPlatform(undefined);
	delete document.documentElement.dataset.shell;
	delete document.documentElement.dataset.input;
});

describe("shell mode breakpoints", () => {
	it("is phone under 600 px wide or in a short landscape window, tablet-portrait under 1000, else landscape", () => {
		expect(shellModeFor(true, true)).toBe("phone");
		expect(shellModeFor(false, true)).toBe("tablet-portrait");
		expect(shellModeFor(false, false)).toBe("tablet-landscape");
	});

	it.each([
		[393, 852, "phone"],
		[852, 393, "phone"],
		[834, 1194, "tablet-portrait"],
		[1194, 834, "tablet-landscape"],
	])("%i×%i is %s in the web build", (width, height, mode) => {
		setPlatform("web");
		stubViewport(width, height, true);
		expect(currentShellMode()).toBe(mode);
		expect(currentShellInput()).toBe("touch");
	});

	it("never activates in an Electron window, however narrow", () => {
		setPlatform("darwin");
		stubViewport(360, 640, true);
		expect(currentShellMode()).toBeNull();
		expect(currentShellInput()).toBeNull();
		applyShellAttributes();
		expect(document.documentElement.dataset.shell).toBeUndefined();
		expect(maxSplitPanes()).toBe(4);
	});

	it("reads a mouse as input mouse and a landscape tablet as two panes at most", () => {
		setPlatform("web");
		stubViewport(1194, 834, false);
		expect(currentShellInput()).toBe("mouse");
		expect(maxSplitPanes()).toBe(2);
	});

	it("keeps the sidebar in a drawer on a phone and a portrait tablet only", () => {
		expect(isDrawerMode("phone")).toBe(true);
		expect(isDrawerMode("tablet-portrait")).toBe(true);
		expect(isDrawerMode("tablet-landscape")).toBe(false);
		expect(isDrawerMode(null)).toBe(false);
	});
});

function DrawerProbe() {
	return <span data-drawer={String(useDrawerMode())} />;
}

describe("the session list's second pane", () => {
	it.each([
		[393, 852, true],
		[744, 1133, true],
		[834, 1194, false],
		[1194, 834, false],
	])("%i×%i keeps the list in a drawer: %s", async (width, height, drawer) => {
		setPlatform("web");
		stubViewport(width, height, true);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container as unknown as Element);
		await act(async () => root.render(<DrawerProbe />));
		expect(container.querySelector("span")?.getAttribute("data-drawer")).toBe(String(drawer));
		await act(async () => root.unmount());
	});
});

describe("useShellMode", () => {
	let root: Root | undefined;

	async function mount(element: ReactElement): Promise<HTMLElement> {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container as unknown as Element);
		await act(async () => root?.render(element));
		return container as unknown as HTMLElement;
	}

	function Probe() {
		return <span data-mode={useShellMode() ?? "none"} />;
	}

	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
	});

	it("mirrors the mode and input onto <html> while mounted, and clears them after", async () => {
		setPlatform("web");
		stubViewport(393, 852, true);
		const container = await mount(<Probe />);
		expect(container.querySelector("span")?.getAttribute("data-mode")).toBe("phone");
		expect(document.documentElement.dataset.shell).toBe("phone");
		expect(document.documentElement.dataset.input).toBe("touch");
		await act(async () => root?.unmount());
		root = undefined;
		expect(document.documentElement.dataset.shell).toBeUndefined();
	});

	it("leaves <html> alone in an Electron window", async () => {
		setPlatform("win32");
		stubViewport(500, 700, true);
		const container = await mount(<Probe />);
		expect(container.querySelector("span")?.getAttribute("data-mode")).toBe("none");
		expect(document.documentElement.dataset.shell).toBeUndefined();
	});
});

describe("keyboard inset", () => {
	it("is the part of the layout viewport the visual viewport leaves uncovered, never negative", () => {
		expect(keyboardInset({ height: 500, offsetTop: 0, scale: 1 }, 852)).toBe(352);
		expect(keyboardInset({ height: 600, offsetTop: 40, scale: 1 }, 852)).toBe(212);
		expect(keyboardInset({ height: 852, offsetTop: 0, scale: 1 }, 852)).toBe(0);
		expect(keyboardInset({ height: 900, offsetTop: 0, scale: 1 }, 852)).toBe(0);
	});

	it("ignores a pinch zoom, which shrinks and pans the visual viewport with no keyboard", () => {
		// Zoomed 2× and panned to the middle: no keyboard covers anything.
		expect(keyboardInset({ height: 426, offsetTop: 200, scale: 2 }, 852)).toBe(0);
		// Zoomed 2× with a 300 px keyboard: the screen keeps 552 px, 276 CSS px of the zoomed page.
		expect(keyboardInset({ height: 276, offsetTop: 0, scale: 2 }, 852)).toBe(300);
	});

	it("keeps an action sheet inside the overlay the keyboard shortens", () => {
		// The overlay ends at the keyboard (`inset: … var(--kb-inset)`); a sheet sized to the whole
		// viewport ran under it.
		const css = readFileSync(new URL("../styles/mobile.css", import.meta.url), "utf8");
		const sheet = /\n\.omp-action-sheet \{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(sheet).toMatch(/max-height:[^;]*var\(--kb-inset\)/);
	});
});
