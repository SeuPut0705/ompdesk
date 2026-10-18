/**
 * Contract tests for the Run settings thinking-level field: it must offer
 * exactly the selectors the active model supports — off, auto, and the
 * model's own ladder — with the current selector chosen, and a change must
 * send that explicit value (never an unspecified "next" one). The receipt is
 * authoritative, but only for the tab that asked. Unsupported models get an
 * honest note instead of a dead control.
 * Rendered with react-dom/client into a linkedom document.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { ThinkingLevelField } from "./ThinkingControl";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	value: string;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	querySelectorAll: (selector: string) => TestElement[];
}

let setThinkingLevelMock: Mock<(level: string) => Promise<RpcResponse>>;

function installMockOmp(): void {
	setThinkingLevelMock = vi.fn(
		async level =>
			({
				type: "response",
				command: "set_thinking_level",
				success: true,
				data: { thinkingLevel: level === "auto" ? "medium" : level, thinkingConfigured: level },
			}) as RpcResponse,
	);
	const ompWindow = window as unknown as { omp: { rpc: { setThinkingLevel: typeof setThinkingLevelMock } } };
	ompWindow.omp = { rpc: { setThinkingLevel: setThinkingLevelMock } };
}

let container: TestElement;
let root: Root;

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

function field(): TestElement | null {
	return document.querySelector("select[data-thinking-level]") as unknown as TestElement | null;
}

function options(): string[] {
	return Array.from(field()?.querySelectorAll("option") ?? []).map(option => option.value);
}

/** Pick a value and drive the select's React onChange contract. */
async function choose(value: string): Promise<void> {
	const select = field();
	if (!select) throw new Error("thinking level field missing");
	const record = select as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
	if (!props?.onChange) throw new Error("select onChange not found");
	// linkedom's select.value is read-only; the handler reads the event target.
	await act(async () => props.onChange?.({ target: { value }, currentTarget: { value } }));
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
});

describe("ThinkingLevelField", () => {
	it("offers off, auto, and exactly the model-supported ladder with the current selector chosen", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
			availableThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		});
		await mount(<ThinkingLevelField />);

		expect(options()).toEqual(["off", "auto", "low", "medium", "high", "xhigh", "max"]);
		expect(field()?.value).toBe("medium");
		// Localized names, and the chosen level's description as the hint.
		expect(container.textContent).toContain(translate("input.thinking.name.xhigh"));
		expect(container.textContent).toContain(translate("input.thinking.level.medium"));
	});

	it("sends the explicitly picked value and applies the authoritative receipt", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
			availableThinkingLevels: ["low", "medium", "high"],
		});
		await mount(<ThinkingLevelField />);

		await choose("high");
		await flush();

		expect(setThinkingLevelMock).toHaveBeenCalledWith("high");
		expect(useModelStore.getState().thinkingConfigured).toBe("high");
		expect(useModelStore.getState().thinkingLevel).toBe("high");
	});

	it("renders the same choices as one radio row (the model picker's effort row) with arrows moving the choice", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
			availableThinkingLevels: ["low", "medium", "high"],
		});
		await mount(<ThinkingLevelField variant="segmented" />);

		const radios = Array.from(document.querySelectorAll("[role=radio]")) as unknown as TestElement[];
		expect(radios.map(radio => radio.textContent)).toEqual(["Off", "Auto", "Low", "Medium", "High"]);
		expect(radios.map(radio => (radio as unknown as Element).getAttribute("aria-checked"))).toEqual([
			"false",
			"false",
			"false",
			"true",
			"false",
		]);
		expect(container.textContent).toContain(translate("input.thinking.level.medium"));

		// One tab stop: the chosen one. A click sends the explicit value; ArrowRight moves to the next.
		await act(async () => (radios[4] as unknown as { click(): void }).click());
		await flush();
		expect(setThinkingLevelMock).toHaveBeenCalledWith("high");
		expect(useModelStore.getState().thinkingConfigured).toBe("high");
		const group = document.querySelector("[role=radiogroup]") as unknown as Element;
		const arrow = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(arrow, "key", { value: "ArrowLeft" });
		await act(async () => group.dispatchEvent(arrow));
		await flush();
		expect(setThinkingLevelMock).toHaveBeenLastCalledWith("medium");
	});

	it("shows the effective clamped level returned by the sidecar", async () => {
		installMockOmp();
		setThinkingLevelMock.mockResolvedValue({
			type: "response",
			command: "set_thinking_level",
			success: true,
			data: { thinkingLevel: "high", thinkingConfigured: "high" },
		});
		useModelStore.setState({
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
			availableThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		});
		await mount(<ThinkingLevelField />);

		await choose("max");
		await flush();

		expect(setThinkingLevelMock).toHaveBeenCalledWith("max");
		expect(useModelStore.getState().thinkingConfigured).toBe("high");
		expect(useModelStore.getState().thinkingLevel).toBe("high");
	});

	it("does not apply a late receipt to a different tab", async () => {
		installMockOmp();
		const receipt = Promise.withResolvers<RpcResponse>();
		setThinkingLevelMock.mockReturnValue(receipt.promise);
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/one", status: "ready", kind: "agent", unreadDone: false },
				{ id: "t1", cwd: "/two", status: "ready", kind: "agent", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useSessionStore.setState({ sessionId: "session-one" });
		useModelStore.setState({
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
			availableThinkingLevels: ["medium", "high"],
		});
		await mount(<ThinkingLevelField />);

		await choose("high");

		await act(async () => {
			useTabsStore.setState({ activeTabId: "t1" });
			useSessionStore.setState({ sessionId: "session-two" });
			useModelStore.setState({ thinkingLevel: "low", thinkingConfigured: "low" });
			receipt.resolve({
				type: "response",
				command: "set_thinking_level",
				success: true,
				data: { thinkingLevel: "high", thinkingConfigured: "high" },
			});
		});
		await flush();

		expect(useModelStore.getState().thinkingConfigured).toBe("low");
		expect(useModelStore.getState().thinkingLevel).toBe("low");
	});

	it("offers auto as a first-class selector", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "high",
			thinkingConfigured: "high",
			availableThinkingLevels: ["low", "medium", "high"],
		});
		await mount(<ThinkingLevelField />);

		await choose("auto");
		await flush();

		expect(setThinkingLevelMock).toHaveBeenCalledWith("auto");
		expect(useModelStore.getState().thinkingConfigured).toBe("auto");
		expect(useModelStore.getState().thinkingLevel).toBe("medium");
	});

	it("shows an honest note instead of a control when the model does not reason", async () => {
		installMockOmp();
		useModelStore.setState({ thinkingLevel: undefined, thinkingConfigured: undefined, availableThinkingLevels: [] });
		await mount(<ThinkingLevelField />);

		expect(field()).toBeNull();
		expect(container.textContent).toContain("does not support reasoning");
	});
});
