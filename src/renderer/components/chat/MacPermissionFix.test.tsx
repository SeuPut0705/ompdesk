/**
 * A computer-use step that failed for a missing macOS permission offers the fix under its error: agent-desktop's
 * `PERM_DENIED` and stock's built-in computer use alike; the button asks for the missing one and the line follows the
 * grant when the window regains focus. Settings › Agent behavior shows both permissions, and nothing off macOS.
 * Linkedom harness, like AgentDesktopRenderer.test.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MacPermissionStatus } from "../../../shared/mac-permissions";
import { I18nProvider } from "../../lib/i18n";
import { MacPermissionRows } from "../settings/MacPermissionRows";
import { AgentDesktopRenderer } from "../tools/renderers/AgentDesktopRenderer";
import { ComputerRenderer } from "../tools/renderers/ComputerRenderer";

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

let container: HTMLElement;
let root: Root;

/** The computer's permissions as main answers them; `null` is Windows. */
function computer(initial: MacPermissionStatus | null) {
	const state = { status: initial };
	const prefs = {
		get: vi.fn(async () => undefined),
		macPermissionsStatus: vi.fn(async () => state.status),
		requestMacPermission: vi.fn(async (_permission: string) => state.status),
	};
	Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs } });
	return { state, prefs };
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

const fix = () => container.querySelector("[data-mac-permission-fix]")?.getAttribute("data-mac-permission-fix");
const button = (permission: string) =>
	container.querySelector(`[data-mac-permission="${permission}"][data-mac-permission-state="missing"]`) as
		| (Element & { click(): void })
		| null;

const permDenied = {
	content: [
		{
			type: "text",
			text: JSON.stringify({
				version: "2.6",
				ok: false,
				command: "screenshot",
				error: { code: "PERM_DENIED", message: "Screen Recording permission is not granted" },
			}),
		},
	],
};

describe("the fix under a computer-use step that needed a macOS permission", () => {
	it("asks for the missing one from agent-desktop's PERM_DENIED, then says to retry once the window sees it granted", async () => {
		const mac = computer({ accessibility: true, screen: false });
		await mount(<AgentDesktopRenderer args={{ app: "Notes" }} result={permDenied} />);
		expect(fix()).toBe("missing");
		expect(button("accessibility")).toBeNull();

		await act(async () => button("screen")?.click());
		expect(mac.prefs.requestMacPermission).toHaveBeenCalledWith("screen");

		// The person turns the switch on in System Settings and comes back to the window.
		mac.state.status = { accessibility: true, screen: true };
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(fix()).toBe("granted");
		expect(container.textContent).toContain("Ask the agent to try again");
	});

	it("shows for stock's built-in computer use saying a permission is not granted, and not for other failures", async () => {
		computer({ accessibility: false, screen: true });
		const stockError = (text: string) => ({ content: [{ type: "text", text }] });
		await mount(
			<ComputerRenderer
				args={{ action: "click" }}
				isError
				result={stockError(
					"Accessibility permission is not granted to the app that launched omp; enable that terminal or IDE in System Settings > Privacy & Security > Accessibility",
				)}
			/>,
		);
		expect(fix()).toBe("missing");
		expect(button("accessibility")).not.toBeNull();
		await act(async () => root.unmount());

		await mount(<ComputerRenderer args={{ action: "click" }} isError result={stockError("window not found")} />);
		expect(fix()).toBeUndefined();
	});

	it("is nothing on a computer without macOS permissions", async () => {
		computer(null);
		await mount(<AgentDesktopRenderer args={{}} result={permDenied} />);
		expect(fix()).toBeUndefined();
		expect(container.textContent).toContain("PERM_DENIED");
	});
});

describe("Settings › Agent behavior › the macOS permissions", () => {
	it("shows each permission's state with the button on the missing one, and no rows off macOS", async () => {
		computer({ accessibility: true, screen: false });
		await mount(<MacPermissionRows />);
		expect(
			container.querySelector('[data-mac-permission="accessibility"]')?.getAttribute("data-mac-permission-state"),
		).toBe("granted");
		expect(button("screen")).not.toBeNull();
		await act(async () => root.unmount());

		computer(null);
		await mount(<MacPermissionRows />);
		expect(container.querySelector("[data-mac-permission]")).toBeNull();
	});
});
