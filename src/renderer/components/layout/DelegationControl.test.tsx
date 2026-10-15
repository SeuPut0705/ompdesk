/**
 * Composer delegation chip: reads the tab's strength from the gui-bridge
 * (`get_delegation`), shows its name (only an icon for "your settings"),
 * switches the live tab through `set_delegation`, remembers the choice for new
 * tabs (prefs `delegationMode`), and stays out of the composer on an omp that
 * cannot hold a strength.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { DELEGATION_MODES } from "../../../../resources/gui-bridge/delegation-contracts";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";

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
Object.assign(window as unknown as Record<string, unknown>, { omp: { rpc: { getDelegation, setDelegation }, prefs } });

const { createRoot } = await import("react-dom/client");
const { DelegationControl } = await import("./DelegationControl");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<DelegationControl />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

function trigger(): HTMLButtonElement | null {
	return container.querySelector("[data-delegation-trigger]") as unknown as HTMLButtonElement | null;
}

function option(mode: string): HTMLButtonElement {
	const element = document.querySelector(`[data-delegation-option="${mode}"]`);
	if (!element) throw new Error(`option ${mode} missing`);
	return element as unknown as HTMLButtonElement;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	held = "default";
	getDelegation.mockClear();
	setDelegation.mockClear();
	prefs.set.mockClear();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("DelegationControl", () => {
	it("shows the tab's held strength and lists every strength with what it does", async () => {
		held = "collaborative";
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		expect(getDelegation).toHaveBeenCalled();
		expect(trigger()?.textContent).toContain(translate("input.delegation.mode.collaborative"));
		await act(async () => trigger()?.click());
		for (const mode of DELEGATION_MODES) {
			expect(option(mode).textContent).toContain(translate(`input.delegation.mode.${mode}`));
			expect(option(mode).textContent).toContain(translate(`input.delegation.desc.${mode}`));
		}
		expect(option("collaborative").getAttribute("aria-checked")).toBe("true");
		expect(option("swarm").getAttribute("aria-checked")).toBe("false");
	});

	it("names only the icon for your own settings", async () => {
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		expect(trigger()?.textContent).not.toContain(translate("input.delegation.mode.default"));
		expect(trigger()?.getAttribute("aria-label")).toContain(translate("input.delegation.mode.default"));
	});

	it("switches the live tab and remembers the choice for new tabs", async () => {
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		await act(async () => trigger()?.click());
		await act(async () => option("solo").click());
		expect(setDelegation).toHaveBeenCalledWith("solo");
		expect(prefs.set).toHaveBeenCalledWith("delegationMode", "solo");
		expect(trigger()?.textContent).toContain(translate("input.delegation.mode.solo"));
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
		expect(trigger()?.textContent).not.toContain(translate("input.delegation.mode.swarm"));
		expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
	});

	it("stays out of the composer when the omp cannot report a strength", async () => {
		getDelegation.mockResolvedValueOnce({
			type: "response",
			command: "get_delegation",
			success: false,
			error: "unsupported_omp",
		});
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mount();
		expect(trigger()).toBeNull();
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
