/**
 * DOM smoke tests for Side panel › Tree: empty state, flat-chain fallback vs
 * rich get_session_tree rendering (nodes, fork edges, HEAD, active-branch
 * highlight), pan/zoom/node-drag interactions, the node actions, label
 * editing, and the wide view Sheet. Rendered with react-dom/client into a
 * linkedom document (same harness as ForkHandoffDialogs.test.tsx).
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { routeCommands } from "../../test-support/route-commands";
import { SessionTreePanel } from "./SessionTreePanel";
import type { SessionTreeResult } from "./session-tree-layout";

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
// MenuButton anchors its menu on the trigger's rect and clamps it to the viewport.
elementPrototype.getBoundingClientRect = () => ({
	bottom: 0,
	height: 0,
	left: 0,
	right: 0,
	top: 0,
	width: 0,
	x: 0,
	y: 0,
});
Object.assign(window, { innerWidth: 1280, innerHeight: 800 });

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	className: string;
	disabled: boolean;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

function failure(error: string): RpcResponse {
	return { type: "response", command: "test", success: false, error };
}

/** A linear session tree: each user message parents to the previous one, the last is the leaf. */
function linearTree(messages: Array<{ entryId: string; text: string }>): RpcResponse {
	const tree: SessionTreeResult["tree"] = messages.map((message, index) => ({
		entryId: message.entryId,
		parentId: index === 0 ? null : (messages[index - 1]?.entryId ?? null),
		role: "user",
		textPreview: message.text,
		timestamp: 0,
		onActiveBranch: true,
		isLeaf: index === messages.length - 1,
	}));
	return success({ tree, activeLeafId: null });
}

interface MockRpc {
	getSessionTree: Mock<() => Promise<RpcResponse>>;
	branch: Mock<(entryId: string) => Promise<RpcResponse>>;
	getState: Mock<() => Promise<RpcResponse>>;
	switchLeaf: Mock<
		(entryId: string, options?: { summarize?: boolean; customInstructions?: string }) => Promise<RpcResponse>
	>;
	getMessages: Mock<() => Promise<RpcResponse>>;
	getTranscriptPage: Mock<() => Promise<RpcResponse>>;
	getSubagents: Mock<() => Promise<RpcResponse>>;
	setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
}

function installMockOmp(overrides: Partial<MockRpc> = {}): MockRpc {
	const rpc: MockRpc = {
		getSessionTree: vi.fn(async () => linearTree([])),
		branch: vi.fn(async () => success({ text: "", cancelled: false })),
		getState: vi.fn(async () => success({ sessionId: "s2", todoPhases: [], messageCount: 3, queuedMessageCount: 0 })),
		switchLeaf: vi.fn(async () => success({ cancelled: false, activeLeafId: "m1" })),
		getMessages: vi.fn(async () => success({ messages: [] })),
		getTranscriptPage: vi.fn(async () => success({ messages: [], totalMessages: 0 })),
		getSubagents: vi.fn(async () => success({ subagents: [] })),
		setSubagentSubscription: vi.fn(async () => success({})),
		...overrides,
	};
	// linkedom's window lacks the preload bridge; install the mock OmpApi on it.
	const ompWindow = window as unknown as { omp: { rpc: MockRpc } };
	ompWindow.omp = { rpc: routeCommands(rpc) };
	return rpc;
}

let container: TestElement;
let root: Root;

beforeEach(() => {
	useSessionStore.setState({ status: "ready" });
});

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

const CANVAS = '[aria-label="Session tree canvas"]';

function canvas(): TestElement {
	const el = queryAll(CANVAS)[0];
	if (!el) throw new Error("canvas not rendered");
	return el;
}

function nodeCards(): TestElement[] {
	return queryAll("[data-tree-node]");
}

function edgePaths(): TestElement[] {
	return queryAll("path").filter(path => path.getAttribute("marker-end") !== null);
}

/** Dispatch an event inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

/** Dispatch a pointer event with the properties React reads patched on. */
async function pointer(
	target: TestElement,
	type: "pointerdown" | "pointermove" | "pointerup",
	x: number,
	y: number,
): Promise<void> {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const patched = event as unknown as {
		button: number;
		clientX: number;
		clientY: number;
		pointerId: number;
	};
	patched.button = 0;
	patched.clientX = x;
	patched.clientY = y;
	patched.pointerId = 1;
	await dispatch(target, event);
}

/** Dispatch a bubbling keydown with `key` patched on; returns the event for defaultPrevented checks. */
async function key(target: TestElement, value: string): Promise<{ defaultPrevented: boolean }> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	(event as unknown as { key: string }).key = value;
	await dispatch(target, event);
	return event;
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

function seedSession(sessionId: string): void {
	useSessionStore.setState({ sessionId, sessionName: "Tree session" });
}

/** Extend the installed mock omp with the tabs/sessions surface the F-OWN guard uses. */
function installOwnerMocks(owner: { tabId: string; winId: number } | null): {
	getSessionOwner: Mock<(sessionPath: string) => Promise<{ tabId: string; winId: number } | null>>;
	setActive: Mock<(tabId: string) => Promise<boolean>>;
	openInNewWindow: Mock<(payload: { sessionPath?: string }) => Promise<boolean>>;
} {
	const getSessionOwner = vi.fn(async () => owner);
	const setActive = vi.fn(async () => true);
	const openInNewWindow = vi.fn(async () => true);
	const ompWindow = window as unknown as { omp: Record<string, unknown> };
	ompWindow.omp = { ...ompWindow.omp, tabs: { getSessionOwner, setActive }, sessions: { openInNewWindow } };
	return { getSessionOwner, setActive, openInNewWindow };
}

/** Node corner menu → "Switch to this point" (switchToLeaf's UI path). */
async function triggerSwitchToThisPoint(entryId: string): Promise<void> {
	const card = nodeCards().find(el => el.getAttribute("data-tree-node") === entryId);
	if (!card) throw new Error(`card ${entryId} not found`);
	const actionButton = card.querySelector("button");
	if (!actionButton) throw new Error("node action button not found");
	await click(actionButton);
	const switchItem = queryAll("button").find(button => button.textContent?.includes("Switch to this point"));
	if (!switchItem) throw new Error("switch action not found");
	await click(switchItem);
	await flush();
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("SessionTreePanel", () => {
	it("preserves the empty state", async () => {
		installMockOmp();
		seedSession("tree-empty");
		await mount(<SessionTreePanel />);
		expect(document.body.textContent).toContain("No messages in this session yet.");
	});

	it("draws a linear session as a chain from the session root", async () => {
		const rpc = installMockOmp({
			getSessionTree: vi.fn(async () =>
				linearTree([
					{ entryId: "m1", text: "first prompt" },
					{ entryId: "m2", text: "second prompt" },
					{ entryId: "m3", text: "third prompt" },
				]),
			),
		});
		seedSession("tree-chain");
		await mount(<SessionTreePanel />);
		expect(rpc.getSessionTree).toHaveBeenCalledTimes(1);
		// Root anchor + three cards + three edges (root→m1→m2→m3), HEAD on the last.
		expect(document.body.textContent).toContain("session start");
		expect(nodeCards().map(card => card.getAttribute("data-tree-node"))).toEqual(["m1", "m2", "m3"]);
		expect(edgePaths()).toHaveLength(3);
		expect(document.body.textContent).toContain("head");
	});

	it("names a textless turn instead of drawing an empty card", async () => {
		installMockOmp({
			getSessionTree: vi.fn(async () =>
				linearTree([
					{ entryId: "m1", text: "run the tests" },
					{ entryId: "m2", text: "" },
				]),
			),
		});
		seedSession("tree-textless");
		await mount(<SessionTreePanel />);
		const card = nodeCards().find(el => el.getAttribute("data-tree-node") === "m2");
		expect(card?.querySelector("[data-tree-node-empty]")?.textContent).toBe("No text, only tool calls or thinking");
		const filled = nodeCards().find(el => el.getAttribute("data-tree-node") === "m1");
		expect(filled?.querySelector("[data-tree-node-empty]")).toBeNull();
	});

	it("renders the rich get_session_tree with fork edges and active-branch highlight", async () => {
		const tree: SessionTreeResult = {
			activeLeafId: "c",
			tree: [
				{
					entryId: "a",
					parentId: null,
					role: "user",
					textPreview: "first question",
					timestamp: 1700000000000,
					onActiveBranch: true,
					isLeaf: false,
				},
				{
					entryId: "b",
					parentId: "a",
					role: "assistant",
					textPreview: "first answer",
					timestamp: 1700000001000,
					onActiveBranch: true,
					isLeaf: false,
				},
				{
					entryId: "c",
					parentId: "b",
					role: "user",
					textPreview: "follow up",
					timestamp: 1700000002000,
					label: "experiment",
					onActiveBranch: true,
					isLeaf: true,
				},
				{
					entryId: "d",
					parentId: "b",
					role: "user",
					textPreview: "alternate path",
					timestamp: 1700000003000,
					onActiveBranch: false,
					isLeaf: false,
				},
			],
		};
		installMockOmp({ getSessionTree: vi.fn(async () => success(tree)) });
		seedSession("tree-fork");
		await mount(<SessionTreePanel />);
		expect(nodeCards()).toHaveLength(4);
		// Edges: root→a, a→b, b→c, b→d (the fork).
		expect(edgePaths()).toHaveLength(4);
		expect(document.body.textContent).toContain("4 messages · 1 fork");
		expect(document.body.textContent).toContain("experiment");
		// Exactly one HEAD badge, and every alternate branch remains available.
		expect(
			queryAll("span").filter(el => el.textContent === "head" && el.className.includes("rounded-full")),
		).toHaveLength(1);
		const offBranch = nodeCards().find(card => card.getAttribute("data-tree-node") === "d");
		expect(offBranch?.textContent).toContain("alternate path");
	});

	it("drags a node to a cosmetic offset that survives re-render", async () => {
		installMockOmp({
			getSessionTree: vi.fn(async () =>
				linearTree([
					{ entryId: "m1", text: "alpha" },
					{ entryId: "m2", text: "beta" },
				]),
			),
		});
		seedSession("tree-drag");
		await mount(<SessionTreePanel />);
		const card = nodeCards().find(el => el.getAttribute("data-tree-node") === "m1");
		if (!card) throw new Error("card m1 not found");
		const before = card.getAttribute("style") ?? "";
		// Initial fit runs at scale 1 for a two-node chain, so screen delta == world delta.
		await pointer(card, "pointerdown", 100, 100);
		await pointer(canvas(), "pointermove", 140, 170);
		await pointer(canvas(), "pointerup", 140, 170);
		await flush();
		const after = card.getAttribute("style") ?? "";
		const px = (style: string, prop: string) => {
			const match = style.match(new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
			return match ? Number.parseFloat(match[1] ?? "0") : Number.NaN;
		};
		expect(px(after, "left") - px(before, "left")).toBeCloseTo(40, 1);
		expect(px(after, "top") - px(before, "top")).toBeCloseTo(70, 1);
		// The drag was cosmetic: no branch RPC fired.
	});

	it("pans the canvas by dragging the background", async () => {
		installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "alpha" }])),
		});
		seedSession("tree-pan");
		await mount(<SessionTreePanel />);
		const world = queryAll("div").find(el => el.getAttribute("style")?.includes("scale("));
		if (!world) throw new Error("world transform div not found");
		const before = world.getAttribute("style") ?? "";
		await pointer(canvas(), "pointerdown", 300, 300);
		await pointer(canvas(), "pointermove", 250, 340);
		await pointer(canvas(), "pointerup", 250, 340);
		await flush();
		const after = world.getAttribute("style") ?? "";
		expect(after).not.toBe(before);
		expect(after).toContain("scale(");
	});

	it("zooms on wheel and reports the percentage", async () => {
		installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "alpha" }])),
		});
		seedSession("tree-zoom");
		await mount(<SessionTreePanel />);
		expect(document.body.textContent).toContain("100%");
		const wheel = new Event("wheel", { bubbles: true, cancelable: true });
		(wheel as unknown as { deltaY: number }).deltaY = -100;
		await dispatch(canvas(), wheel);
		await flush();
		expect(document.body.textContent).toContain("116%");
	});

	it("branches from a node via the footer detail and stays in the panel", async () => {
		const rpc = installMockOmp({
			getSessionTree: vi.fn(async () =>
				linearTree([
					{ entryId: "m1", text: "alpha prompt" },
					{ entryId: "m2", text: "beta prompt" },
				]),
			),
			branch: vi.fn(async () => success({ text: "restored branch draft", cancelled: false })),
		});
		seedSession("tree-branch");
		await mount(<SessionTreePanel />);
		let restoredDraft: string | undefined;
		window.addEventListener(
			"omp:fill-composer",
			(event: Event) => {
				restoredDraft = (event as CustomEvent<{ text?: string }>).detail.text;
			},
			{ once: true },
		);
		const card = nodeCards().find(el => el.getAttribute("data-tree-node") === "m1");
		if (!card) throw new Error("card m1 not found");
		// Click (pointerdown+up without movement) selects the node and shows the detail footer.
		await pointer(card, "pointerdown", 100, 100);
		await pointer(canvas(), "pointerup", 100, 100);
		await flush();
		expect(document.body.textContent).toContain("alpha prompt");
		// Target the footer detail's Button, not the "Branch" filter tab of the toolbar.
		const branchButton = queryAll("button").find(
			button => button.textContent?.trim() === "Branch" && button.getAttribute("role") !== "tab",
		);
		if (!branchButton) throw new Error("footer Branch button not found");
		await click(branchButton);
		await flush();
		await flush();
		expect(rpc.branch).toHaveBeenCalledWith("m1");
		expect(restoredDraft).toBe("restored branch draft");
		expect(rpc.getState).toHaveBeenCalled();
		// The side panel stays put after navigating (only the wide view closes).
		expect(queryAll(CANVAS)).toHaveLength(1);
	});

	it("surfaces a branch failure as a toast and stays open", async () => {
		const rpc = installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "alpha" }])),
			branch: vi.fn(async () => failure("nope")),
		});
		seedSession("tree-branch-fail");
		await mount(<SessionTreePanel />);
		const card = nodeCards().find(el => el.getAttribute("data-tree-node") === "m1");
		if (!card) throw new Error("card m1 not found");
		const circleButton = card.querySelector("button");
		if (!circleButton) throw new Error("node action button not found");
		// The corner button opens the node-action menu; branch is a menu item.
		await click(circleButton);
		await flush();
		const branchItem = queryAll("button").find(button => button.textContent?.includes("Branch from here"));
		if (!branchItem) throw new Error("branch menu item not found");
		await click(branchItem);
		await flush();
		expect(rpc.branch).toHaveBeenCalledWith("m1");
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "error")).toBe(true);
		expect(queryAll(CANVAS)).toHaveLength(1);
	});
	it("switches the leaf in place and rehydrates", async () => {
		const rpc = installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "choose again" }])),
		});
		seedSession("tree-switch");
		await mount(<SessionTreePanel />);
		const card = nodeCards().find(el => el.getAttribute("data-tree-node") === "m1");
		if (!card) throw new Error("card m1 not found");
		const actionButton = card.querySelector("button");
		if (!actionButton) throw new Error("node action button not found");
		await click(actionButton);
		const switchItem = queryAll("button").find(button => button.textContent?.includes("Switch to this point"));
		if (!switchItem) throw new Error("switch action not found");
		await click(switchItem);
		await flush();
		await flush();

		expect(rpc.switchLeaf).toHaveBeenCalledWith("m1", undefined);
		expect(rpc.getState).toHaveBeenCalled();
		// The side panel stays put after navigating (only the wide view closes).
		expect(queryAll(CANVAS)).toHaveLength(1);
	});

	it("keeps main's failure code on a switch failure toast", async () => {
		installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "alpha" }])),
			switchLeaf: vi.fn(async () => ({ ...failure("Sidecar not ready"), code: "sidecar_not_ready" })),
		});
		seedSession("tree-switch-coded");
		await mount(<SessionTreePanel />);
		const card = nodeCards().find(el => el.getAttribute("data-tree-node") === "m1");
		if (!card) throw new Error("card m1 not found");
		const actionButton = card.querySelector("button");
		if (!actionButton) throw new Error("node action button not found");
		await click(actionButton);
		const switchItem = queryAll("button").find(button => button.textContent?.includes("Switch to this point"));
		if (!switchItem) throw new Error("switch action not found");
		await click(switchItem);
		await flush();

		const errorToast = useToastStore.getState().toasts.find(toast => toast.variant === "error");
		expect(errorToast?.message).toBe(translate("ipcError.sidecar_not_ready"));
		expect(errorToast?.detail).toBe("Sidecar not ready");
	});

	it("defers switch-leaf to the owning tab when the session file is owned elsewhere (F-OWN)", async () => {
		const rpc = installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "alpha" }])),
		});
		// The attached session file is owned by a DIFFERENT tab (diverged state).
		const { getSessionOwner, setActive, openInNewWindow } = installOwnerMocks({ tabId: "t-owner", winId: 1 });
		useSessionStore.setState({ sessionFile: "/sessions/x.jsonl" });
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t-me", cwd: "/a", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t-owner", cwd: "/a", status: "ready", unreadDone: false },
			],
			activeTabId: "t-me",
			bundles: new Map(),
		});
		seedSession("tree-owned");
		await mount(<SessionTreePanel />);
		await triggerSwitchToThisPoint("m1");

		expect(getSessionOwner).toHaveBeenCalledWith("/sessions/x.jsonl");
		expect(rpc.switchLeaf).not.toHaveBeenCalled();
		// Owner lives in this window → routed via switchTab (SET_ACTIVE_TAB proof).
		expect(setActive).toHaveBeenCalledWith("t-owner");
		expect(openInNewWindow).not.toHaveBeenCalled();
		// The side panel stays put after navigating (only the wide view closes).
		expect(queryAll(CANVAS)).toHaveLength(1);
	});

	it("focuses the foreign owner window for switch-leaf when the owner is in another window", async () => {
		const rpc = installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "alpha" }])),
		});
		const { getSessionOwner, setActive, openInNewWindow } = installOwnerMocks({ tabId: "t-elsewhere", winId: 9 });
		useSessionStore.setState({ sessionFile: "/sessions/x.jsonl" });
		useTabsStore.setState({
			tabs: [{ kind: "agent", id: "t-me", cwd: "/a", status: "ready", unreadDone: false }],
			activeTabId: "t-me",
			bundles: new Map(),
		});
		seedSession("tree-foreign-owned");
		await mount(<SessionTreePanel />);
		await triggerSwitchToThisPoint("m1");

		expect(getSessionOwner).toHaveBeenCalledWith("/sessions/x.jsonl");
		expect(rpc.switchLeaf).not.toHaveBeenCalled();
		expect(setActive).not.toHaveBeenCalled();
		expect(openInNewWindow).toHaveBeenCalledWith({ sessionPath: "/sessions/x.jsonl" });
		// The side panel stays put after navigating (only the wide view closes).
		expect(queryAll(CANVAS)).toHaveLength(1);
	});

	it("proceeds with switch-leaf when the current tab owns the session file", async () => {
		const rpc = installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "alpha" }])),
		});
		installOwnerMocks({ tabId: "t-me", winId: 1 });
		useSessionStore.setState({ sessionFile: "/sessions/x.jsonl" });
		useTabsStore.setState({
			tabs: [{ kind: "agent", id: "t-me", cwd: "/a", status: "ready", unreadDone: false }],
			activeTabId: "t-me",
			bundles: new Map(),
		});
		seedSession("tree-self-owned");
		await mount(<SessionTreePanel />);
		await triggerSwitchToThisPoint("m1");

		expect(rpc.switchLeaf).toHaveBeenCalledWith("m1", undefined);
		// The side panel stays put after navigating (only the wide view closes).
		expect(queryAll(CANVAS)).toHaveLength(1);
	});

	it("opens the wide view in a Sheet and closes it after a switch, keeping the panel", async () => {
		const rpc = installMockOmp({
			getSessionTree: vi.fn(async () => linearTree([{ entryId: "m1", text: "alpha" }])),
		});
		seedSession("tree-wide");
		await mount(<SessionTreePanel />);
		const openWide = queryAll("button").find(button => button.getAttribute("aria-label") === "Open wide view");
		if (!openWide) throw new Error("wide view button not found");
		await click(openWide);
		await flush();
		const sheet = queryAll('[role="dialog"]')[0];
		if (!sheet) throw new Error("wide view sheet not rendered");
		expect(sheet.textContent).toContain("Session tree");
		// Both views render the same tree: the panel's canvas and the sheet's.
		expect(queryAll(CANVAS)).toHaveLength(2);
		const sheetCard = sheet.querySelector('[data-tree-node="m1"]');
		if (!sheetCard) throw new Error("sheet node card not found");
		const actionButton = sheetCard.querySelector("button");
		if (!actionButton) throw new Error("sheet node action button not found");
		await click(actionButton);
		const switchItem = queryAll("button").find(button => button.textContent?.includes("Switch to this point"));
		if (!switchItem) throw new Error("switch action not found");
		await click(switchItem);
		await flush();
		await flush();
		expect(rpc.switchLeaf).toHaveBeenCalledWith("m1", undefined);
		expect(queryAll('[role="dialog"]')).toHaveLength(0);
		expect(nodeCards().some(card => card.getAttribute("data-tree-node") === "m1")).toBe(true);
	});

	it("edits a label with L and cancels it on Escape without leaking the key", async () => {
		const tree: SessionTreeResult = {
			activeLeafId: "a",
			tree: [
				{
					entryId: "a",
					parentId: null,
					role: "user",
					textPreview: "only question",
					timestamp: 1700000000000,
					onActiveBranch: true,
					isLeaf: true,
				},
			],
		};
		installMockOmp({ getSessionTree: vi.fn(async () => success(tree)) });
		seedSession("tree-label");
		await mount(<SessionTreePanel />);
		const card = nodeCards().find(el => el.getAttribute("data-tree-node") === "a");
		if (!card) throw new Error("card a not found");
		await pointer(card, "pointerdown", 100, 100);
		await pointer(canvas(), "pointerup", 100, 100);
		await flush();
		await key(canvas(), "l");
		await flush();
		const input = queryAll("input").find(el => el.getAttribute("aria-label") === "Edit label");
		if (!input) throw new Error("label input not shown");
		const escapeEvent = await key(input, "Escape");
		await flush();
		expect(escapeEvent.defaultPrevented).toBe(true);
		expect(queryAll("input").some(el => el.getAttribute("aria-label") === "Edit label")).toBe(false);
	});
});
