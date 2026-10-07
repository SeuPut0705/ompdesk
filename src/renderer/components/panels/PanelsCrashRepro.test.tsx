/**
 * Reproduction: mounting the diff panel against RUNNING-state stores
 * (partial tool executions) must not crash the renderer.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useToolsStore } from "../../stores/tools";
import { DiffPanel } from "./DiffPanel";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useToolsStore.getState().reset();
	useMessagesStore.getState().reset();
});

describe("panels under running state", () => {
	it("DiffPanel mounts with mid-flight tool executions (no result yet)", async () => {
		useToolsStore.setState({
			liveTools: new Map([
				[
					"call_1",
					{
						toolName: "edit",
						args: { path: "src/a.ts", old_string: "a", new_string: "b" },
						status: "running" as const,
						streamingArgs: "",
						result: null,
						isError: false,
						startTime: Date.now() - 5000,
					},
				],
				[
					"call_2",
					{
						toolName: "write",
						args: { path: "src/b.ts", content: "hello\nworld" },
						status: "pending" as const,
						streamingArgs: '{"path":"src/b.ts"',
						result: null,
						isError: false,
						startTime: Date.now() - 3000,
					},
				],
				[
					"call_3",
					{
						toolName: "bash",
						args: { command: "ls" },
						status: "running" as const,
						streamingArgs: "",
						result: null,
						isError: false,
						startTime: Date.now() - 1000,
					},
				],
			]) as never,
		});
		await mount(<DiffPanel />);
		expect(document.body.textContent).toBeTruthy();
	});

	it("DiffPanel mounts with a completed edit carrying a details diff", async () => {
		useToolsStore.setState({
			finishedTools: new Map([
				[
					"call_9",
					{
						toolName: "edit",
						args: { path: "src/a.ts", old_string: "a", new_string: "b" },
						status: "done" as const,
						streamingArgs: "",
						result: {
							content: [{ type: "text", text: "edited" }],
							details: { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b", path: "src/a.ts" },
						},
						isError: false,
						startTime: Date.now() - 9000,
						endTime: Date.now() - 8000,
					},
				],
			]) as never,
		});
		await mount(<DiffPanel />);
		await act(async () => {
			const edits = Array.from(document.querySelectorAll("button")).find(
				button => button.textContent === "Edit results",
			);
			if (!edits) throw new Error("Edit results tab missing");
			edits.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(document.body.textContent).toContain("src/a.ts");
	});
});
