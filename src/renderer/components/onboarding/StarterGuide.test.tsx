/**
 * Getting-started checklist at the sidebar foot: steps complete from real app
 * state (a servable model, a sent prompt, an open project, a split, the side
 * panel) and stay done; the next step offers its spotlight tour; the user can
 * hide the guide; it waits while first-run setup has the main area.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type { ModelInfo, ProviderInfo } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useFirstRunStore } from "../../stores/first-run";
import { useModelStore } from "../../stores/model";
import { useSidebarFolds } from "../../stores/sidebar-folds";
import { STARTER_GUIDE_PREF, useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
import { StarterGuide } from "./StarterGuide";

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

let stored: Record<string, unknown> = {};
let customConfigs: CustomProviderView[] = [];
const connected: ProviderInfo = {
	id: "p",
	name: "P",
	authenticated: true,
	loginAvailable: false,
	disabled: false,
	modelCount: 1,
};
const prefs = {
	get: vi.fn(async (key: string): Promise<unknown> => stored[key]),
	set: vi.fn(async (key: string, value: unknown): Promise<void> => {
		stored[key] = value;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { prefs, models: { listProviders: vi.fn(async () => ({ providers: customConfigs, options: {} })) } },
});

let root: Root | undefined;

async function mount(props: { promptSent?: boolean; projectOpened?: boolean } = {}): Promise<void> {
	root ??= createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<StarterGuide projectOpened={props.projectOpened ?? false} promptSent={props.promptSent ?? false} />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	});
}

const button = (label: string) =>
	[...document.querySelectorAll("button")].find(node => node.textContent?.trim().startsWith(label)) as
		| HTMLElement
		| undefined;
const toggle = () => document.querySelector("[data-starter-guide] button[aria-expanded]") as HTMLElement | null;

beforeEach(() => {
	stored = {};
	customConfigs = [];
	prefs.set.mockClear();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useStarterGuideStore.getState().reset();
	useSidebarFolds.getState().reset();
	useModelStore.getState().reset();
	useFirstRunStore.getState().reset();
	useUiStore.setState({ panelVisible: false });
});

describe("StarterGuide", () => {
	it("completes steps from real state, keeps them done and saves them", async () => {
		useModelStore.setState({
			providers: [connected],
			availableModels: [{ id: "m", provider: "p", contextWindow: 200_000 } as ModelInfo],
		});
		await mount({ projectOpened: true });
		expect(toggle()?.textContent).toContain(translate("starter.progress", { done: 2, total: 5 }));
		expect(stored[STARTER_GUIDE_PREF]).toEqual({ done: ["model", "project"], dismissed: false });

		// The panel opens and closes again: the step stays done.
		await act(async () => useUiStore.setState({ panelVisible: true }));
		await act(async () => useUiStore.setState({ panelVisible: false }));
		expect(toggle()?.textContent).toContain(translate("starter.progress", { done: 3, total: 5 }));
		expect(stored[STARTER_GUIDE_PREF]).toEqual({ done: ["model", "project", "panel"], dismissed: false });
	});

	it("does not count the keyless on-device model as a connected model", async () => {
		useModelStore.setState({
			providers: [{ ...connected, id: "apple", authenticated: false }],
			availableModels: [{ id: "on-device", provider: "apple", contextWindow: 8_192 } as ModelInfo],
		});
		await mount();
		expect(toggle()?.textContent).toContain(translate("starter.progress", { done: 0, total: 5 }));
		// Nothing reached, nothing saved: the step stays open for the person who has not connected one.
		expect(stored[STARTER_GUIDE_PREF]).toBeUndefined();
	});

	it("counts a keyless custom endpoint from models.yml as a connected model", async () => {
		customConfigs = [{ id: "local", auth: "none" } as CustomProviderView];
		useModelStore.setState({
			providers: [{ ...connected, id: "local", authenticated: false }],
			availableModels: [{ id: "llama", provider: "local", contextWindow: 128_000 } as ModelInfo],
		});
		await mount();
		expect(toggle()?.textContent).toContain(translate("starter.progress", { done: 1, total: 5 }));
		expect(stored[STARTER_GUIDE_PREF]).toEqual({ done: ["model"], dismissed: false });
	});

	it("lists every step with its state and offers the next one's tour", async () => {
		stored[STARTER_GUIDE_PREF] = { done: ["model"], dismissed: false };
		await mount();
		await act(async () => toggle()?.click());
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		const items = [...document.querySelectorAll("[data-starter-step]")];
		expect(items.map(item => item.getAttribute("data-starter-step"))).toEqual([
			"model",
			"prompt",
			"project",
			"split",
			"panel",
		]);
		expect(items.map(item => item.getAttribute("data-done"))).toEqual(["true", "false", "false", "false", "false"]);
		// Only the next step shows its hint and tour.
		expect(items[1]?.textContent).toContain(translate("starter.step.prompt.hint"));
		expect(items[2]?.textContent).not.toContain(translate("starter.step.project.hint"));
		await act(async () => button(translate("starter.showMe"))?.click());
		expect(useStarterGuideStore.getState().tour).toBe("prompt");
	});

	it("hides for good when the user dismisses it", async () => {
		await mount();
		await act(async () => toggle()?.click());
		await act(async () => button(translate("starter.hide"))?.click());
		expect(document.querySelector("[data-starter-guide]")).toBeNull();
		expect(stored[STARTER_GUIDE_PREF]).toEqual({ done: [], dismissed: true });
	});

	it("waits while first-run setup has the main area", async () => {
		useFirstRunStore.setState({ phase: "connect" });
		await mount();
		expect(document.querySelector("[data-starter-guide]")).toBeNull();
	});

	it("says all set once every step is done", async () => {
		stored[STARTER_GUIDE_PREF] = { done: ["model", "prompt", "project", "split", "panel"], dismissed: false };
		await mount();
		expect(toggle()?.textContent).toContain(translate("starter.allSet"));
	});
});
