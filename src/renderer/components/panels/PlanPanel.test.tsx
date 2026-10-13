import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { PlanPanel } from "./PlanPanel";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
	if (root) await act(async () => root.unmount());
	container?.remove();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
});

async function mount(content: string | null) {
	useTabsStore.setState({
		activeTabId: "plan-tab",
		tabs: [{ id: "plan-tab", cwd: "/work", status: "ready", kind: "agent", unreadDone: false }],
		bundles: new Map(),
	});
	useSessionStore.setState({ planModeEnabled: true, sessionFile: "/work/session.jsonl", cwd: "/work" });
	Object.assign(window, {
		omp: {
			rpc: {
				getPlanMode: vi.fn(async () => ({ success: true, data: { enabled: true, planFilePath: "/work/plan.md" } })),
			},
			fs: { readPlan: vi.fn(async () => ({ ok: true, path: content === null ? null : "/work/plan.md", content })) },
		},
	});
	container = document.createElement("div") as unknown as HTMLDivElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider>
				<PlanPanel />
			</I18nProvider>,
		);
	});
}

describe("PlanPanel", () => {
	it("renders the current plan steps and their completed state", async () => {
		await mount("# Delivery\n- [x] Read stock state\n- [ ] Implement view\n");
		expect(container.textContent).toContain("Read stock state");
		expect(container.textContent).toContain("Implement view");
		expect(container.querySelector(".line-through")?.textContent).toBe("Read stock state");
		expect(container.querySelectorAll("textarea")).toHaveLength(1);
	});
	it("shows an empty state when the session has no plan file", async () => {
		await mount(null);
		expect(container.textContent).toContain("No plan");
		expect(container.querySelectorAll("textarea")).toHaveLength(0);
	});
});
