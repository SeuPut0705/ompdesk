/**
 * ComposerQueue: the single queued-message surface attached to the composer.
 * Lists both lanes, sends a follow-up now (moves it to the steering lane),
 * edits in place (Enter saves, Escape cancels without reaching the app-wide
 * Escape that aborts the turn) and renders nothing when the queue is empty.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { ComposerQueue } from "./ComposerQueue";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	value?: string;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let queueMove: Mock;
let queueEdit: Mock;
let queueRemove: Mock;

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

function buttonByLabel(label: string): TestElement {
	const button = document.querySelector(`button[aria-label="${label}"]`) as unknown as TestElement | null;
	if (!button) throw new Error(`missing button ${label}`);
	return button;
}

type EditorProps = {
	onKeyDown: (event: Record<string, unknown>) => void;
	onChange: (event: Record<string, unknown>) => void;
};

/** linkedom lacks the input-event support React's keydown path needs; drive the props directly. */
function editorProps(): EditorProps {
	const editor = document.querySelector('textarea[aria-label="Queued message text"]') as unknown as Record<
		string,
		unknown
	> | null;
	if (!editor) throw new Error("queue editor missing");
	const key = Object.getOwnPropertyNames(editor).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("queue editor props missing");
	return editor[key] as EditorProps;
}

async function pressKey(key: string): Promise<{ prevented: boolean; stopped: boolean }> {
	const state = { prevented: false, stopped: false };
	await act(async () =>
		editorProps().onKeyDown({
			key,
			shiftKey: false,
			keyCode: 0,
			nativeEvent: { isComposing: false },
			preventDefault: () => {
				state.prevented = true;
			},
			stopPropagation: () => {
				state.stopped = true;
			},
		}),
	);
	return state;
}

function queued(id: string, text: string): RpcQueuedMessage {
	return { id, text, editable: true, timestamp: 1 };
}

async function mount(steering: RpcQueuedMessage[], followUp: RpcQueuedMessage[]): Promise<void> {
	queueRemove = vi.fn(async () => ok({ removed: true }));
	queueMove = vi.fn(async () => ok({ lane: "steering", index: 0 }));
	queueEdit = vi.fn(async () => ok({ updated: true }));
	(window as unknown as Record<string, unknown>).omp = {
		rpc: {
			getQueue: vi.fn(async () => ok({ steering, followUp })),
			queueEdit,
			queueMove,
			queueRemove,
			queueClear: vi.fn(async () => ok({ removed: 0 })),
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
				<ComposerQueue />
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("ComposerQueue", () => {
	it("renders nothing while the queue is empty", async () => {
		await mount([], []);
		expect(container.textContent).toBe("");
	});

	it("lists both lanes in delivery order under one count", async () => {
		await mount([queued("s1", "steer first")], [queued("f1", "follow later")]);
		const section = document.querySelector('section[aria-label="Queued"]') as unknown as TestElement | null;
		expect(section?.textContent).toContain("Queued2");
		const rows = Array.from(document.querySelectorAll("li")) as unknown as TestElement[];
		expect(rows.map(row => row.textContent)).toEqual([
			expect.stringContaining("steer first"),
			expect.stringContaining("follow later"),
		]);
	});

	it("sends a follow-up now by moving it to the end of the steering lane", async () => {
		await mount([], [queued("f1", "follow later")]);
		await click(buttonByLabel("Send now as a steer"));
		expect(queueMove).toHaveBeenCalledWith("f1", Number.MAX_SAFE_INTEGER, "steering");
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["f1"]);
	});

	it("shows Send now only on follow-up rows, as stock promotes only follow-ups", async () => {
		await mount([queued("s1", "steer first")], [queued("f1", "follow later")]);
		const [steerRow, followUpRow] = Array.from(document.querySelectorAll("li"));
		expect(steerRow?.querySelector('button[aria-label="Send now as a steer"]')).toBeNull();
		expect(followUpRow?.querySelector('button[aria-label="Send now as a steer"]')).not.toBeNull();
	});

	it("removes only the clicked row, by its stable queue id", async () => {
		await mount([queued("s1", "same"), queued("s2", "same")], [queued("f1", "follow later")]);
		const removeButtons = Array.from(
			document.querySelectorAll('button[aria-label="Remove"]'),
		) as unknown as TestElement[];
		expect(removeButtons).toHaveLength(3);
		await click(removeButtons[1]!);
		expect(queueRemove).toHaveBeenCalledTimes(1);
		expect(queueRemove).toHaveBeenCalledWith("s2");
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1"]);
		expect(useQueueStore.getState().followUp.map(entry => entry.id)).toEqual(["f1"]);
	});

	it("cancels an edit on Escape without letting it reach the app-wide Escape", async () => {
		await mount([queued("s1", "before")], []);
		await click(buttonByLabel("Edit"));
		const result = await pressKey("Escape");

		expect(result).toEqual({ prevented: true, stopped: true });
		expect(document.querySelector("textarea")).toBeNull();
		expect(queueEdit).not.toHaveBeenCalled();
	});

	it("saves an edit on Enter", async () => {
		await mount([queued("s1", "before")], []);
		await click(buttonByLabel("Edit"));
		await act(async () => editorProps().onChange({ target: { value: "after" } }));
		await pressKey("Enter");
		await flush();
		expect(queueEdit).toHaveBeenCalledWith("s1", "after");
	});
});
