import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltinReaState } from "../../../shared/builtin-mcp";
import type { RpcMcpServerInfo } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { BuiltinReaRow, reaNodeMinimumMajor } from "./BuiltinReaRow";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
let state: BuiltinReaState;
const builtinRea = {
	get: vi.fn(async (_device?: string) => state),
	set: vi.fn(async (enabled: boolean, _device?: string) => {
		state = { ...state, enabled };
		return state;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { builtinRea } });
let root: Root;
const REA_SERVER: RpcMcpServerInfo = {
	name: "rea",
	transport: "stdio",
	status: "connected",
	toolCount: 28,
	enabled: true,
	authed: false,
	builtin: "rea",
};
async function mount(device?: string, server?: RpcMcpServerInfo) {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<BuiltinReaRow device={device} server={server} />
			</I18nProvider>,
		);
	});
}
function toggle(): HTMLButtonElement {
	const button = document.querySelector('[role="switch"]') as HTMLButtonElement | null;
	if (!button) throw new Error("REA toggle missing");
	return button;
}
beforeEach(() => {
	state = { enabled: true, available: true, nodeVersion: "v24.11.0" };
});
afterEach(async () => {
	await act(async () => root?.unmount());
	useToastStore.setState({ toasts: [] });
	vi.clearAllMocks();
});
describe("BuiltinReaRow", () => {
	it("shows the stored toggle and saves a change", async () => {
		await mount();
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		await act(async () => toggle().click());
		expect(builtinRea.set).toHaveBeenCalledWith(false, undefined);
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});
	it("shows why a host is unavailable and lets its setting be disabled", async () => {
		state = { enabled: true, available: false, nodeVersion: "v20.0.0", reason: "node-version" };
		await mount("host-b");
		expect(builtinRea.get).toHaveBeenCalledWith("host-b");
		expect(document.body.textContent).toContain("Node.js v20.0.0 does not meet the requirement");
		await act(async () => toggle().click());
		expect(builtinRea.set).toHaveBeenCalledWith(false, "host-b");
	});
	it("keeps the stored toggle and reports a write failure", async () => {
		builtinRea.set.mockRejectedValueOnce(new Error("disk full"));
		await mount();
		await act(async () => toggle().click());
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});
	it("says only that it is checking while Node.js is read, never also that it is connected", async () => {
		builtinRea.get.mockImplementationOnce(() => new Promise<BuiltinReaState>(() => {}));
		await mount(undefined, REA_SERVER);
		const status = document.querySelector('[role="status"]')?.textContent ?? "";
		expect(status).toBe("Checking Node.js…");
		expect(document.body.textContent).not.toContain("connected");
	});
	it("names the current state once it is known, with the tool count in words", async () => {
		await mount(undefined, REA_SERVER);
		expect(document.querySelector('[role="status"]')?.textContent).toBe(
			"Available for new sessions · connected · 28 tools",
		);
	});
	it("shows the Node.js requirement as its oldest major, not the semver range", async () => {
		await mount();
		expect(document.body.textContent).toContain("Requires Node.js 22 or newer and npx");
		expect(document.body.textContent).not.toContain("^22");
		expect(reaNodeMinimumMajor("^20.1.0 || >=23.0.0")).toBe("20");
	});
});
