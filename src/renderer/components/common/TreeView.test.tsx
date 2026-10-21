import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { type TreeNode, TreeView } from "./TreeView";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	click: () => void;
	remove: () => void;
}

let container: TestElement;
let root: Root;

async function mount(nodes: TreeNode[], onExpandedChange: (expanded: Set<string>) => void): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TreeView expanded={new Set()} nodes={nodes} onExpandedChange={onExpandedChange} />
			</I18nProvider>,
		);
	});
}

function row(id: string): TestElement {
	return document.querySelector(`[data-tree-id="${id}"]`) as unknown as TestElement;
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
});

describe("a tree row", () => {
	it("with children and no action of its own opens them, so the whole row is the target (a JSON key)", async () => {
		const changed = vi.fn();
		await mount([{ id: "key", label: "key", children: [{ id: "leaf", label: "leaf" }] }], changed);
		await act(async () => row("key").click());
		expect(changed).toHaveBeenCalledWith(new Set(["key"]));
	});

	it("with an action of its own runs that action instead (a folder of the Files view toggles itself)", async () => {
		const changed = vi.fn();
		const action = vi.fn();
		await mount([{ id: "dir", label: "dir", onClick: action, children: [{ id: "file", label: "file" }] }], changed);
		await act(async () => row("dir").click());
		expect(action).toHaveBeenCalledTimes(1);
		expect(changed).not.toHaveBeenCalled();
	});

	it("without children or an action does nothing", async () => {
		const changed = vi.fn();
		await mount([{ id: "leaf", label: "leaf" }], changed);
		await act(async () => row("leaf").click());
		expect(changed).not.toHaveBeenCalled();
	});
});
