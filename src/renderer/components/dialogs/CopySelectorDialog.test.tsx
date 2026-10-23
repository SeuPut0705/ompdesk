/**
 * CopySelectorDialog (`/copy`): the targets the session offers, one chosen at a time with its preview beside it. The
 * chosen row is the list's current item (a screen reader reads it as current, not as a pressed toggle), and the
 * arrows move the choice and the focus with it.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { CopySelectorDialog } from "./CopySelectorDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, CustomEvent, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

let focused: unknown = null;
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
elementPrototype.focus = function (this: unknown) {
	focused = this;
};
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused ?? document.body });

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: HTMLElement;
let root: Root;
let rpc: Record<string, Mock>;

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

beforeEach(async () => {
	useSessionStore.setState({ status: "ready" });
	rpc = {
		getCopyTargets: vi.fn(async () =>
			ok({
				targets: [
					{ id: "a", label: "Last reply", preview: "A", content: "A" },
					{ id: "b", label: "Last code block", preview: "B", content: "B" },
				],
			}),
		),
	};
	(window as unknown as { omp: unknown }).omp = { rpc };
	useUiStore.setState({ copySelectorOpen: true });
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<CopySelectorDialog />
			</I18nProvider>,
		);
	});
	await flush();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	focused = null;
	useUiStore.setState({ copySelectorOpen: false });
	useSessionStore.getState().reset();
});

const rows = () => Array.from(document.querySelectorAll("[data-copy-index]")) as unknown as HTMLElement[];

describe("CopySelectorDialog", () => {
	it("marks the chosen target as the list's current item, and the arrows move the choice and the focus", async () => {
		expect(rows().map(row => row.getAttribute("aria-current"))).toEqual(["true", null]);
		expect(rows().some(row => row.hasAttribute("aria-pressed"))).toBe(false);
		focused = rows()[0];
		const key = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(key, "key", { value: "ArrowDown" });
		Object.defineProperty(key, "eventPhase", { value: 0, writable: true, configurable: true });
		await act(async () => {
			rows()[0]?.dispatchEvent(key);
		});
		await flush();
		expect(rows().map(row => row.getAttribute("aria-current"))).toEqual([null, "true"]);
		expect(focused).toBe(rows()[1]);
	});
});
