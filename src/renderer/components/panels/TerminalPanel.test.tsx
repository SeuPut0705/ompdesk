import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_OUTPUT_BUDGET, TERMINAL_POLL_MAX_WAIT_MS } from "../../../shared/terminal-types";
import { resetShellModeForTests } from "../../hooks/use-shell-mode";
import { I18nProvider, translate } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { type TerminalMount, TerminalPanel, TerminalViewport } from "./TerminalPanel";

const { document, window, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	useTabsStore.setState({ tabs: [], activeTabId: null });
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
async function mount(element: React.ReactNode) {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
}
describe("TerminalPanel", () => {
	it("runs a paired host's tab on the host's terminals through the same request, its shells asked by tab", async () => {
		const request = vi.fn().mockRejectedValue(new Error("Host offline"));
		const shells = vi.fn().mockResolvedValue([]);
		Reflect.set(window, "omp", {
			terminal: { request, shells },
			prefs: { get: vi.fn().mockResolvedValue(undefined) },
		});
		useTabsStore.setState({
			activeTabId: "remote",
			tabs: [{ id: "remote", cwd: "/host", status: "ready", kind: "agent", device: "host", unreadDone: false }],
		});
		await mount(<TerminalPanel />);
		expect(request).toHaveBeenCalledWith("remote", { action: "list", offsets: {} });
		expect(shells).toHaveBeenCalledWith("remote");
		expect(container.textContent).toContain("Host offline");
	});
	it("streams into xterm, forwards input, and disposes rendering without killing the shell", async () => {
		vi.useFakeTimers();
		const snapshot = { id: "term", output: "ompdesk-term\r\n", offset: 14, exited: false };
		const request = vi.fn().mockResolvedValue([snapshot]);
		Reflect.set(window, "omp", { terminal: { request } });
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.stubGlobal(
			"MutationObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		const data = { callback: (_value: string) => {} };
		const dispose = vi.fn();
		const write = vi.fn();
		const view: TerminalMount = {
			terminal: {
				cols: 80,
				rows: 24,
				options: {},
				write,
				onData: callback => {
					data.callback = callback;
					return { dispose: vi.fn() };
				},
				focus: vi.fn(),
				clear: vi.fn(),
				getSelection: () => "",
				dispose,
				attachCustomKeyEventHandler: vi.fn(),
			},
			fit: vi.fn(),
		};
		const handle = { current: null };
		await mount(
			<TerminalViewport
				tabId="tab"
				id="term"
				onStatus={vi.fn()}
				onError={vi.fn()}
				mount={() => view}
				handle={handle}
			/>,
		);
		expect(write).toHaveBeenCalledWith("ompdesk-term\r\n");
		data.callback("echo hello\r");
		expect(request).toHaveBeenCalledWith("tab", { action: "write", id: "term", data: "echo hello\r" });
		await act(async () => root?.unmount());
		root = undefined;
		expect(dispose).toHaveBeenCalledOnce();
		expect(request.mock.calls.some(([, operation]) => operation.action === "close")).toBe(false);
	});
	it("shows an actionable startup error instead of an endless loading state", async () => {
		Reflect.set(window, "omp", {
			terminal: {
				request: vi
					.fn()
					.mockRejectedValue(
						new Error("Error invoking remote method 'terminal:request': Error: Stock PTY unavailable"),
					),
				shells: vi.fn().mockResolvedValue([]),
			},
			prefs: { get: vi.fn().mockResolvedValue(undefined) },
		});
		useTabsStore.setState({
			activeTabId: "local",
			tabs: [{ id: "local", cwd: "/project", status: "ready", kind: "agent", unreadDone: false }],
		});
		await mount(<TerminalPanel />);
		expect(container.textContent).toContain(translate("panel.terminal.failed"));
		// The detail drops Electron's IPC wrapper.
		expect(container.textContent).toContain("Stock PTY unavailable");
		expect(container.textContent).not.toContain("Error invoking remote method");
		expect(container.textContent).toContain("Retry");
		expect(container.textContent).not.toContain("Starting your shell");
	});
});

const { terminals } = vi.hoisted(() => ({
	terminals: [] as Array<{
		options: { fontSize?: number };
		cols: number;
		rows: number;
		resize: (cols: number, rows: number) => void;
		data: (value: string) => void;
		focus: ReturnType<typeof vi.fn>;
	}>,
}));
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		options: { fontSize?: number };
		data: (value: string) => void = () => {};
		resize = vi.fn((cols: number, rows: number) => {
			this.cols = cols;
			this.rows = rows;
		});
		constructor(options: { fontSize?: number }) {
			this.options = { ...options };
			terminals.push(this);
		}
		loadAddon() {}
		open() {}
		write(_data: string, done?: () => void) {
			done?.();
		}
		onData(callback: (value: string) => void) {
			this.data = callback;
			return { dispose() {} };
		}
		focus = vi.fn();
		clear() {}
		getSelection() {
			return "";
		}
		dispose() {}
		attachCustomKeyEventHandler() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {}
	},
}));

describe("TerminalPanel on a phone", () => {
	const snapshot = (extra: Record<string, unknown> = {}) => ({
		id: "term",
		output: "",
		offset: 0,
		exited: false,
		...extra,
	});

	function phone(answer: (operation: Record<string, unknown>) => unknown) {
		vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
		vi.useFakeTimers();
		terminals.length = 0;
		document.documentElement.dataset.platform = "web";
		Object.assign(window, {
			matchMedia: (query: string) => ({
				matches: query.includes("max-width: 599px") || query.includes("pointer: coarse"),
				addEventListener: () => {},
				removeEventListener: () => {},
			}),
			location: { search: "" },
		});
		resetShellModeForTests();
		for (const name of ["clientWidth", "clientHeight"])
			Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 400 });
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.stubGlobal(
			"MutationObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		const request = vi.fn(async (_tab: string, operation: Record<string, unknown>) => answer(operation));
		Reflect.set(window, "omp", {
			terminal: { request, shells: vi.fn().mockResolvedValue([]) },
			prefs: { get: vi.fn().mockResolvedValue(undefined) },
		});
		useTabsStore.setState({
			activeTabId: "tab",
			tabs: [{ id: "tab", cwd: "/p", status: "ready", kind: "agent", unreadDone: false }],
		});
		return request;
	}

	const settle = () =>
		act(async () => {
			await vi.dynamicImportSettled();
			await vi.advanceTimersByTimeAsync(0);
		});
	const press = (selector: string, type = "pointerdown") =>
		act(async () => {
			container.querySelector(selector)?.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
		});
	const operations = (request: { mock: { calls: Array<[string, Record<string, unknown>]> } }, action: string) =>
		request.mock.calls.map(([, operation]) => operation).filter(operation => operation.action === action);

	afterEach(() => {
		delete document.documentElement.dataset.platform;
		resetShellModeForTests();
	});

	it("its session tabs are one tab stop, and the arrows switch the session", async () => {
		phone(operation =>
			operation.action === "list" && operation.waitMs
				? new Promise(() => {})
				: [snapshot(), snapshot({ id: "second" }), snapshot({ id: "third" })],
		);
		await mount(<TerminalPanel />);
		await settle();
		const tabs = () => Array.from(container.querySelectorAll("[role=tab]")) as HTMLElement[];
		const stops = () => tabs().map(tab => tab.getAttribute("tabindex"));
		expect(stops()).toEqual(["0", "-1", "-1"]);
		const key = (target: HTMLElement, name: string) =>
			act(async () => {
				const event = new window.Event("keydown", { bubbles: true, cancelable: true });
				Object.defineProperty(event, "key", { value: name });
				target.dispatchEvent(event);
			});
		await key(tabs()[0] as HTMLElement, "ArrowRight");
		expect(stops()).toEqual(["-1", "0", "-1"]);
		expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
		await key(tabs()[1] as HTMLElement, "End");
		expect(stops()).toEqual(["-1", "-1", "0"]);
		await key(tabs()[2] as HTMLElement, "ArrowRight");
		expect(stops()).toEqual(["0", "-1", "-1"]);
		// Each switch mounted a new shell; none took focus from the tab the arrows are on.
		await settle();
		expect(terminals.length).toBeGreaterThan(1);
		expect(terminals.slice(1).every(terminal => terminal.focus.mock.calls.length === 0)).toBe(true);
		expect(terminals[0]?.focus).toHaveBeenCalled();
	});

	it("reads with a long poll that carries the offset, one request at a time", async () => {
		let lists = 0;
		const request = phone(operation => {
			if (operation.action === "list" && operation.waitMs) {
				// The first answer has output; the next request is held, as a host with nothing new holds it.
				return lists++ === 0 ? [snapshot({ output: "hi", offset: 2 })] : new Promise(() => {});
			}
			return [snapshot()];
		});
		await mount(<TerminalPanel />);
		await settle();
		await settle();
		const polls = operations(request, "list").filter(operation => operation.waitMs);
		expect(polls).toEqual([
			{ action: "list", offsets: { term: 0 }, waitMs: TERMINAL_POLL_MAX_WAIT_MS, budget: TERMINAL_OUTPUT_BUDGET },
			{ action: "list", offsets: { term: 2 }, waitMs: TERMINAL_POLL_MAX_WAIT_MS, budget: TERMINAL_OUTPUT_BUDGET },
		]);
	});

	it("sends the key bar's keys, with sticky Ctrl applied to the next key from the bar or the soft keyboard", async () => {
		const request = phone(() => [snapshot()]);
		await mount(<TerminalPanel />);
		await settle();
		expect(container.querySelector("[data-terminal-keybar]")).not.toBeNull();
		const written = () => operations(request, "write").map(operation => operation.data);
		await press('[data-terminal-key="esc"]');
		expect(written()).toEqual(["\u001b"]);
		await press('[data-terminal-key="ctrl"]');
		expect(container.querySelector('[data-terminal-key="ctrl"]')?.getAttribute("aria-pressed")).toBe("true");
		await press('[data-terminal-key="up"]');
		await press('[data-terminal-key="up"]', "pointerup");
		expect(written().at(-1)).toBe("\u001b[1;5A");
		expect(container.querySelector('[data-terminal-key="ctrl"]')?.getAttribute("aria-pressed")).toBe("false");
		// Held again, Ctrl applies to the soft keyboard's next key, once.
		await press('[data-terminal-key="ctrl"]');
		await act(async () => terminals[0]?.data("c"));
		expect(written().at(-1)).toBe("\u0003");
		await act(async () => terminals[0]?.data("c"));
		expect(written().at(-1)).toBe("c");
	});

	it("holds the text size to 50–200 % and applies it to xterm", async () => {
		phone(() => [snapshot()]);
		await mount(<TerminalPanel />);
		await settle();
		await press('[data-terminal-font="larger"]', "click");
		expect(terminals[0]?.options.fontSize).toBe(13);
		await press('[data-terminal-font="reset"]', "click");
		expect(terminals[0]?.options.fontSize).toBe(12);
		for (let step = 0; step < 8; step++) await press('[data-terminal-font="smaller"]', "click");
		expect(container.querySelector('[data-terminal-font="reset"]')?.textContent).toBe("50%");
		expect(terminals[0]?.options.fontSize).toBe(6);
		expect(container.querySelector('[data-terminal-font="smaller"]')?.hasAttribute("disabled")).toBe(true);
		for (let step = 0; step < 20; step++) await press('[data-terminal-font="larger"]', "click");
		expect(container.querySelector('[data-terminal-font="reset"]')?.textContent).toBe("200%");
		expect(terminals[0]?.options.fontSize).toBe(24);
		expect(container.querySelector('[data-terminal-font="larger"]')?.hasAttribute("disabled")).toBe(true);
		// The key bar's own toggle hides the bar and shows it again.
		await press("[data-terminal-keys-toggle]", "click");
		expect(container.querySelector("[data-terminal-keybar]")).toBeNull();
		await press("[data-terminal-keys-toggle]", "click");
		expect(container.querySelector("[data-terminal-keybar]")).not.toBeNull();
	});

	it("draws another viewer's size without resizing it, and takes the size back on request", async () => {
		let lists = 0;
		const request = phone(operation => {
			if (operation.action === "list" && operation.waitMs) {
				return lists++ === 0 ? [snapshot({ lease: "other", cols: 60, rows: 20 })] : new Promise(() => {});
			}
			return [snapshot()];
		});
		await mount(<TerminalPanel />);
		await settle();
		await settle();
		const banner = container.querySelector("[data-terminal-lease]");
		expect(banner?.textContent).toContain(translate("panel.terminal.lease.other"));
		expect(terminals[0]?.resize).toHaveBeenCalledWith(60, 20);
		const resizes = operations(request, "resize").length;
		await press('[data-terminal-font="larger"]', "click");
		expect(operations(request, "resize").length).toBe(resizes);
		await press("[data-terminal-lease-claim]", "click");
		await settle();
		expect(operations(request, "claim")).toEqual([{ action: "claim", id: "term" }]);
		expect(container.querySelector("[data-terminal-lease]")).toBeNull();
		expect(operations(request, "resize").length).toBe(resizes + 1);
	});
});
