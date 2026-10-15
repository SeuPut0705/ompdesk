import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BuiltinReaState, REA_VERSION } from "../../../shared/builtin-mcp";
import { I18nProvider } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { BuiltinReaRow } from "./BuiltinReaRow";

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
async function mount(device?: string) {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<BuiltinReaRow device={device} />
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
	it("shows pinned version, defaults on and applies toggles to new sessions", async () => {
		await mount();
		expect(document.body.textContent).toContain("REA — reverse engineering (built in)");
		expect(document.body.textContent).toContain(REA_VERSION);
		expect(document.body.textContent).toContain("15 curated");
		expect(document.body.textContent).toContain("full catalog available on demand");
		expect(document.body.textContent).toContain("running sessions are not restarted");
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		await act(async () => toggle().click());
		expect(builtinRea.set).toHaveBeenCalledWith(false, undefined);
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});
	it("shows the exact Node requirement and reason on an unavailable host", async () => {
		state = { enabled: true, available: false, nodeVersion: "v20.0.0", reason: "node-version" };
		await mount("host-b");
		expect(builtinRea.get).toHaveBeenCalledWith("host-b");
		expect(document.body.textContent).toContain("^22.19.0 || ^24.11.0 || >=26.0.0");
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
});
