/**
 * Settings › Updates & about › This computer › omp updates: the switch is on by
 * default (state's `enabled`) and writes the `ompAutoUpdate` pref, "Update now"
 * asks main and is off while an update runs, the status line says what main
 * learned from npm, and a failed attempt keeps its reason and the retry note.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpUpdateState } from "../../../shared/omp-update";
import { I18nProvider, translate } from "../../lib/i18n";
import { useOmpUpdateStore } from "../../stores/omp-update";
import { OmpUpdateRows } from "./OmpUpdateRows";

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

function ompUpdateState(partial: Partial<OmpUpdateState> = {}): OmpUpdateState {
	return {
		enabled: true,
		scheduled: true,
		phase: "idle",
		installed: "18.8.7",
		latest: "18.8.7",
		checkedAt: 1,
		updatedTo: null,
		failure: null,
		...partial,
	};
}

let listener: ((state: OmpUpdateState) => void) | null = null;
const current = { state: ompUpdateState() };
const api = {
	getState: vi.fn(async () => current.state),
	now: vi.fn(async () => {}),
	onState: vi.fn((callback: (state: OmpUpdateState) => void) => {
		listener = callback;
		return () => {
			listener = null;
		};
	}),
};
const prefsSet = vi.fn(async (_key: string, _value: unknown) => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { ompUpdate: api, prefs: { get: async () => undefined, set: prefsSet } },
});

let root: Root | null = null;
async function mount(state: OmpUpdateState): Promise<void> {
	current.state = state;
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<OmpUpdateRows />
			</I18nProvider>,
		),
	);
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}
const push = (state: OmpUpdateState) =>
	act(async () => {
		listener?.(state);
	});
const toggle = () => document.body.querySelector("#setting-gui-ompAutoUpdate [role='switch']") as HTMLElement;
const nowButton = () => document.body.querySelector("[data-testid='omp-update-now']") as HTMLButtonElement;
const status = () => document.body.querySelector("[data-testid='omp-update-status']")?.textContent;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useOmpUpdateStore.getState().reset();
	for (const fn of [...Object.values(api), prefsSet]) fn.mockClear();
});

describe("OmpUpdateRows", () => {
	it("shows the switch on by default, says omp is the latest, and writes the pref when it is turned off", async () => {
		await mount(ompUpdateState());
		expect(document.body.textContent).toContain(translate("ompUpdate.auto"));
		expect(translate("ompUpdate.auto")).toBe("Update omp automatically");
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		expect(status()).toBe(translate("ompUpdate.status.current", { version: "18.8.7" }));
		await act(async () => toggle().click());
		expect(prefsSet).toHaveBeenCalledWith("ompAutoUpdate", false);
		// Main pushes the new state after the pref change.
		await push(ompUpdateState({ enabled: false }));
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});

	it("asks main to update now, and offers it only while nothing runs", async () => {
		await mount(ompUpdateState({ latest: "18.9.0" }));
		expect(status()).toBe(translate("ompUpdate.status.available", { version: "18.8.7", latest: "18.9.0" }));
		await act(async () => nowButton().click());
		expect(api.now).toHaveBeenCalledTimes(1);
		await push(ompUpdateState({ latest: "18.9.0", phase: "updating" }));
		expect(nowButton().disabled).toBe(true);
		expect(status()).toBe(translate("ompUpdate.status.updating"));
		await push(ompUpdateState({ phase: "checking" }));
		expect(nowButton().disabled).toBe(true);
		expect(status()).toBe(translate("ompUpdate.status.checking"));
	});

	it("keeps a failed attempt's reason and says the next check retries", async () => {
		await mount(
			ompUpdateState({
				latest: "18.9.0",
				failure: { reason: "install", detail: "exit 1 — EBUSY: resource busy or locked" },
			}),
		);
		const notice = document.body.querySelector("[data-inline-notice='warning']");
		expect(notice?.textContent).toContain(translate("ompUpdate.failure.install"));
		expect(notice?.textContent).toContain(translate("ompUpdate.retryNote"));
		expect(notice?.textContent).toContain("EBUSY: resource busy or locked");
	});

	it("says a build that never checks on its own still has Update now", async () => {
		await mount(ompUpdateState({ scheduled: false, latest: null }));
		expect(status()).toBe(translate("ompUpdate.status.manualOnly"));
		expect(nowButton().disabled).toBe(false);
	});
});
