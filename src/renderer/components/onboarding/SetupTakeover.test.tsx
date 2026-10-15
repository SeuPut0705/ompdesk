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
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

const fake = fakeSetupApi(
	setupState("darwin", { omp: { phase: "idle", presence: { kind: "missing" } } }, { ompReady: false }),
);
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
	vi.useRealTimers();
	reducedMotion = false;
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useMachineSetupStore.getState().reset();
});

describe("SetupTakeover", () => {
	it("is one modal dialog labelled by its title, with the brand, the step list and the drag strip", async () => {
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
