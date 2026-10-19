/**
 * Tests for the tool-approval field in the composer's Run settings popover:
 * escalating to full access is a permission change that takes effect on a
 * possibly running session, so it must be confirmed — in a Dialog that
 * replaces the popover, never one stacked on it — while stepping down to a
 * stricter mode stays one change.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useSettingsStore } from "../../../stores/settings";
import { useToastStore } from "../../../stores/toast";
import { RunChip } from "./RunChip";

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
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
// The popover is positioned off the viewport box, which linkedom leaves unset.
(window as unknown as Record<string, unknown>).innerHeight = 900;
(window as unknown as Record<string, unknown>).innerWidth = 1200;
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

const command = vi.fn(
	async (req: RpcCommand): Promise<RpcResponse> =>
		req.type === "set_setting"
			? {
					type: "response",
					command: req.type,
					success: true,
					data: { value: req.value, provenance: { layers: [] } },
				}
			: { type: "response", command: req.type, success: true, data: { provenance: {} } },
);

// The popover also hosts the Mode section (prefs, sidecar events), which mounts with it.
const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { rpc: { command }, prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }, events },
});

const roots: Root[] = [];

async function mountControl(mode: "yolo" | "write" | "always-ask"): Promise<void> {
	useSettingsStore.setState({ approvalMode: mode });
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RunChip />
			</I18nProvider>,
		);
	});
	roots.push(root);
	await act(async () => {
		(document.body.querySelector("button[data-run-settings-trigger]") as HTMLButtonElement | null)?.click();
	});
}

function approvalField(): HTMLElement | null {
	return document.body.querySelector("[data-approval-mode]") as HTMLElement | null;
}

/** The held mode: the one segment that is checked. */
function heldMode(): string | null | undefined {
	return approvalField()?.querySelector("[aria-checked=true]")?.getAttribute("data-approval-option");
}

/** Tap one segment of the row. */
async function chooseMode(mode: "yolo" | "write" | "always-ask"): Promise<void> {
	const option = approvalField()?.querySelector(`[data-approval-option="${mode}"]`) as HTMLButtonElement | null;
	if (!option) throw new Error("approval option missing");
	await act(async () => option.click());
}

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
	const buttons = Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[];
	return buttons.find(button => (button.textContent ?? "").trim() === label);
}

function writes(): RpcCommand[] {
	return command.mock.calls.map(call => call[0] as RpcCommand);
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
	command.mockClear();
});

describe("Run settings tool approval", () => {
	it("confirms before granting full access, closing the popover first", async () => {
		await mountControl("write");
		expect(heldMode()).toBe("write");

		await chooseMode("yolo");

		expect(writes()).toEqual([]);
		// The popover gave way to the confirmation; nothing stacks on it.
		expect(approvalField()).toBeNull();
		expect(document.body.textContent ?? "").toContain(translate("input.approval.yoloConfirmTitle"));

		await act(async () => {
			buttonWithLabel(translate("input.approval.yoloConfirmAction"))?.click();
		});

		expect(writes()).toEqual([{ type: "set_setting", path: "tools.approvalMode", value: "yolo" }]);
	});

	it("steps down to a stricter mode in one change", async () => {
		await mountControl("yolo");

		await chooseMode("always-ask");

		expect(writes()).toEqual([{ type: "set_setting", path: "tools.approvalMode", value: "always-ask" }]);
		expect(document.body.textContent ?? "").not.toContain(translate("input.approval.yoloConfirmTitle"));
	});
});
