/**
 * Settings › Agent behavior › Smart automation › Autopilot rows: the defaults the start sheet opens with
 * (prefs `autopilotShip`, `autopilotNotify`, `autopilotLimits`). Everything starts on the cautious side.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { AutopilotLimitsRow, AutopilotNotifyRow, AutopilotShipRow } from "./AutopilotRows";

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

async function mount(row: "ship" | "notify" | "limits"): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				{row === "ship" ? <AutopilotShipRow /> : row === "notify" ? <AutopilotNotifyRow /> : <AutopilotLimitsRow />}
			</I18nProvider>,
		);
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
	it("shipping starts at local only and writes a whole policy for the chosen preset", async () => {
		await mount("ship");
		expect((selectIn("setting-gui-autopilotShip") as unknown as HTMLSelectElement).value).toBe("local");
		await choose(selectIn("setting-gui-autopilotShip"), "release");
		expect(prefs.set).toHaveBeenCalledWith(
			"autopilotShip",
			expect.objectContaining({
				autoPush: true,
				autoRelease: expect.objectContaining({ on: true }),
				remote: "origin",
			}),
		);
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

	it("ceilings are all empty by default and save only the ones set; clearing them stores nothing", async () => {
		await mount("limits");
		const inputs = Array.from(document.querySelectorAll("input")) as unknown as HTMLInputElement[];
		expect(inputs.map(input => input.value)).toEqual(["", "", "", ""]);

		const tokens = inputs[0] as HTMLInputElement;
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tokens), "value")?.set?.call(tokens, "2000000");
		await act(async () => reactProps(tokens).onChange?.({ target: tokens, currentTarget: tokens }));
		await act(async () => reactProps(tokens).onBlur?.());
		expect(prefs.set).toHaveBeenLastCalledWith("autopilotLimits", {
			tokens: 2_000_000,
			minutes: null,
			cycles: null,
			usd: null,
		});

		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tokens), "value")?.set?.call(tokens, "");
		await act(async () => reactProps(tokens).onChange?.({ target: tokens, currentTarget: tokens }));
		await act(async () => reactProps(tokens).onBlur?.());
		expect(prefs.set).toHaveBeenLastCalledWith("autopilotLimits", undefined);
	});
});
