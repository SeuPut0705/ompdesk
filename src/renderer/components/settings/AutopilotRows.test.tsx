/**
 * Settings › Agent behavior › Smart automation › Autopilot rows: shipping (Automatic unless a level is stored) and
 * notifications (`autopilotShip`, `autopilotNotify`). No ceilings: a run has none unless an agent's start sets them.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { AutopilotNotifyRow, AutopilotSettingsRows, AutopilotShipRow } from "./AutopilotRows";

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
const prefs = {
	get: vi.fn(async (key?: string): Promise<unknown> => (key ? stored[key] : undefined)),
	set: vi.fn(async (key: string, value: unknown): Promise<void> => {
		stored[key] = value;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs } });

let root: Root | undefined;

async function mount(row: "ship" | "notify"): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(<I18nProvider>{row === "ship" ? <AutopilotShipRow /> : <AutopilotNotifyRow />}</I18nProvider>);
	});
	await act(async () => {});
}

/** linkedom fires no React synthetic events, so the test calls the element's own handlers. */
interface ReactProps {
	onChange?: (event: object) => void;
	onBlur?: () => void;
}
function reactProps(element: Element | null): ReactProps {
	const record = element as unknown as Record<string, unknown> | null;
	const key = record ? Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$")) : undefined;
	return record && key ? (record[key] as ReactProps) : {};
}

async function choose(select: Element | null, value: string): Promise<void> {
	const target = { value };
	await act(async () => reactProps(select).onChange?.({ target, currentTarget: target }));
}

const selectIn = (id: string) => document.getElementById(id)?.querySelector("select") ?? null;

beforeEach(() => {
	stored = {};
	prefs.set.mockClear();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("Autopilot settings rows", () => {
	it("shipping starts at Automatic, writes a whole policy for a chosen level and clears it for Automatic", async () => {
		await mount("ship");
		expect((selectIn("setting-gui-autopilotShip") as unknown as HTMLSelectElement).value).toBe("auto");
		await choose(selectIn("setting-gui-autopilotShip"), "release");
		expect(prefs.set).toHaveBeenCalledWith(
			"autopilotShip",
			expect.objectContaining({
				autoPush: true,
				autoRelease: expect.objectContaining({ on: true }),
				remote: "origin",
			}),
		);
		await choose(selectIn("setting-gui-autopilotShip"), "auto");
		expect(prefs.set).toHaveBeenLastCalledWith("autopilotShip", undefined);
	});

	it("shows a stored push policy as the push preset", async () => {
		stored = {
			autopilotShip: { autoPush: true, autoRelease: { on: false, cadence: { kind: "every", n: 5 } }, remote: "up" },
		};
		await mount("ship");
		expect((selectIn("setting-gui-autopilotShip") as unknown as HTMLSelectElement).value).toBe("push");
		await choose(selectIn("setting-gui-autopilotShip"), "local");
		expect(prefs.set).toHaveBeenCalledWith(
			"autopilotShip",
			expect.objectContaining({ autoPush: false, remote: "up" }),
		);
	});

	it("notifications default to stops and save the chosen mode", async () => {
		await mount("notify");
		expect((selectIn("setting-gui-autopilotNotify") as unknown as HTMLSelectElement).value).toBe("stops");
		await choose(selectIn("setting-gui-autopilotNotify"), "cycles");
		expect(prefs.set).toHaveBeenCalledWith("autopilotNotify", "cycles");
	});

	it("shows only shipping and notifications, with no Advanced disclosure", async () => {
		root = createRoot(document.body as unknown as globalThis.Element);
		await act(async () =>
			root?.render(
				<I18nProvider>
					<AutopilotSettingsRows />
				</I18nProvider>,
			),
		);
		await act(async () => {});
		expect(document.querySelectorAll("[data-settings-advanced]")).toHaveLength(0);
		const rows = Array.from(document.querySelectorAll("[data-setting-row]")) as unknown as Element[];
		expect(rows.map(row => row.id)).toEqual(["setting-gui-autopilotShip", "setting-gui-autopilotNotify"]);
	});
});
