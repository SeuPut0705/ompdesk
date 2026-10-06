import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import type { ReadGroupEntry } from "../../lib/read-group";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import type { RunningIndicator } from "./ToolCard";

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

const { createRoot } = await import("react-dom/client");
const { ReadGroupCard } = await import("./ReadGroupCard");

const entries: ReadGroupEntry[] = [
	{ callId: "read-1", toolKey: "read-1", path: "src/a.ts", args: { path: "src/a.ts" } },
	{ callId: "read-2", toolKey: "read-2", path: "src/b.ts", args: { path: "src/b.ts" } },
];

function runningRead(): ToolEntry {
	return {
		toolName: "read",
		args: {},
		status: "running",
		partialResult: null,
		streamingArgs: "",
		result: null,
		isError: false,
		startTime: 1,
		endTime: null,
	};
}

let container: HTMLElement;
let root: Root;

async function mount(runningIndicator: RunningIndicator = "spinner"): Promise<void> {
	useToolsStore.setState({
		activeTools: new Map([
			["read-1", runningRead()],
			["read-2", runningRead()],
		]),
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ReadGroupCard entries={entries} runningIndicator={runningIndicator} />
			</I18nProvider>,
		);
	});
	await act(async () => {
		(container.querySelector(".omp-read-group-header") as unknown as { click: () => void }).click();
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useToolsStore.getState().reset();
});

describe("ReadGroupCard running indicators", () => {
	it("keeps one group spinner when multiple running reads are expanded", async () => {
		await mount();
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
		expect(container.querySelectorAll(".omp-tool-status-icon")).toHaveLength(2);
	});

	it("uses only static indicators when the transcript timeline owns animation", async () => {
		await mount("dot");
		expect(container.querySelectorAll(".animate-spin, .animate-pulse")).toHaveLength(0);
		expect(container.querySelectorAll(".omp-tool-status-icon")).toHaveLength(2);
	});
});
