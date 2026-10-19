import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
} from "../../../shared/agent-control";
import { I18nProvider } from "../../lib/i18n";
import { AgentControlRow } from "./AgentControlRow";

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
	get: vi.fn(async (_key: string) => stored),
	set: vi.fn(async (_key: string, value: unknown) => {
		stored = value;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs } });

let root: Root;
async function mount(query = "") {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<AgentControlRow query={query} />
			</I18nProvider>,
		);
	});
}
function toggle(): HTMLButtonElement {
	const button = document.querySelector('[role="switch"]') as HTMLButtonElement | null;
	if (!button) throw new Error("control tools switch missing");
	return button;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	stored = undefined;
	vi.clearAllMocks();
});

describe("AgentControlRow", () => {
	it("is on while the pref was never stored, and turning it off then on writes false then true", async () => {
		await mount();
		expect(document.body.textContent).toContain("OMPdesk control tools");
		expect(document.getElementById("setting-gui-agentControl")).not.toBeNull();
		expect(toggle().getAttribute("aria-checked")).toBe("true");

		await act(async () => toggle().click());
		expect(prefs.set).toHaveBeenLastCalledWith(AGENT_CONTROL_PREF, false);
		expect(toggle().getAttribute("aria-checked")).toBe("false");

		await act(async () => toggle().click());
		expect(prefs.set).toHaveBeenLastCalledWith(AGENT_CONTROL_PREF, true);
		expect(toggle().getAttribute("aria-checked")).toBe("true");
	});

	it("shows off when the stored pref is false", async () => {
		stored = false;
		await mount();
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});

	it("has two more switches for the human gates: approving off and managing sessions on while nothing is stored", async () => {
		stored = undefined;
		await mount();
		const approve = document.querySelector(
			'#setting-gui-agentControlApprove [role="switch"]',
		) as HTMLButtonElement | null;
		const manage = document.querySelector(
			'#setting-gui-agentControlManage [role="switch"]',
		) as HTMLButtonElement | null;
		expect(document.body.textContent).toContain("Let agents approve for other sessions");
		expect(document.body.textContent).toContain("Let agents manage other sessions");
		// The long descriptions sit behind info tooltips (the text stays in the DOM): approve says why it stays off,
		// manage says deleting still asks.
		expect(document.body.textContent).toContain("would bypass your approval policy");
		expect(document.body.textContent).toContain("Deleting a saved session they did not open still asks");
		expect(approve?.getAttribute("aria-checked")).toBe("false");
		expect(manage?.getAttribute("aria-checked")).toBe("true");
		await act(async () => approve?.click());
		expect(prefs.set).toHaveBeenLastCalledWith(AGENT_CONTROL_APPROVE_PREF, true);
		await act(async () => manage?.click());
		expect(prefs.set).toHaveBeenLastCalledWith(AGENT_CONTROL_MANAGE_PREF, false);
		expect(manage?.getAttribute("aria-checked")).toBe("false");
	});

	it("hides under a search that does not match it", async () => {
		await mount("proxy");
		expect(document.querySelector('[role="switch"]')).toBeNull();
	});
});
