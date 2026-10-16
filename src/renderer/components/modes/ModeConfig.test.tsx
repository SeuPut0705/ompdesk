/**
 * Tests for the inline mode configs: a mounted config against a fake RPC
 * (load, mutate, disconnected state) plus the pure status-variant contract behind them.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { GoalModeConfig, goalStatusVariant } from "./ModeConfig";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

function ok(command: string, data: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}
const goalState = {
	enabled: true,
	status: "active",
	objective: "Ship it",
	tokensUsed: 0,
	timeUsedSeconds: 600,
	timeLimitSeconds: 1800,
};
const rpc = {
	getGoal: vi.fn(async () => ok("get_goal", goalState)),
	setGoal: vi.fn(async (args: { timeLimitMinutes?: number | null }) =>
		ok("set_goal", { ...goalState, timeLimitSeconds: args.timeLimitMinutes ? args.timeLimitMinutes * 60 : null }),
	),
};
Object.assign(window, { omp: { rpc, events: { onBatch: () => () => {} } } });

interface TestElement {
	textContent: string | null;
	remove: () => void;
	querySelector: (
		selector: string,
	) => (TestElement & { click: () => void; getAttribute: (name: string) => string | null }) | null;
}

let container: TestElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.clearAllMocks();
	useSessionStore.getState().reset();
});

describe("GoalModeConfig connection", () => {
	it("shows the not-connected failure without calling the sidecar", async () => {
		useSessionStore.setState({ status: "exited" });
		await mount(<GoalModeConfig />);
		expect(rpc.getGoal).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(translate("common.notConnected"));
	});
});

async function typeInto(element: unknown, value: string): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	descriptor?.set?.call(element, value);
	const record = element as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	await act(async () => props?.onChange?.({ target: element, currentTarget: element }));
}

describe("GoalModeConfig time limit", () => {
	it("shows the used time against the limit and saves a changed limit", async () => {
		useSessionStore.setState({ status: "ready" });
		await mount(<GoalModeConfig />);
		expect(container.textContent).toContain(translate("modesPanel.goal.timeLimit"));
		expect(container.textContent).not.toContain(translate("modesPanel.goal.noTimeLimit"));
		const input = container.querySelector('input[type="number"]');
		expect(input?.getAttribute("value") ?? (input as unknown as { value: string }).value).toBe("30");
		expect(container.textContent).not.toContain(translate("modesPanel.goal.saveTimeLimit"));
		await typeInto(input, "45");
		const save = [...(container as unknown as Element).querySelectorAll("button")].find(
			button => button.textContent === translate("modesPanel.goal.saveTimeLimit"),
		);
		await act(async () => (save as unknown as { click: () => void }).click());
		expect(rpc.setGoal).toHaveBeenCalledWith({ timeLimitMinutes: 45 });
	});

	it("clears the limit when the field is emptied", async () => {
		useSessionStore.setState({ status: "ready" });
		await mount(<GoalModeConfig />);
		await typeInto(container.querySelector('input[type="number"]'), "");
		const save = [...(container as unknown as Element).querySelectorAll("button")].find(
			button => button.textContent === translate("modesPanel.goal.saveTimeLimit"),
		);
		await act(async () => (save as unknown as { click: () => void }).click());
		expect(rpc.setGoal).toHaveBeenCalledWith({ timeLimitMinutes: null });
		expect(container.textContent).toContain(translate("modesPanel.goal.noTimeLimit"));
	});
});

describe("goalStatusVariant", () => {
	it("maps known goal statuses to badge variants", () => {
		expect(goalStatusVariant("active")).toBe("success");
		expect(goalStatusVariant("paused")).toBe("warning");
		expect(goalStatusVariant("budget-limited")).toBe("error");
		expect(goalStatusVariant("complete")).toBe("info");
		expect(goalStatusVariant("dropped")).toBe("muted");
	});

	it("falls back to muted for unknown statuses", () => {
		expect(goalStatusVariant("whatever-next")).toBe("muted");
	});
});
