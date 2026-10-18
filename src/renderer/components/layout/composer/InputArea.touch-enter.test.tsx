import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import type * as ShellMode from "../../../hooks/use-shell-mode";
import { resetHardwareKeyboardForTests } from "../../../lib/hardware-keyboard";
import { I18nProvider } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useInputHistoryStore } from "../../../stores/input-history";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import { InputArea } from "./InputArea";

/** The input the shell reports: touch (a phone or tablet) or none (the desktop). */
const input = vi.hoisted(() => ({ current: "touch" as "touch" | null }));
vi.mock("../../../hooks/use-shell-mode", async importOriginal => ({
	...(await importOriginal<typeof ShellMode>()),
	useShellInput: () => input.current,
}));

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.setSelectionRange !== "function")
	elementPrototype.setSelectionRange = function (this: Record<string, unknown>, start: number, end: number) {
		this.selectionStart = start;
		this.selectionEnd = end;
	};
elementPrototype.getBoundingClientRect = () => ({
	bottom: 0,
	height: 0,
	left: 0,
	right: 0,
	top: 0,
	width: 0,
	x: 0,
	y: 0,
	toJSON: () => ({}),
});
Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });

interface TestElement {
	textContent: string | null;
	remove(): void;
	getAttribute(name: string): string | null;
	querySelector(selector: string): TestElement | null;
}

type Handler = (event: Record<string, unknown>) => void;

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let rpcCommand: Mock<(command: RpcCommand) => Promise<RpcResponse>>;
let prompt: Mock<(...args: unknown[]) => Promise<unknown>>;

function propsOf(element: unknown): Record<string, Handler | undefined> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("element has no React props");
	return record[key] as Record<string, Handler | undefined>;
}

function findTextarea(): TestElement {
	const textarea = document.querySelector("textarea") as unknown as TestElement | null;
	if (!textarea) throw new Error("composer textarea not found");
	return textarea;
}

async function typeInto(value: string): Promise<void> {
	const element = findTextarea();
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else (element as unknown as { value: string }).value = value;
	await act(async () => propsOf(element).onChange?.({ target: element, currentTarget: element }));
}

/** A keydown on the field; the result says whether the composer kept the browser from adding its own line. */
async function press(key: string, init: Record<string, unknown> = {}): Promise<{ prevented: boolean }> {
	let prevented = false;
	await act(async () =>
		propsOf(findTextarea()).onKeyDown?.({
			key,
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			repeat: false,
			nativeEvent: { isComposing: false },
			preventDefault: () => {
				prevented = true;
			},
			stopPropagation: () => {},
			...init,
		}),
	);
	return { prevented };
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

const sent = () => [
	...prompt.mock.calls,
	...rpcCommand.mock.calls.map(([command]) => [command]).filter(([command]) => command.type !== "get_queue"),
];

async function mount(): Promise<void> {
	prompt = vi.fn(async () => ok());
	rpcCommand = vi.fn(async (command: RpcCommand) => {
		if (command.type === "get_queue") return ok({ steering: [], followUp: [] });
		return ok();
	});
	(window as unknown as Record<string, unknown>).omp = {
		fs: { list: vi.fn(async () => ({ entries: [] })) },
		events: { onTabCommandsUpdate: vi.fn(() => () => {}), onConfigUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
		rpc: {
			historyRecent: vi.fn(async () => ok([])),
			historySearch: vi.fn(async () => ok([])),
			getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
			command: rpcCommand,
			prompt,
		},
	};
	useSessionStore.setState({
		status: "ready",
		isStreaming: false,
		queuedMessageCount: 0,
		cwd: "/tmp",
		sessionId: "s1",
		sessionFile: null,
		sessionName: null,
	});
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<InputArea />
			</I18nProvider>,
		);
	});
	await flush();
}

beforeEach(() => {
	input.current = "touch";
	resetHardwareKeyboardForTests();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useComposerStore.getState().reset();
	useInputHistoryStore.setState({ entries: [], navIndex: -1, navDraft: "", navContext: undefined });
	useNextPromptStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ displayPreferences: {} });
	vi.restoreAllMocks();
});

describe("Enter on a touch keyboard", () => {
	it("adds a line and sends nothing; the field asks the keyboard for a return key", async () => {
		await mount();
		await typeInto("first line");
		expect((propsOf(findTextarea()) as Record<string, unknown>).enterKeyHint).toBe("enter");
		const { prevented } = await press("Enter");
		expect(prevented).toBe(false);
		expect(sent()).toEqual([]);
		expect(useComposerStore.getState().draft).toBe("first line");
	});

	it("the Send button sends the draft", async () => {
		await mount();
		await typeInto("first line");
		const send = document.querySelector(
			'button[aria-label="Send"], button[aria-label="보내기"]',
		) as unknown as TestElement | null;
		expect(send).not.toBeNull();
		await act(async () => propsOf(send)?.onClick?.({ preventDefault: () => {} }));
		expect(JSON.stringify(sent())).toContain("first line");
	});

	it("a Korean composition's Enter never sends and never reaches the newline rule", async () => {
		await mount();
		await typeInto("한");
		const { prevented } = await press("Enter", { nativeEvent: { isComposing: true } });
		expect(prevented).toBe(false);
		expect(sent()).toEqual([]);
	});

	it("a physical keyboard's key makes Enter send like a desktop's", async () => {
		await mount();
		await typeInto("typed with a keyboard");
		await press("ArrowLeft");
		const { prevented } = await press("Enter");
		expect(prevented).toBe(true);
		expect(JSON.stringify(sent())).toContain("typed with a keyboard");
	});

	it("⌘↵ sends even before a physical key was seen", async () => {
		await mount();
		await typeInto("chord send");
		const { prevented } = await press("Enter", { metaKey: true });
		expect(prevented).toBe(true);
		expect(JSON.stringify(sent())).toContain("chord send");
	});

	it('the "Enter sends on mobile" setting makes a touch Enter send', async () => {
		useUiStore.setState({ displayPreferences: { mobileEnterSends: true } });
		await mount();
		await typeInto("send me");
		expect((propsOf(findTextarea()) as Record<string, unknown>).enterKeyHint).toBeUndefined();
		const { prevented } = await press("Enter");
		expect(prevented).toBe(true);
		expect(JSON.stringify(sent())).toContain("send me");
	});

	it("the desktop is unchanged: Enter sends, Shift+Enter adds a line, no return-key hint", async () => {
		input.current = null;
		await mount();
		await typeInto("desktop");
		expect((propsOf(findTextarea()) as Record<string, unknown>).enterKeyHint).toBeUndefined();
		expect((await press("Enter", { shiftKey: true })).prevented).toBe(false);
		expect(sent()).toEqual([]);
		expect((await press("Enter")).prevented).toBe(true);
		expect(JSON.stringify(sent())).toContain("desktop");
	});
});
