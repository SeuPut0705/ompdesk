/**
 * The composer's queue pill and its popover: the one surface for messages waiting on the agent. The pill counts them
 * (and says "Edited · now last" for a moment after an edit), the popover lists both lanes under their headings with
 * the policy line, rows are named by their text, Steer now moves a follow-up to the steering lane, Edit hands the
 * message to the composer field, and the polite live region says what happened.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcQueuedMessage } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useQueueStore } from "../../../stores/queue";
import { useSessionStore } from "../../../stores/session";
import { useSettingsStore } from "../../../stores/settings";
import { ComposerQueueLive, ComposerQueuePill } from "./ComposerQueue";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
// The popover places itself from its anchor and its own box.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
Object.defineProperty(proto, "getBoundingClientRect", {
	configurable: true,
	value: () => ({ width: 100, height: 28, left: 300, top: 700, right: 400, bottom: 728 }),
});
Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 448 });
Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 300 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

interface TestElement {
	textContent: string | null;
	getAttribute(name: string): string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): ArrayLike<TestElement>;
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let queueMove: Mock;
let queueEdit: Mock;
let queueRemove: Mock;
let queueClear: Mock;
let getQueue: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function click(element: TestElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

function byLabel(label: string): TestElement {
	const element = document.querySelector(`button[aria-label="${label}"]`) as unknown as TestElement | null;
	if (!element) throw new Error(`missing button ${label}`);
	return element;
}

function pill(): TestElement | null {
	return document.querySelector("[data-queue-pill]") as unknown as TestElement | null;
}

async function openPopover(): Promise<void> {
	const trigger = pill();
	if (!trigger) throw new Error("pill missing");
	await click(trigger);
}

function queued(id: string, text: string, extra: Partial<RpcQueuedMessage> = {}): RpcQueuedMessage {
	return { id, text, editable: true, timestamp: 1, ...extra };
}

/** The composer's focus hand-back, called once a control is gone with its row. */
let settled: Mock<() => void>;

async function mount(steering: RpcQueuedMessage[], followUp: RpcQueuedMessage[]): Promise<void> {
	settled = vi.fn();
	queueRemove = vi.fn(async () => ok({ removed: true }));
	queueMove = vi.fn(async () => ok({ lane: "steering", index: 0 }));
	queueEdit = vi.fn(async () => ok({ updated: true }));
	queueClear = vi.fn(async () => ok({ removed: 0 }));
	getQueue = vi.fn(async () => ok({ steering, followUp }));
	(window as unknown as Record<string, unknown>).omp = {
		rpc: {
			getQueue,
			queueEdit,
			queueMove,
			queueRemove,
			queueClear,
		},
	};
	useSessionStore.setState({ status: "ready" });
	useQueueStore.getState().setFromFrame({ steering, followUp });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ComposerQueuePill onSettled={settled} />
				<ComposerQueueLive />
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.body.innerHTML = "";
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
	useQueueStore.setState({ moved: null });
	useComposerStore.getState().reset();
	useSettingsStore.getState().reset();
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("ComposerQueuePill", () => {
	it("renders no pill while the queue is empty", async () => {
		await mount([], []);
		expect(pill()).toBeNull();
	});

	it("shows the tab's queue as its hydrate and frames left it, reading nothing itself on mount", async () => {
		await mount([queued("s1", "steer")], []);
		expect(getQueue).not.toHaveBeenCalled();
		expect(pill()?.textContent).toContain("1 queued");
		await act(async () =>
			useQueueStore.getState().setFromFrame({ steering: [], followUp: [queued("f1", "one"), queued("f2", "two")] }),
		);
		expect(pill()?.textContent).toContain("2 queued");
		expect(getQueue).not.toHaveBeenCalled();
	});

	it("counts the queued messages in one pill and adds nothing to the composer until it opens", async () => {
		await mount([queued("s1", "steer first")], [queued("f1", "follow later"), queued("f2", "follow too")]);
		expect(pill()?.textContent).toContain("3 queued");
		expect(pill()?.getAttribute("aria-label")).toBe("Show 3 queued messages");
		expect(pill()?.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector("[data-queue-popover]")).toBeNull();
		expect(document.querySelector(".omp-composer-queue")).toBeNull();
	});

	it("opens a popover with one heading per lane and its count", async () => {
		await mount([queued("s1", "steer first")], [queued("f1", "follow later"), queued("f2", "follow too")]);
		await openPopover();
		expect(pill()?.getAttribute("aria-expanded")).toBe("true");
		const heads = Array.from(document.querySelectorAll("[data-lane-head]")) as unknown as TestElement[];
		expect(heads.map(head => head.textContent)).toEqual([
			"After next step1· arrive togetherClear",
			"After this turn2· sent one by oneClear",
		]);
		const rows = Array.from(document.querySelectorAll("[data-queue-row]")) as unknown as TestElement[];
		expect(rows.map(row => row.getAttribute("data-lane"))).toEqual(["steering", "followUp", "followUp"]);
	});

	it("skips the heading of an empty lane", async () => {
		await mount([], [queued("f1", "only follow")]);
		await openPopover();
		const heads = Array.from(document.querySelectorAll("[data-lane-head]")) as unknown as TestElement[];
		expect(heads.map(head => head.getAttribute("data-lane-head"))).toEqual(["followUp"]);
	});

	it("states the policy of the real steering and interrupt settings", async () => {
		await mount([queued("s1", "steer")], []);
		useSettingsStore.getState().update({ steeringMode: "all", interruptMode: "wait" });
		await openPopover();
		const policy = () => document.querySelector("[data-queue-policy]")?.textContent;
		expect(policy()).toBe("Steers arrive together · running tools are not interrupted");
		await act(async () =>
			useSettingsStore.getState().update({ steeringMode: "one-at-a-time", interruptMode: "immediate" }),
		);
		expect(policy()).toBe("Steers arrive one at a time · a steer interrupts the running tool");
	});

	it("names every row action by the start of its message", async () => {
		const long = "Please also double check the retry budget in sync/worker.ts and keep the public API";
		await mount([queued("s1", "steer first")], [queued("f1", long)]);
		await openPopover();
		expect(byLabel("Edit: steer first")).toBeDefined();
		expect(byLabel("Move after this turn: steer first")).toBeDefined();
		expect(byLabel("More actions: steer first")).toBeDefined();
		const name = `${long.slice(0, 39)}…`;
		expect(name).toHaveLength(40);
		expect(byLabel(`Steer now: ${name}`)).toBeDefined();
		expect(byLabel(`Edit: ${name}`)).toBeDefined();
	});

	it("offers Steer now as the primary action of follow-ups only", async () => {
		await mount([queued("s1", "steer first")], [queued("f1", "follow later")]);
		await openPopover();
		const [steerRow, followRow] = Array.from(
			document.querySelectorAll("[data-queue-row]"),
		) as unknown as TestElement[];
		expect(steerRow?.querySelector('[aria-label^="Steer now"]')).toBeNull();
		expect(followRow?.querySelector('[aria-label^="Steer now"]')?.textContent).toBe("Steer now");
		await click(byLabel("Steer now: follow later"));
		expect(queueMove).toHaveBeenCalledWith("f1", Number.MAX_SAFE_INTEGER, "steering");
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1", "f1"]);
	});

	it("shows the whole message when its text is clicked", async () => {
		await mount([], [queued("f1", "line one\nline two")]);
		await openPopover();
		const text = document.querySelector("[data-queue-row-text]") as unknown as TestElement;
		expect(text.getAttribute("aria-expanded")).toBe("false");
		await click(text);
		expect(text.getAttribute("aria-expanded")).toBe("true");
		await click(text);
		expect(text.getAttribute("aria-expanded")).toBe("false");
	});

	it("hands a message to the composer field on Edit, keeping the draft and pictures it replaces", async () => {
		const image = { content: { type: "image" as const, data: "AA==", mimeType: "image/png" }, preview: "p" };
		useComposerStore.getState().setDraft("my draft");
		useComposerStore.getState().setImages([image]);
		await mount([queued("s1", "queued text")], []);
		await openPopover();
		await click(byLabel("Edit: queued text"));
		const state = useComposerStore.getState();
		expect(state.editingQueued).toMatchObject({ id: "s1", lane: "steering", original: "queued text" });
		expect(state.editingQueued?.snapshot).toEqual({ draft: "my draft", images: [image] });
		expect(state.draft).toBe("queued text");
		expect(state.images).toEqual([]);
		expect(settled).toHaveBeenCalledTimes(1);
		// The field is the editor now: no pill, no popover.
		expect(pill()).toBeNull();
		expect(document.querySelector("[data-queue-popover]")).toBeNull();
		await act(async () => useComposerStore.getState().endEditQueued());
		expect(useComposerStore.getState().draft).toBe("my draft");
		expect(useComposerStore.getState().images).toEqual([image]);
	});

	it("gives no Edit to a picture-only message and labels it with the picture count", async () => {
		const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
		await mount([], []);
		// The way a send into a running turn gets here: the renderer remembers the pictures for stock's "[Image]" chip.
		useQueueStore.getState().expectImages("[Image]", [image, image]);
		await act(async () =>
			useQueueStore
				.getState()
				.setFromFrame({ steering: [], followUp: [queued("f1", "[Image]", { editable: false })] }),
		);
		await openPopover();
		expect(document.querySelector('button[aria-label^="Edit"]')).toBeNull();
		const row = document.querySelector("[data-queue-row]") as unknown as TestElement;
		expect(row.textContent).toContain("Image only · 2");
		expect(row.querySelectorAll("[data-queue-images] img")).toHaveLength(2);
		expect(row.querySelector("[data-queue-images]")?.textContent).toContain("2 images");
	});

	it("clears both lanes", async () => {
		await mount([queued("s1", "one")], [queued("f1", "two")]);
		await openPopover();
		const clear = document.querySelector("[data-queue-clear]") as unknown as TestElement;
		await click(clear);
		expect(queueClear).toHaveBeenCalledWith("steering");
		expect(queueClear).toHaveBeenCalledWith("followUp");
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it("clears one lane from its heading and keeps the other", async () => {
		await mount([queued("s1", "one")], [queued("f1", "two")]);
		await openPopover();
		const clear = document.querySelector('[data-lane-clear="followUp"]') as unknown as TestElement;
		await click(clear);
		expect(queueClear).toHaveBeenCalledWith("followUp");
		expect(queueClear).not.toHaveBeenCalledWith("steering");
	});

	it("tells where an edit landed: the pill reads Edited · now last and the row carries the note", async () => {
		await mount([], [queued("f1", "one"), queued("f2", "two")]);
		await act(async () =>
			useQueueStore.getState().noteMoved({ id: "f1", lane: "followUp", position: 2, count: 2, kind: "edit" }),
		);
		await flush();
		expect(pill()?.textContent).toContain("Edited · now last");
		await openPopover();
		expect(document.querySelector("[data-queue-moved-note]")?.textContent).toBe(
			"Edited · now last in “After this turn”",
		);
		await act(async () =>
			useQueueStore.getState().noteMoved({ id: "f2", lane: "followUp", position: 2, count: 2, kind: "lane" }),
		);
		await flush();
		expect(document.querySelector("[data-queue-moved-note]")?.textContent).toBe(
			"Moved · now last in “After this turn”",
		);
		expect(pill()?.textContent).toContain("2 queued");
	});
});

describe("ComposerQueueLive", () => {
	/** The queue hydrates right after mount: the region stays quiet for the first moments. */
	const QUIET = 850;
	async function quiet(): Promise<void> {
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, QUIET);
			await promise;
		});
	}
	const live = () => document.querySelector("[data-composer-live]") as unknown as TestElement;

	it("is one polite status region, empty until something happens", async () => {
		await mount([queued("s1", "one")], []);
		expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
		expect(live().getAttribute("aria-live")).toBe("polite");
		expect(live().textContent).toBe("");
	});

	it("says Queued (n) when a message joins and where an edited one landed", async () => {
		await mount([queued("s1", "one")], []);
		await quiet();
		await act(async () =>
			useQueueStore.getState().setFromFrame({ steering: [queued("s1", "one")], followUp: [queued("f1", "two")] }),
		);
		expect(live().textContent).toBe("Queued (2)");
		await act(async () =>
			useQueueStore.getState().noteMoved({ id: "f1", lane: "followUp", position: 1, count: 1, kind: "edit" }),
		);
		expect(live().textContent).toBe("Message moved to the end of After this turn");
	});

	it("says a Stop brought the queue back", async () => {
		await mount([queued("s1", "one")], []);
		await quiet();
		await act(async () => {
			useComposerStore.getState().holdRestored([{ lane: "steering", text: "one", images: [] }]);
		});
		expect(live().textContent).toBe("Stopped. 1 queued messages are back, nothing will send until you resume");
	});
});
