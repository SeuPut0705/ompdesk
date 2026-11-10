import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { Sheet } from "../../common";
import { PlanDockCard } from "./PlanDockCard";

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

async function mount(content: string | null, planMode = true, inSheet = false) {
	useTabsStore.setState({
		activeTabId: "plan-tab",
		tabs: [{ id: "plan-tab", cwd: "/work", status: "ready", kind: "agent", unreadDone: false }],
		bundles: new Map(),
	});
	useSessionStore.setState({ planModeEnabled: planMode, sessionFile: "/work/session.jsonl", cwd: "/work" });
	Object.assign(window, {
		omp: {
			rpc: {
				getPlanMode: vi.fn(async () => ({
					success: true,
					data: { enabled: planMode, planFilePath: "/work/plan.md" },
				})),
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
				{inSheet ? (
					<Sheet onClose={() => {}} open title="Plan">
						<PlanDockCard presentation="sheet" />
					</Sheet>
				) : (
					<PlanDockCard presentation="sheet" />
				)}
			</I18nProvider>,
		);
	});
}

describe("the plan document sheet", () => {
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
	it("numbers each section's items from 1 and counts only the steps on the tab", async () => {
		await mount("## Steps\n1. Reproduce\n2. Fix\n\n## Risks\n- Same race elsewhere\n");
		const numbers = [...container.querySelectorAll("[data-plan-step-number]")].map(span => span.textContent);
		expect(numbers).toEqual(["1", "2", "1"]);
		expect(container.querySelector('[data-tab-id="steps"]')?.textContent).toMatch(/\D2$/);
	});
	it("is a reader with plan mode off: no feedback box, no approve or request", async () => {
		await mount("## Steps\n1. Reproduce\n", false);
		expect(container.textContent).toContain("Reproduce");
		expect(container.querySelectorAll("[data-plan-review]")).toHaveLength(0);
		expect(container.querySelectorAll("textarea")).toHaveLength(0);
	});
	it("opens on the plan itself, never on the plan-mode switch above it", async () => {
		const seen: { focused: HTMLElement | null } = { focused: null };
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => seen.focused });
		const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
			seen.focused = this;
		});
		try {
			await mount("## Steps\n1. Reproduce\n", true, true);
			expect(seen.focused?.getAttribute("role")).toBe("region");
			expect(seen.focused?.querySelector('[role="switch"]')).not.toBeNull();
		} finally {
			focus.mockRestore();
			Reflect.deleteProperty(document, "activeElement");
		}
	});
});
