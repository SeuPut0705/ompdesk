import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recallText } from "../../../../resources/gui-bridge/modes/memory-recall-core";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { resetMailOpenForTest } from "../../lib/mail-open";
import { useMemoryPageStore } from "../../stores/memory-page";
import { useUiStore } from "../../stores/ui";
import { MemoryRecallNote } from "./CustomMessageCard";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	textContent: string | null;
	getAttribute: (name: string) => string | null;
	click: () => void;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
	dispatchEvent: (event: unknown) => boolean;
}

const SCOPE = { workspace: "default", project: "ompdesk" };
const content = recallText([
	{
		kind: "decision",
		title: "Jev 1.14 pinned",
		text: "Pin Jev to 1.14 until the fix ships.",
		path: "decisions/jev.md",
		order: 0,
	},
	{
		kind: "conclusion",
		title: "Tailscale only",
		text: "Pairing goes through Tailscale.",
		at: "2026-10-18T10:12:00Z",
		order: 1,
	},
]);
const message: AgentMessage = {
	role: "custom",
	customType: "ompdesk-memory-recall",
	content,
	display: true,
	attribution: "agent",
	timestamp: 1,
	details: {
		v: 1,
		judged: true,
		scope: SCOPE,
		items: [
			{ title: "Jev 1.14 pinned", kind: "decision", path: "decisions/jev.md" },
			{ title: "Tailscale only", kind: "conclusion", sessionId: "s1", at: "2026-10-18T10:12:00Z" },
		],
	},
};

const feedback = vi.fn(async () => undefined);
let container: TestElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<MemoryRecallNote message={message} />
			</I18nProvider>,
		);
	});
}

const toggle = () => container.querySelector("button[aria-expanded]");
const rows = () => container.querySelectorAll("[data-memory-recall-item]");

beforeEach(() => {
	resetMailOpenForTest();
	window.sessionStorage?.clear?.();
	feedback.mockClear();
	(window as unknown as { omp: unknown }).omp = { aiMemory: { feedback } };
	useMemoryPageStore.getState().reset();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("memory recall line", () => {
	it("starts closed with the count and kinds", async () => {
		await mount();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).toContain("Memory: 2 notes · Decision, Earlier conclusion");
		expect(rows()).toHaveLength(0);
	});

	it("opens from the keyboard and shows each note's excerpt", async () => {
		await mount();
		await act(async () => {
			// A button's Enter and Space become a click in the browser; the element is a real <button>.
			expect(toggle()?.getAttribute("type")).toBe("button");
			toggle()?.click();
		});
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		const list = rows();
		expect(list).toHaveLength(2);
		expect(list[0].textContent).toContain("Jev 1.14 pinned");
		expect(list[0].querySelector("[data-memory-recall-excerpt]")?.textContent).toBe(
			"Pin Jev to 1.14 until the fix ships.",
		);
		expect(list[1].querySelector("[data-memory-recall-excerpt]")?.textContent).toBe(
			"Pairing goes through Tailscale.",
		);
	});

	it("offers Open in Memory and Not helpful only where a page path exists", async () => {
		await mount();
		await act(async () => toggle()?.click());
		const list = rows();
		expect(list[0].querySelector("[data-memory-recall-open]")).not.toBeNull();
		expect(list[0].querySelector("[data-memory-recall-rate]")).not.toBeNull();
		expect(list[1].querySelector("[data-memory-recall-open]")).toBeNull();
		expect(list[1].querySelector("[data-memory-recall-rate]")).toBeNull();
	});

	it("Not helpful sends the page path with the project and shows the done state", async () => {
		await mount();
		await act(async () => toggle()?.click());
		await act(async () => rows()[0].querySelector("[data-memory-recall-rate]")?.click());
		expect(feedback).toHaveBeenCalledWith({ ...SCOPE, path: "decisions/jev.md" }, "not_helpful");
		const rate = rows()[0].querySelector("[data-memory-recall-rate]");
		expect(rate?.getAttribute("data-memory-recall-rate")).toBe("done");
		expect(rate?.textContent).toContain("Marked not helpful");
	});

	it("Open in Memory selects the page and moves Settings to Pages", async () => {
		await mount();
		await act(async () => toggle()?.click());
		await act(async () => rows()[0].querySelector("[data-memory-recall-open]")?.click());
		expect(useMemoryPageStore.getState().pending).toEqual({ ...SCOPE, path: "decisions/jev.md" });
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "memory:pages" });
	});
});
