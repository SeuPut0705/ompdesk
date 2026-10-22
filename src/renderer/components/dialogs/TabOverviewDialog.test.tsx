/** The tab overview's search: the highlight follows the shared listbox model and starts at the top of each query. */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { TabOverviewDialog } from "./TabOverviewDialog";

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

let root: Root | null = null;

const input = () =>
	document.body.querySelector(`input[aria-label="${translate("tabOverview.search")}"]`) as unknown as Record<
		string,
		unknown
	>;

function propsOf(node: Record<string, unknown>): Record<string, (event: object) => void> {
	const key = Object.getOwnPropertyNames(node).find(name => name.startsWith("__reactProps$"));
	return (key ? node[key] : {}) as Record<string, (event: object) => void>;
}

async function type(value: string): Promise<void> {
	const field = input();
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set?.call(field, value);
	await act(async () => propsOf(field).onChange?.({ target: field, currentTarget: field }));
}

async function key(name: string): Promise<void> {
	await act(async () =>
		propsOf(input()).onKeyDown?.({ key: name, preventDefault() {}, nativeEvent: { isComposing: false, keyCode: 0 } }),
	);
}

const highlighted = () =>
	Array.from(document.body.querySelectorAll('[role="option"]'))
		.filter(row => row.getAttribute("aria-selected") === "true")
		.map(row => (row.textContent ?? "").trim());

beforeEach(async () => {
	vi.useFakeTimers();
	useTabsStore.setState({
		activeTabId: "a",
		tabs: ["alpha", "beta", "gamma"].map(name => ({
			id: name[0] as string,
			cwd: `/work/${name}`,
			status: "ready",
			kind: "agent",
			unreadDone: false,
			title: name,
		})) as never,
	});
	useUiStore.setState({ tabOverviewOpen: true });
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<TabOverviewDialog />
			</I18nProvider>,
		);
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.setState({ tabOverviewOpen: false });
	vi.useRealTimers();
});

describe("TabOverviewDialog search", () => {
	it("keeps a highlight after ↓ on no results, and starts each query at the top match", async () => {
		await key("ArrowDown");
		await key("ArrowDown");
		expect(highlighted()).toHaveLength(1);
		expect(highlighted()[0]).toContain("gamma");

		await type("zzz");
		expect(highlighted()).toEqual([]);
		await key("ArrowDown");
		await type("");
		expect(highlighted()).toHaveLength(1);
		expect(highlighted()[0]).toContain("alpha");

		await key("ArrowDown");
		await type("a");
		expect(highlighted()[0]).toContain("alpha");
	});
});
