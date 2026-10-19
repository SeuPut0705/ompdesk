import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_FULL_PREF,
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

let stored: Record<string, unknown> = {};
const prefs = {
	get: vi.fn(async (key: string) => stored[key]),
	set: vi.fn(async (key: string, value: unknown) => {
		stored[key] = value;
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
function toggle(id = "setting-gui-agentControl"): HTMLButtonElement {
	const button = document.querySelector(`#${id} [role="switch"]`) as HTMLButtonElement | null;
	if (!button) throw new Error(`${id} switch missing`);
	return button;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	stored = {};
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
		stored = { [AGENT_CONTROL_PREF]: false };
		await mount();
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});

	it("puts full control first, on while unset, and shows the two older gates as covered while it is on", async () => {
		await mount();
		const first = document.querySelector('[role="switch"]');
		expect(first).toBe(toggle("setting-gui-agentControlFull"));
		expect(document.body.textContent).toContain("Give agents full control of OMPdesk");
		// The risk sits in the row's tooltip text.
		expect(document.body.textContent).toContain("prompt-injected");
		expect(toggle("setting-gui-agentControlFull").getAttribute("aria-checked")).toBe("true");
		for (const id of ["setting-gui-agentControlApprove", "setting-gui-agentControlManage"]) {
			expect(toggle(id).getAttribute("aria-checked"), id).toBe("true");
			expect(toggle(id).hasAttribute("disabled"), id).toBe(true);
		}
		expect(document.body.textContent).toContain("Covered by full control while it is on");
		await act(async () => toggle("setting-gui-agentControlFull").click());
		expect(prefs.set).toHaveBeenLastCalledWith(AGENT_CONTROL_FULL_PREF, false);
	});

	it("has two more switches for the human gates once full control is off: approving off and managing on while unset", async () => {
		stored = { [AGENT_CONTROL_FULL_PREF]: false };
		await mount();
		const approve = toggle("setting-gui-agentControlApprove");
		const manage = toggle("setting-gui-agentControlManage");
		expect(document.body.textContent).toContain("Let agents approve for other sessions");
		expect(document.body.textContent).toContain("Let agents manage other sessions");
		// The long descriptions sit behind info tooltips (the text stays in the DOM): approve says why it stays off,
		// manage says deleting still asks.
		expect(document.body.textContent).toContain("would bypass your approval policy");
		expect(document.body.textContent).toContain("Deleting a saved session they did not open still asks");
		expect(approve.getAttribute("aria-checked")).toBe("false");
		expect(manage.getAttribute("aria-checked")).toBe("true");
		await act(async () => approve.click());
		expect(prefs.set).toHaveBeenLastCalledWith(AGENT_CONTROL_APPROVE_PREF, true);
		await act(async () => manage.click());
		expect(prefs.set).toHaveBeenLastCalledWith(AGENT_CONTROL_MANAGE_PREF, false);
		expect(manage.getAttribute("aria-checked")).toBe("false");
	});

	it("hides under a search that does not match it", async () => {
		await mount("proxy");
		expect(document.querySelector('[role="switch"]')).toBeNull();
	});
});
