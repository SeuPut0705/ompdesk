/**
 * Delegation in the Run popover: reads the tab's strength from the gui-bridge (`get_delegation`), shows a glyph on
 * the Run chip while it is not "your settings" (and spells it in the chip's name), switches the live tab through
 * `set_delegation`, remembers the choice for new tabs (prefs `delegationMode`), and leaves the section out on an
 * omp that cannot hold a strength.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { DELEGATION_MODES } from "../../../../../resources/gui-bridge/modes/delegation-contracts";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useToastStore } from "../../../stores/toast";

const { document, window, Event, HTMLElement, Element, Node, PointerEvent } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	PointerEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const ok = (command: string, data: unknown): RpcResponse => ({ type: "response", command, success: true, data });
let held = "default";
const getDelegation: Mock<() => Promise<RpcResponse>> = vi.fn(async () => ok("get_delegation", { mode: held }));
const setDelegation: Mock<(mode: string) => Promise<RpcResponse>> = vi.fn(async mode => {
	held = mode;
	return ok("set_delegation", { mode });
});
const prefs = { get: vi.fn(async () => undefined), set: vi.fn(async (_key: string, _value: unknown) => {}) };
const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: { getDelegation, setDelegation, getSettings: vi.fn(async () => ok("get_settings", { values: {} })) },
		prefs,
		events,
	},
});

const { createRoot } = await import("react-dom/client");
const { RunChip } = await import("./RunChip");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RunChip />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

function trigger(): HTMLButtonElement | null {
	return container.querySelector("[data-run-settings-trigger]") as unknown as HTMLButtonElement | null;
}

const section = () => document.querySelector("[data-delegation-section]");

function option(mode: string): HTMLButtonElement {
	const element = document.querySelector(`[data-delegation-option="${mode}"]`);
	if (!element) throw new Error(`option ${mode} missing`);
	return element as unknown as HTMLButtonElement;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	held = "default";
	getDelegation.mockReset();
	getDelegation.mockImplementation(async () => ok("get_delegation", { mode: held }));
	setDelegation.mockClear();
	prefs.set.mockClear();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("Delegation in the Run popover", () => {
	it("shows the tab's held strength as one segmented line, the full name and effect behind (i)", async () => {
		held = "collaborative";
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		expect(getDelegation).toHaveBeenCalled();
		expect(trigger()?.getAttribute("aria-label")).toContain(
			`${translate("input.delegation.title")}: ${translate("input.delegation.mode.collaborative")}`,
		);
		// Named, never drawn: the chip carries no delegation glyph whatever the strength.
		expect(trigger()?.querySelector(".lucide-network")).toBeNull();
		await act(async () => trigger()?.click());
		expect(section()).not.toBeNull();
		for (const mode of DELEGATION_MODES) {
			expect(option(mode).textContent).toBe(translate(`input.delegation.short.${mode}`));
			expect(option(mode).getAttribute("aria-label")).toBe(translate(`input.delegation.mode.${mode}`));
		}
		// One line: no paragraph under the row; what the held strength does (and that it applies from the next turn)
		// is the (i) glyph's text.
		expect(section()?.querySelector("[data-setting-info]")).not.toBeNull();
		expect(section()?.textContent).toContain(translate("input.delegation.desc.collaborative"));
		expect(section()?.textContent).toContain(translate("input.delegation.note"));
		expect(section()?.querySelector("p")).toBeNull();
		expect(option("collaborative").getAttribute("aria-checked")).toBe("true");
		expect(option("swarm").getAttribute("aria-checked")).toBe("false");
	});

	it("names your own settings on the chip too", async () => {
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		expect(trigger()?.getAttribute("aria-label")).toContain(translate("input.delegation.mode.default"));
	});

	it("switches the live tab, keeps the popover open and remembers the choice for new tabs", async () => {
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		await act(async () => trigger()?.click());
		await act(async () => option("solo").click());
		expect(setDelegation).toHaveBeenCalledWith("solo");
		expect(prefs.set).toHaveBeenCalledWith("delegationMode", "solo");
		expect(trigger()?.getAttribute("aria-label")).toContain(translate("input.delegation.mode.solo"));
		expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
		expect(option("solo").getAttribute("aria-checked")).toBe("true");
	});

	it("keeps the old strength and reports a refused switch", async () => {
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		setDelegation.mockResolvedValueOnce({
			type: "response",
			command: "set_delegation",
			success: false,
			error: "This omp has no task.maxRecursionDepth setting",
		});
		await act(async () => trigger()?.click());
		await act(async () => option("swarm").click());
		expect(prefs.set).not.toHaveBeenCalled();
		expect(trigger()?.getAttribute("aria-label")).toContain(translate("input.delegation.mode.default"));
		expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
	});

	it("has no Delegation section when the omp cannot report a strength", async () => {
		// Every read says so: the popover re-reads on each open.
		getDelegation.mockResolvedValue({
			type: "response",
			command: "get_delegation",
			success: false,
			error: "unsupported_omp",
		});
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		expect(trigger()?.getAttribute("aria-label")).not.toContain(translate("input.delegation.title"));
		await act(async () => trigger()?.click());
		expect(section()).toBeNull();
		// The rest of the popover is there.
		expect(document.querySelector("[data-composer-modes-section]")).not.toBeNull();
	});

	it("keeps the chip focusable while a switch is in flight, so focus is not lost", async () => {
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		const gate = Promise.withResolvers<RpcResponse>();
		setDelegation.mockReturnValueOnce(gate.promise);
		await act(async () => trigger()?.click());
		await act(async () => option("solo").click());
		expect(trigger()?.disabled).toBe(false);
		expect(trigger()?.getAttribute("aria-busy")).toBe("true");
		await act(async () => gate.resolve(ok("set_delegation", { mode: "solo" })));
		expect(trigger()?.getAttribute("aria-busy")).not.toBe("true");
	});

	it("is one tab stop in the radio group: the held strength, arrows move between the rest", async () => {
		held = "assisted";
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		await act(async () => trigger()?.click());
		for (const mode of DELEGATION_MODES)
			expect(option(mode).getAttribute("tabindex"), mode).toBe(mode === "assisted" ? "0" : "-1");
	});
});
