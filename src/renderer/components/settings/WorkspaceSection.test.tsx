/**
 * DOM smoke tests for Settings › Project folders (TUI /dirs /add-dir
 * /remove-dir /move parity): list rendering with the primary badge, loading
 * and error states, add via the native picker, remove behind a confirm
 * dialog, and the move flow (picker → move_session → toast + rehydrate +
 * refetch).
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { WorkspaceSection } from "./WorkspaceSection";

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

interface MockRpc {
	getDirectories: Mock<() => Promise<RpcResponse>>;
	addDirectory: Mock<(path: string) => Promise<RpcResponse>>;
	removeDirectory: Mock<(path: string) => Promise<RpcResponse>>;
	moveSession: Mock<(path: string) => Promise<RpcResponse>>;
	getState: Mock<() => Promise<RpcResponse>>;
	getTranscript: Mock<() => Promise<RpcResponse>>;
	getSubagents: Mock<() => Promise<RpcResponse>>;
	getGoal: Mock<() => Promise<RpcResponse>>;
	setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
}

interface MockOmp {
	rpc: MockRpc;
	system: { showOpenDialog: Mock<() => Promise<string[] | null>> };
}

const CWD = "/work/project";
const EXTRA = "/work/extra";

function directories(...paths: string[]): { directories: { path: string; primary: boolean }[] } {
	return { directories: paths.map(path => ({ path, primary: path === CWD })) };
}

function installMockOmp(overrides: { rpc?: Partial<MockRpc>; pickedPath?: string | null } = {}): MockOmp {
	const rpc: MockRpc = {
		getDirectories: vi.fn(async () => success(directories(CWD, EXTRA))),
		addDirectory: vi.fn(async () => success(directories(CWD, EXTRA))),
		removeDirectory: vi.fn(async () => success(directories(CWD))),
		moveSession: vi.fn(async () => success({ cwd: EXTRA })),
		getState: vi.fn(async () => success({ sessionId: "s1", messageCount: 0, todoPhases: [] })),
		getTranscript: vi.fn(async () => success({ messages: [] })),
		getSubagents: vi.fn(async () => success({ subagents: [] })),
		getGoal: vi.fn(async () => success({})),
		setSubagentSubscription: vi.fn(async () => success({})),
		...overrides.rpc,
	};
	const omp: MockOmp = {
		rpc,
		system: {
			showOpenDialog: vi.fn(async () => (overrides.pickedPath === null ? null : [overrides.pickedPath ?? EXTRA])),
		},
	};
	// linkedom's window lacks the preload bridge; install the mock OmpApi on it.
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
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

function buttons(): TestElement[] {
	return queryAll("button");
}

const REMOVE_LABEL = "Remove folder";

/** Icon-only row actions are named by aria-label (the confirm button carries the same verb as text). */
function removeButtons(): TestElement[] {
	return buttons().filter(button => button.getAttribute("aria-label") === REMOVE_LABEL);
}

function findButton(text: string): TestElement {
	const match = buttons().find(button => button.textContent?.includes(text));
	if (!match) throw new Error(`button not found: ${text}`);
	return match;
}

/** Dispatch an event inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("WorkspaceSection", () => {
	it("lists the session folders with the primary badge once loaded", async () => {
		installMockOmp();
		await mount(<WorkspaceSection />);
		const text = document.body.textContent ?? "";
		expect(text).toContain(CWD);
		expect(text).toContain(EXTRA);
		expect(text).toContain("Primary");
	});

	it("shows the server error when the directory listing fails", async () => {
		installMockOmp({ rpc: { getDirectories: vi.fn(async () => failure("sidecar down")) } });
		await mount(<WorkspaceSection />);
		expect(document.body.textContent ?? "").toContain("sidecar down");
		// A refusal is not an empty list: the "no folders" message would tell the
		// user to add a folder when the read is what broke.
		expect(document.body.textContent ?? "").not.toContain("No folders in this session");
	});

	it("re-reads the roots from the error's retry affordance", async () => {
		const omp = installMockOmp({
			rpc: {
				getDirectories: vi
					.fn<() => Promise<RpcResponse>>()
					.mockResolvedValueOnce(failure("sidecar down"))
					.mockResolvedValue(success(directories(CWD, EXTRA))),
			},
		});
		await mount(<WorkspaceSection />);
		expect(omp.rpc.getDirectories).toHaveBeenCalledTimes(1);

		await click(findButton("Retry"));
		await flush();

		expect(omp.rpc.getDirectories).toHaveBeenCalledTimes(2);
		const text = document.body.textContent ?? "";
		expect(text).toContain(EXTRA);
		expect(text).not.toContain("sidecar down");
	});

	it("adds a directory picked from the native dialog and refreshes the list", async () => {
		const omp = installMockOmp({ pickedPath: "/work/third" });
		omp.rpc.addDirectory = vi.fn(async () => success(directories(CWD, EXTRA, "/work/third")));
		await mount(<WorkspaceSection />);
		await click(findButton("Add folder"));
		await flush();
		expect(omp.rpc.addDirectory).toHaveBeenCalledWith("/work/third");
		expect(document.body.textContent ?? "").toContain("/work/third");
		const toasts = useToastStore.getState().toasts;
		expect(toasts.some(toast => toast.variant === "success")).toBe(true);
	});

	it("does not call the RPC when the picker is cancelled", async () => {
		const omp = installMockOmp({ pickedPath: null });
		await mount(<WorkspaceSection />);
		await click(findButton("Add folder"));
		await flush();
		expect(omp.rpc.addDirectory).not.toHaveBeenCalled();
	});

	it("keeps removal behind the confirm dialog until confirmed", async () => {
		const omp = installMockOmp();
		await mount(<WorkspaceSection />);

		// Only the non-primary row carries a remove affordance.
		const removeButton = removeButtons()[0];
		if (!removeButton) throw new Error("remove button not found");
		await click(removeButton);
		await flush();
		expect(omp.rpc.removeDirectory).not.toHaveBeenCalled();

		// Cancel closes the confirm without an RPC; re-open and confirm.
		await click(findButton("Cancel"));
		await flush();
		expect(omp.rpc.removeDirectory).not.toHaveBeenCalled();
		const removeButtonAgain = removeButtons()[0];
		if (!removeButtonAgain) throw new Error("remove button not found after cancel");
		await click(removeButtonAgain);
		await flush();
		await click(findButton(REMOVE_LABEL));
		await flush();
		expect(omp.rpc.removeDirectory).toHaveBeenCalledWith(EXTRA);
		// The removed folder's row is gone (the closing dialog may still be fading out with its name).
		expect(removeButtons()).toHaveLength(0);
	});

	it("never offers removal for the primary directory", async () => {
		installMockOmp();
		await mount(<WorkspaceSection />);
		// Exactly one remove button: the additional root's row.
		expect(removeButtons()).toHaveLength(1);
	});

	it("moves the session to the picked directory, toasts, and rehydrates", async () => {
		const omp = installMockOmp({ pickedPath: EXTRA });
		await mount(<WorkspaceSection />);
		await click(findButton("Move session"));
		await flush();
		expect(omp.rpc.moveSession).toHaveBeenCalledWith(EXTRA);
		// hydrateSession pulled the session state, and the section refetched folders.
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.rpc.getDirectories.mock.calls.length).toBeGreaterThanOrEqual(2);
		const toasts = useToastStore.getState().toasts;
		expect(toasts.some(toast => toast.variant === "success")).toBe(true);
	});

	it("surfaces a primary-removal refusal as an error toast and keeps the list", async () => {
		const omp = installMockOmp();
		omp.rpc.removeDirectory = vi.fn(async () =>
			failure("Cannot remove the working directory; use /move to change it."),
		);
		await mount(<WorkspaceSection />);
		const removeButton = removeButtons()[0];
		if (!removeButton) throw new Error("remove button not found");
		await click(removeButton);
		await flush();
		await click(findButton(REMOVE_LABEL));
		await flush();
		const toasts = useToastStore.getState().toasts;
		expect(toasts.some(toast => toast.variant === "error" && (toast.detail ?? "").includes("/move"))).toBe(true);
		expect(document.body.textContent ?? "").toContain(EXTRA);
	});
});
