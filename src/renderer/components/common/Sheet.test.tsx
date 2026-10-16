import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushBackLayer, startBackLayers } from "../../lib/back-layer";
import { I18nProvider } from "../../lib/i18n";
import { Sheet, type SheetPlacement } from "./Sheet";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

async function mount(element: ReactElement): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("Sheet placements", () => {
	it.each<[SheetPlacement, boolean]>([
		["right", false],
		["left", false],
		["bottom", true],
		["full", true],
	])("%s: marks its edge and carries a drag handle only for bottom and full", async (placement, handle) => {
		await mount(
			<Sheet onClose={() => {}} open placement={placement} title="Details">
				body
			</Sheet>,
		);
		expect(document.querySelector(`[data-sheet-placement="${placement}"]`)).not.toBeNull();
		expect(document.querySelector("[data-sheet-handle]") !== null).toBe(handle);
		expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
	});

	it("defaults to the right edge, as the desktop inspector sheet always was", async () => {
		await mount(
			<Sheet onClose={() => {}} open title="Details">
				body
			</Sheet>,
		);
		expect(document.querySelector('[data-sheet-placement="right"]')).not.toBeNull();
		expect(document.querySelector("[data-sheet-handle]")).toBeNull();
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		await mount(
			<Sheet onClose={onClose} open placement="bottom" title="Details">
				body
			</Sheet>,
		);
		await act(async () => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Escape" });
			document.dispatchEvent(event);
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("back layers", () => {
	it("a layer takes a history entry and the back gesture closes the top one", () => {
		const pushed: unknown[] = [];
		let backs = 0;
		const listeners: (() => void)[] = [];
		vi.stubGlobal("window", {
			history: { pushState: (state: unknown) => pushed.push(state), back: () => backs++ },
			addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
			removeEventListener: () => {},
		});
		const stop = startBackLayers();
		const closed: string[] = [];
		pushBackLayer(() => closed.push("first"));
		pushBackLayer(() => closed.push("second"));
		expect(pushed).toHaveLength(2);
		listeners[0]?.();
		expect(closed).toEqual(["second"]);
		// Closing the remaining one by its own button hands its entry back.
		const release = pushBackLayer(() => closed.push("third"));
		release();
		expect(backs).toBe(1);
		stop();
		vi.unstubAllGlobals();
	});

	it("does nothing outside the web shell", () => {
		const before = document.title;
		const release = pushBackLayer(() => {});
		release();
		expect(document.title).toBe(before);
	});
});
