import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
