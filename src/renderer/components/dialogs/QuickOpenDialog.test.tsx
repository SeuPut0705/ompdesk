/**
 * ⌘P quick open: lists the focused tab's workspace files through `fs.list`,
 * filters by file name as the user types, opens the pick in the Files viewer,
 * and states a failed or truncated listing instead of showing a blank list.
 */

import { parseHTML } from "linkedom";
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcFsListResult } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { QuickOpenDialog } from "./QuickOpenDialog";

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

const LISTING: IpcFsListResult = {
	ok: true,
	truncated: false,
	entries: [
		{ name: "README.md", path: "README.md", kind: "file" },
		{
			name: "src",
			path: "src",
			kind: "dir",
			children: [
				{ name: "app.ts", path: "src/app.ts", kind: "file" },
				{ name: "router.ts", path: "src/router.ts", kind: "file" },
			],
		},
	],
};

const list = vi.fn(
	async (_path?: string, _depth?: number, _max?: number, _tabId?: string): Promise<IpcFsListResult> => LISTING,
);
Object.assign(window as unknown as Record<string, unknown>, { omp: { fs: { list } } });

let root: Root | null = null;

async function settle(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(onCommit?: () => void): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/work/app", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
	});
	setFocusedSessionRuntime("t1");
	useUiStore.getState().openQuickOpen();
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<Profiler id="quick-open" onRender={() => onCommit?.()}>
					<QuickOpenDialog />
				</Profiler>
			</I18nProvider>,
		);
	});
	await settle();
}

function reactProps(element: unknown): Record<string, (event: object) => void> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return (key ? record[key] : {}) as Record<string, (event: object) => void>;
}

function field(): HTMLInputElement {
	const input = document.body.querySelector(`input[aria-label="${translate("quickOpen.title")}"]`);
	expect(input).not.toBeNull();
	return input as unknown as HTMLInputElement;
}

async function type(value: string): Promise<void> {
	const input = field();
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
	await act(async () => reactProps(input).onChange?.({ target: input, currentTarget: input }));
}

async function press(key: string): Promise<void> {
	const input = field();
	await act(async () =>
		reactProps(input).onKeyDown?.({ key, preventDefault() {}, nativeEvent: { isComposing: false } }),
	);
}

const options = () =>
	Array.from(document.body.querySelectorAll('[role="option"]')).map(option => option.getAttribute("data-path"));

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.setState({ quickOpenOpen: false, filePreviewPath: null });
	useTabsStore.getState().reset();
	list.mockReset();
	list.mockImplementation(async () => LISTING);
});

describe("QuickOpenDialog", () => {
	it("lists the focused tab's files and opens the typed match in the Files viewer", async () => {
		await mount();
		expect(list).toHaveBeenCalledWith(undefined, expect.any(Number), expect.any(Number), "t1");
		expect(options()).toEqual(["README.md", "src/app.ts", "src/router.ts"]);

		await type("rout");
		expect(options()).toEqual(["src/router.ts"]);
		await press("Enter");

		expect(useUiStore.getState().filePreviewPath).toBe("src/router.ts");
		expect(useUiStore.getState().panelTab).toBe("files");
		expect(useUiStore.getState().quickOpenOpen).toBe(false);
	});

	it("reopens on an empty query from its first frame after a pick", async () => {
		// Every commit's field value: the reopened dialog must never paint (and take
		// keystrokes on) the last query, not even for the one commit before effects.
		const painted: string[] = [];
		await mount(() => {
			const input = document.body.querySelector(`input[aria-label="${translate("quickOpen.title")}"]`);
			if (input) painted.push((input as unknown as HTMLInputElement).value);
		});
		await type("rout");
		await press("Enter");
		expect(useUiStore.getState().quickOpenOpen).toBe(false);
		await settle();

		painted.length = 0;
		await act(async () => useUiStore.getState().openQuickOpen());
		await settle();
		expect(painted.length).toBeGreaterThan(0);
		expect(painted.every(value => value === "")).toBe(true);
		expect(field().value).toBe("");
		expect(options()).toEqual(["README.md", "src/app.ts", "src/router.ts"]);
	});

	it("says when nothing matches", async () => {
		await mount();
		await type("zzz");
		expect(options()).toEqual([]);
		expect(document.body.textContent).toContain(translate("quickOpen.noMatch", { query: "zzz" }));
	});

	it("shows a failed listing with a retry that lists again", async () => {
		list.mockImplementationOnce(async () => ({ ok: false, entries: [], truncated: false, error: "EACCES" }));
		await mount();
		expect(document.body.textContent).toContain(translate("quickOpen.failed"));
		const retry = Array.from(document.body.querySelectorAll("button")).find(
			button => (button.textContent ?? "").trim() === translate("common.retry"),
		) as unknown as HTMLButtonElement;
		await act(async () => retry.click());
		await settle();
		expect(options()).toEqual(["README.md", "src/app.ts", "src/router.ts"]);
	});

	it("notes a truncated listing of a large folder", async () => {
		list.mockImplementationOnce(async () => ({ ...LISTING, truncated: true }));
		await mount();
		expect(document.body.textContent).toContain(translate("quickOpen.truncated", { count: 3 }));
	});
});
