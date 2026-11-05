/**
 * Settings › Agent behavior › Computer use engine: agent-desktop by default, a pick is saved and a value outside the
 * list is refused, and the note under the row follows machine setup's `agent-desktop` item (installed: its version;
 * not installed or installing: sessions use the built-in computer use until it is).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { setupState } from "../../test-support/machine-setup";
import { ComputerUseRow } from "./ComputerUseRow";

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

let stored: unknown;
const prefs = {
	get: vi.fn(async (_key?: string): Promise<unknown> => stored),
	set: vi.fn(async (_key: string, value: unknown): Promise<void> => {
		stored = value;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs } });

const roots: Root[] = [];

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ComputerUseRow />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function field(): HTMLSelectElement {
	const select = document.body.querySelector("#setting-gui-computerUse select") as HTMLSelectElement | null;
	if (!select) throw new Error("computer use select missing");
	return select;
}

function reactProps(element: Element): { onChange?: (event: object) => void } {
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return key ? (record[key] as { onChange?: (event: object) => void }) : {};
}

async function choose(value: string): Promise<void> {
	const { onChange } = reactProps(field());
	if (!onChange) throw new Error("select onChange not found");
	await act(async () => onChange({ target: { value }, currentTarget: { value } }));
}

const text = () => document.body.textContent ?? "";

beforeEach(() => {
	stored = undefined;
	useMachineSetupStore.setState({
		state: setupState("darwin", {
			"agent-desktop": { presence: { kind: "present", version: "1.2.0", path: "/t/ad" } },
		}),
	});
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useMachineSetupStore.getState().reset();
	vi.clearAllMocks();
});

describe("ComputerUseRow", () => {
	it("offers agent-desktop and the built-in engine, agent-desktop when nothing is stored", async () => {
		await mount();
		expect(Array.from(field().querySelectorAll("option")).map(option => option.value)).toEqual([
			"agent-desktop",
			"builtin",
		]);
		expect(field().value).toBe("agent-desktop");
	});

	it("reads an older or unknown stored value as the default", async () => {
		stored = "screenshots-only";
		await mount();
		expect(field().value).toBe("agent-desktop");
	});

	it("saves a pick, and refuses a value outside the list", async () => {
		await mount();
		await choose("builtin");
		expect(prefs.set).toHaveBeenCalledWith("computerUse", "builtin");
		expect(field().value).toBe("builtin");
		await choose("takeover");
		expect(prefs.set).toHaveBeenCalledTimes(1);
	});

	it("names the installed version under agent-desktop and no note under the built-in engine", async () => {
		await mount();
		expect(text()).toContain(translate("settings.gui.computerUseVersion", { version: "1.2.0" }));
		await choose("builtin");
		expect(text()).not.toContain(translate("settings.gui.computerUseVersion", { version: "1.2.0" }));
		expect(text()).not.toContain(translate("settings.gui.computerUseMissing"));
	});

	it("says sessions use the built-in computer use while agent-desktop is not installed, installing or failed", async () => {
		for (const item of [
			{ phase: "idle", presence: { kind: "missing" } },
			{ phase: "running", presence: { kind: "missing" } },
			{ phase: "failed", presence: { kind: "missing" } },
		] as const) {
			useMachineSetupStore.setState({ state: setupState("darwin", { "agent-desktop": { ...item } }) });
			await mount();
			expect(text(), item.phase).toContain(translate("settings.gui.computerUseMissing"));
			await act(async () => {
				roots.pop()?.unmount();
			});
		}
	});

	it("says nothing before machine setup has detected agent-desktop", async () => {
		useMachineSetupStore.setState({
			state: setupState("darwin", { "agent-desktop": { phase: "checking", presence: null } }),
		});
		await mount();
		expect(text()).not.toContain(translate("settings.gui.computerUseMissing"));
	});
});
