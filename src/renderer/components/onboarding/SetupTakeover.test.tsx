/**
 * The full-window machine setup screen: one modal dialog (role, aria-modal,
 * labelled by its title), the whole setup view inside, chords that never reach
 * the app behind, and a fade out that reduced motion skips.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OVERLAY_EXIT_MS } from "../../hooks/use-overlay-presence";
import { I18nProvider, translate } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { fakeSetupApi, setupState } from "../../test-support/machine-setup";
import { SetupTakeover } from "./SetupTakeover";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
// linkedom has no focus model: record the last focused element and expose it as `activeElement`.
let focused: Element | null = null;
elementPrototype.focus = function (this: Element) {
	focused = this;
};
Object.defineProperty(document, "activeElement", { get: () => focused ?? document.body, configurable: true });

const fake = fakeSetupApi(
	setupState("darwin", { omp: { phase: "idle", presence: { kind: "missing" } } }, { ompReady: false }),
);
const initialState = fake.current.state;
let reducedMotion = false;
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { setup: fake.api },
	matchMedia: () => ({ matches: reducedMotion }),
});

const query = (selector: string) => document.body.querySelector(selector) as HTMLElement | null;

const roots: Root[] = [];
async function mount(open: boolean): Promise<(open: boolean) => Promise<void>> {
	const root = createRoot(document.body as unknown as Element);
	roots.push(root);
	const render = (next: boolean) =>
		act(async () => root.render(<I18nProvider>{<SetupTakeover open={next} />}</I18nProvider>));
	await render(open);
	return render;
}

afterEach(async () => {
	focused = null;
	fake.current.state = initialState;
	vi.useRealTimers();
	reducedMotion = false;
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useMachineSetupStore.getState().reset();
});

describe("SetupTakeover", () => {
	const missingOmp = { presence: { kind: "missing" } } as const;

	it("is one modal dialog labelled by its title, with the brand, the step list and the drag strip", async () => {
		fake.current.state = setupState(
			"darwin",
			{ omp: { ...missingOmp, phase: "running", method: "bun-global" } },
			{ ompReady: false, requiredRunning: true },
		);
		await mount(true);
		const dialog = query('[data-testid="setup-takeover"]');
		expect(dialog?.getAttribute("role")).toBe("dialog");
		expect(dialog?.getAttribute("aria-modal")).toBe("true");
		const title = query("h1");
		expect(dialog?.getAttribute("aria-labelledby")).toBe(title?.id);
		expect(title?.textContent).toBe(translate("machineSetup.install.title"));
		expect(document.getElementById(dialog?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
			translate("machineSetup.install.description"),
		);
		expect(dialog?.className).toContain("fixed");
		expect(dialog?.className).toContain("inset-0");
		expect(query("svg")).not.toBeNull();
		expect(query('[data-testid="machine-setup"] ol')).not.toBeNull();
		expect(query(".drag-region")).not.toBeNull();
		expect(query(".no-drag")).not.toBeNull();
	});

	it("focuses the dialog itself on open, not its first control", async () => {
		fake.current.state = setupState(
			"darwin",
			{
				omp: {
					...missingOmp,
					phase: "running",
					method: "bun-global",
					command: "bun install -g @oh-my-pi/pi-coding-agent",
				},
			},
			{ ompReady: false, requiredRunning: true },
		);
		await mount(true);
		expect(document.activeElement).toBe(query('[data-testid="setup-takeover"]'));
	});

	it("says an install is running while it runs, and an update when omp is below the minimum", async () => {
		fake.current.state = setupState(
			"darwin",
			{
				omp: {
					phase: "running",
					method: "omp-update",
					presence: { kind: "outdated", version: "18.0.0", minimum: "18.11.0", path: "/x" },
				},
			},
			{ ompReady: false, requiredRunning: true },
		);
		await mount(true);
		expect(query("h1")?.textContent).toBe(translate("machineSetup.update.title"));
		const describedBy = query('[data-testid="setup-takeover"]')?.getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(describedBy)?.textContent).toBe(translate("machineSetup.update.description"));
	});

	it("stops promising that nothing is left to do once setup failed, was stopped, or is paused", async () => {
		for (const phase of ["failed", "cancelled", "backoff"] as const) {
			fake.current.state = setupState(
				"darwin",
				{ omp: { ...missingOmp, phase, failure: phase === "failed" ? { reason: "exit", exitCode: 1 } : null } },
				{ ompReady: false },
			);
			useMachineSetupStore.getState().reset();
			await mount(true);
			expect(query("h1")?.textContent).toBe(translate("machineSetup.stopped.title", { name: "omp" }));
			const description = document.getElementById(
				query('[data-testid="setup-takeover"]')?.getAttribute("aria-describedby") ?? "",
			);
			expect(description?.textContent).toBe(translate("machineSetup.stopped.description"));
			await act(async () => roots.pop()?.unmount());
			while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
		}
	});

	it("names an omp below the minimum that nothing is updating, and Bun when Bun is what is missing", async () => {
		fake.current.state = setupState(
			"darwin",
			{
				omp: { phase: "failed", presence: { kind: "outdated", version: "18.0.0", minimum: "18.11.0", path: "/x" } },
			},
			{ ompReady: false },
		);
		await mount(true);
		expect(query("h1")?.textContent).toBe(translate("machineSetup.stopped.outdatedTitle", { name: "omp" }));
		await act(async () => roots.pop()?.unmount());
		while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
		useMachineSetupStore.getState().reset();

		fake.current.state = setupState(
			"darwin",
			{ bun: { ...missingOmp, phase: "failed" }, omp: { ...missingOmp, phase: "idle" } },
			{ ompReady: false },
		);
		await mount(true);
		expect(query("h1")?.textContent).toBe(translate("machineSetup.stopped.title", { name: "Bun" }));
	});

	it("renders nothing while closed", async () => {
		await mount(false);
		expect(query('[data-testid="setup-takeover"]')).toBeNull();
	});

	it("fades out inert and unmounts after the exit, so the first-run flow shows through", async () => {
		vi.useFakeTimers();
		const render = await mount(true);
		await render(false);
		const closing = query('[data-testid="setup-takeover"]');
		expect(closing?.className).toContain("omp-fade-out");
		expect(closing?.hasAttribute("inert")).toBe(true);
		expect(closing?.getAttribute("role")).toBe("presentation");
		await act(async () => vi.advanceTimersByTime(OVERLAY_EXIT_MS));
		expect(query('[data-testid="setup-takeover"]')).toBeNull();
	});

	it("skips the fade under reduced motion", async () => {
		reducedMotion = true;
		const render = await mount(true);
		await render(false);
		expect(query('[data-testid="setup-takeover"]')).toBeNull();
	});

	it("keeps chords from the app behind but lets plain keys through", async () => {
		await mount(true);
		const seen: string[] = [];
		const spy = (event: Event) => seen.push((event as unknown as KeyboardEvent).key);
		window.addEventListener("keydown", spy);
		const press = (key: string, init: Record<string, unknown>) => {
			const event = Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), { key, ...init });
			document.body.dispatchEvent(event);
		};
		press("k", { metaKey: true });
		press(",", { ctrlKey: true });
		press("Tab", {});
		press("a", {});
		window.removeEventListener("keydown", spy);
		expect(seen).toEqual(["Tab", "a"]);
	});

	it("cancels drops so files never reach the composer", async () => {
		await mount(true);
		const dialog = query('[data-testid="setup-takeover"]');
		const drop = Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
			dataTransfer: { types: ["Files"], files: [] },
		});
		dialog?.dispatchEvent(drop);
		expect(drop.defaultPrevented).toBe(true);
	});
});
