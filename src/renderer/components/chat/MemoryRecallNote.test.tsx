import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recallText } from "../../../../resources/gui-bridge/modes/memory-recall-core";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { resetMailOpenForTest } from "../../lib/mail-open";
import { resetRecallRatedForTest } from "../../lib/recall-rated";
import { useMemoryPageStore } from "../../stores/memory-page";
import { useUiStore } from "../../stores/ui";
import { MemoryRecallNote } from "./CustomMessageCard";

const host = vi.hoisted(() => ({ grants: null as string[] | null }));
vi.mock("../../web/runtime", async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	pageMayUse: (permission: string) => host.grants === null || host.grants.includes(permission),
}));

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
	resetRecallRatedForTest();
	window.sessionStorage?.clear?.();
	feedback.mockClear();
	host.grants = null;
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

describe("memory recall line, per-item scope", () => {
	const GLOBAL = { workspace: "default", project: "_global" };
	const scoped: AgentMessage = {
		...message,
		content: recallText([
			{ kind: "preference", title: "Global style", text: "g", path: "preferences/style.md", order: 0 },
			{ kind: "preference", title: "Project style", text: "p", path: "preferences/style.md", order: 1 },
		]),
		details: {
			v: 1,
			judged: true,
			scope: SCOPE,
			items: [
				{ title: "Global style", kind: "preference", path: "preferences/style.md", scope: GLOBAL },
				{ title: "Project style", kind: "preference", path: "preferences/style.md", scope: SCOPE },
			],
		},
	};

	async function open(): Promise<void> {
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<MemoryRecallNote message={scoped} />
				</I18nProvider>,
			);
		});
		await act(async () => toggle()?.click());
	}

	it("Not helpful targets each note's own scope", async () => {
		await open();
		await act(async () => rows()[0].querySelector("[data-memory-recall-rate]")?.click());
		await act(async () => rows()[1].querySelector("[data-memory-recall-rate]")?.click());
		expect(feedback).toHaveBeenNthCalledWith(1, { ...GLOBAL, path: "preferences/style.md" }, "not_helpful");
		expect(feedback).toHaveBeenNthCalledWith(2, { ...SCOPE, path: "preferences/style.md" }, "not_helpful");
	});

	it("Open in Memory targets each note's own scope", async () => {
		await open();
		await act(async () => rows()[0].querySelector("[data-memory-recall-open]")?.click());
		expect(useMemoryPageStore.getState().pending).toEqual({ ...GLOBAL, path: "preferences/style.md" });
		await act(async () => rows()[1].querySelector("[data-memory-recall-open]")?.click());
		expect(useMemoryPageStore.getState().pending).toEqual({ ...SCOPE, path: "preferences/style.md" });
	});
});

describe("memory recall line, audit fixes", () => {
	async function mountMessage(next: AgentMessage): Promise<void> {
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<MemoryRecallNote message={next} />
				</I18nProvider>,
			);
		});
		if (rows().length === 0) await act(async () => toggle()?.click());
	}

	it("never borrows the Memory page's selected project for a message without a scope", async () => {
		useMemoryPageStore.getState().setProject({ workspace: "default", project: "other" });
		const old: AgentMessage = { ...message, details: { ...(message.details as object), scope: undefined } };
		await mountMessage(old);
		const list = rows();
		expect(list[0].textContent).toContain("Jev 1.14 pinned");
		expect(list[0].querySelector("[data-memory-recall-excerpt]")).not.toBeNull();
		expect(list[0].querySelector("[data-memory-recall-open]")).toBeNull();
		expect(list[0].querySelector("[data-memory-recall-rate]")).toBeNull();
	});

	it("keeps the done state across fold and unfold and never sends twice", async () => {
		await mountMessage(message);
		await act(async () => rows()[0].querySelector("[data-memory-recall-rate]")?.click());
		await act(async () => toggle()?.click());
		expect(rows()).toHaveLength(0);
		await act(async () => toggle()?.click());
		const rate = rows()[0].querySelector("[data-memory-recall-rate]");
		expect(rate?.getAttribute("data-memory-recall-rate")).toBe("done");
		await act(async () => rate?.click());
		expect(feedback).toHaveBeenCalledTimes(1);
	});

	it("keeps the done state when the line is mounted again", async () => {
		await mountMessage(message);
		await act(async () => rows()[0].querySelector("[data-memory-recall-rate]")?.click());
		await act(async () => root.unmount());
		container.remove();
		await mountMessage(message);
		expect(rows()[0].querySelector("[data-memory-recall-rate]")?.getAttribute("data-memory-recall-rate")).toBe(
			"done",
		);
		expect(feedback).toHaveBeenCalledTimes(1);
	});

	it("hides Not helpful on a paired page without host-admin, keeping Open in Memory", async () => {
		host.grants = ["workspace", "device-self"];
		await mountMessage(message);
		expect(rows()[0].querySelector("[data-memory-recall-rate]")).toBeNull();
		expect(rows()[0].querySelector("[data-memory-recall-open]")).not.toBeNull();
	});

	it("shows Not helpful on a paired page that holds host-admin", async () => {
		host.grants = ["workspace", "host-admin"];
		await mountMessage(message);
		expect(rows()[0].querySelector("[data-memory-recall-rate]")).not.toBeNull();
	});

	it("wraps a long title instead of cutting it, keeping the full title as the tooltip", async () => {
		await mountMessage(message);
		const title = rows()[0].querySelector("[data-memory-recall-title]");
		expect(title?.getAttribute("title")).toBe("Jev 1.14 pinned");
		expect(title?.getAttribute("class")).toContain("break-words");
		expect(title?.getAttribute("class")).not.toContain("truncate");
	});
});
