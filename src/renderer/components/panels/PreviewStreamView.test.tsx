import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewStreamDialog, PreviewStreamFrame, PreviewStreamPoll } from "../../../shared/preview";
import { I18nProvider, translate } from "../../lib/i18n";
import { PreviewStreamView } from "./PreviewStreamView";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true });
// A frame 390 × 600 CSS px at the surface's corner: a point's fraction is its position over these.
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
	configurable: true,
	value: () => ({ left: 0, top: 0, width: 390, height: 600, right: 390, bottom: 600, x: 0, y: 0 }),
});

let root: Root | undefined;
let container: HTMLElement;

const frame = (seq: number, tab = "t1"): PreviewStreamFrame => ({
	seq,
	tab,
	width: 780,
	height: 1200,
	rect: { x: 0, y: 0, width: 390, height: 600 },
	jpeg: "AAAA",
});

interface Stream {
	polls: Array<{ ack: number | null }>;
	input: ReturnType<typeof vi.fn>;
	answerDialog: ReturnType<typeof vi.fn>;
	selectedText: ReturnType<typeof vi.fn>;
}

/** `answers` are handed out one per poll; after them a poll is held forever (a still page). */
function install(answers: PreviewStreamPoll[]): Stream {
	const polls: Array<{ ack: number | null }> = [];
	const stream: Stream = {
		polls,
		input: vi.fn(),
		answerDialog: vi.fn().mockResolvedValue(undefined),
		selectedText: vi.fn().mockResolvedValue("selected"),
	};
	Reflect.set(window, "omp", {
		preview: {
			stream: {
				poll: vi.fn(async (request: { ack: number | null }) => {
					polls.push({ ack: request.ack });
					const next = answers.shift();
					return next ?? new Promise<PreviewStreamPoll>(() => {});
				}),
				input: stream.input,
				answerDialog: stream.answerDialog,
				selectedText: stream.selectedText,
			},
		},
	});
	return stream;
}

async function mount(tab = "t1", active = true) {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<PreviewStreamView active={active} tab={tab} />
			</I18nProvider>,
		),
	);
	await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
}

const fire = (target: Element | null, type: string, props: Record<string, unknown> = {}) =>
	act(async () => {
		const event = new window.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, props);
		target?.dispatchEvent(event);
	});
const touch = (type: string, x: number, y: number) => ({
	pointerType: "touch",
	pointerId: 1,
	clientX: x,
	clientY: y,
	button: 0,
	type,
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("PreviewStreamView", () => {
	it("shows each frame where the host placed it and acknowledges it with the next poll", async () => {
		vi.useFakeTimers();
		const stream = install([{ frame: frame(1), dialogs: [] }]);
		await mount();
		const image = container.querySelector("[data-preview-stream-frame]") as HTMLElement;
		expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
		expect(image.style.width).toBe("390px");
		expect(stream.polls).toEqual([{ ack: null }, { ack: 1 }]);
	});

	it("drops a frame of another tab but still acknowledges it, and polls nothing while inactive", async () => {
		vi.useFakeTimers();
		const stream = install([{ frame: frame(1, "old"), dialogs: [] }]);
		await mount("t1");
		expect(container.querySelector("[data-preview-stream-frame]")).toBeNull();
		expect(container.querySelector("[data-preview-stream-connecting]")).not.toBeNull();
		expect(stream.polls).toEqual([{ ack: null }, { ack: 1 }]);
		await act(async () => root?.unmount());
		const idle = install([]);
		await mount("t1", false);
		expect(idle.polls).toEqual([]);
	});

	it("turns a tap into a click at the same place, as fractions of the frame", async () => {
		vi.useFakeTimers();
		const stream = install([{ frame: frame(1), dialogs: [] }]);
		await mount();
		const image = container.querySelector("[data-preview-stream-frame]");
		await fire(image, "pointerdown", touch("pointerdown", 195, 300));
		await fire(image, "pointerup", touch("pointerup", 195, 300));
		expect(stream.input).toHaveBeenCalledWith([{ t: "tap", x: 0.5, y: 0.5 }]);
	});

	it("scrolls the page with a swipe", async () => {
		vi.useFakeTimers();
		const stream = install([{ frame: frame(1), dialogs: [] }]);
		await mount();
		const image = container.querySelector("[data-preview-stream-frame]");
		await fire(image, "pointerdown", touch("pointerdown", 100, 300));
		await fire(image, "pointermove", touch("pointermove", 100, 250));
		expect(stream.input).toHaveBeenCalledWith([{ t: "wheel", x: 100 / 390, y: 250 / 600, dx: 0, dy: 50 }]);
	});

	it("forwards a click of the mouse and its drag", async () => {
		vi.useFakeTimers();
		const stream = install([{ frame: frame(1), dialogs: [] }]);
		await mount();
		const image = container.querySelector("[data-preview-stream-frame]");
		const mouse = (type: string, x: number, y: number) => ({
			pointerType: "mouse",
			pointerId: 1,
			clientX: x,
			clientY: y,
			button: 0,
			detail: 1,
			type,
		});
		await fire(image, "pointerdown", mouse("pointerdown", 39, 60));
		await fire(image, "pointerup", mouse("pointerup", 39, 60));
		expect(stream.input).toHaveBeenLastCalledWith([{ t: "tap", x: 0.1, y: 0.1 }]);
		await fire(image, "pointerdown", mouse("pointerdown", 39, 60));
		await fire(image, "pointermove", mouse("pointermove", 195, 300));
		await fire(image, "pointerup", mouse("pointerup", 195, 300));
		const sent = stream.input.mock.calls.map(([events]) => events[0]);
		expect(sent.slice(-3)).toEqual([
			{ t: "drag", phase: "start", x: 0.1, y: 0.1 },
			{ t: "drag", phase: "move", x: 0.5, y: 0.5 },
			{ t: "drag", phase: "end", x: 0.5, y: 0.5 },
		]);
	});

	it("sends special keys as keys and committed text as text, and a composition only once it is committed", async () => {
		vi.useFakeTimers();
		const stream = install([{ frame: frame(1), dialogs: [] }]);
		await mount();
		const field = container.querySelector("[data-preview-stream-input]");
		// (A `keydown` is mapped by lib/preview-keyboard.ts, tested there: linkedom cannot drive React's key path.)
		await fire(field, "beforeinput", { inputType: "insertLineBreak", data: null, isComposing: false });
		expect(stream.input).toHaveBeenLastCalledWith([{ t: "key", key: "Enter" }]);
		await fire(field, "beforeinput", { inputType: "insertText", data: "a", isComposing: false });
		expect(stream.input).toHaveBeenLastCalledWith([{ t: "text", text: "a" }]);
		const calls = stream.input.mock.calls.length;
		await fire(field, "compositionstart", {});
		await fire(field, "compositionupdate", { data: "ㅎ" });
		expect(container.querySelector("[data-preview-stream-composing]")?.textContent).toBe("ㅎ");
		await fire(field, "beforeinput", { inputType: "insertCompositionText", data: "ㅎ", isComposing: true });
		expect(stream.input.mock.calls.length).toBe(calls);
		await fire(field, "compositionend", { data: "한" });
		expect(stream.input).toHaveBeenLastCalledWith([{ t: "text", text: "한" }]);
		expect(container.querySelector("[data-preview-stream-composing]")).toBeNull();
	});

	it("shows the page's dialog as a sheet and answers it", async () => {
		vi.useFakeTimers();
		const confirm: PreviewStreamDialog = { id: 7, kind: "confirm", message: "Delete it?", initial: null };
		const prompt: PreviewStreamDialog = { id: 8, kind: "prompt", message: "Name?", initial: "Ada" };
		const stream = install([{ frame: frame(1), dialogs: [confirm, prompt] }]);
		await mount();
		const sheet = () => document.body.querySelector("[data-preview-dialog]");
		expect(sheet()?.textContent).toContain("Delete it?");
		await fire(document.body.querySelector("[data-preview-dialog-ok]"), "click");
		expect(stream.answerDialog).toHaveBeenCalledWith(7, { accept: true });
		// The next one is the prompt, holding its default text; the answer carries the text.
		expect(sheet()?.getAttribute("data-preview-dialog")).toBe("prompt");
		const input = document.body.querySelector("[data-preview-dialog-input]") as HTMLInputElement;
		expect(input.value).toBe("Ada");
		await fire(document.body.querySelector("[data-preview-dialog-cancel]"), "click");
		expect(stream.answerDialog).toHaveBeenLastCalledWith(8, { accept: false });
		expect(sheet()).toBeNull();
	});

	it("copies the page's selection to this device's clipboard", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const stream = install([{ frame: frame(1), dialogs: [] }]);
		await mount();
		await fire(container.querySelector("[data-preview-stream-copy]"), "click");
		expect(stream.selectedText).toHaveBeenCalledOnce();
		expect(writeText).toHaveBeenCalledWith("selected");
		vi.unstubAllGlobals();
	});

	it("says so while the link is down and shows the connecting state before the first frame", async () => {
		vi.useFakeTimers();
		install([]);
		await mount();
		expect(container.textContent).toContain(translate("panel.preview.stream.connecting"));
	});
});
