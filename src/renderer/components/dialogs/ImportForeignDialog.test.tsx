/**
 * B15: the Claude/Codex import dialog narrows sessions by project and time,
 * selects every shown session at once, imports them one by one with progress,
 * and keeps importing in the background once the dialog is closed.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcForeignSessionInfo, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { ImportForeignDialog } from "./ImportForeignDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const DAY = 86_400_000;
function session(id: string, cwd: string, daysAgo: number): RpcForeignSessionInfo {
	const at = new Date(Date.now() - daysAgo * DAY).toISOString();
	return { id, path: `/src/${id}.jsonl`, cwd, title: `Session ${id}`, created: at, modified: at, firstMessage: id };
}
const SESSIONS = [session("a", "/code/app", 1), session("b", "/code/app", 40), session("c", "/code/site", 2)];

/** Pending imports, settled by the test in order. */
let pending: Array<() => void> = [];
const rpc = {
	listForeignSessions: vi.fn(
		async (): Promise<RpcResponse> => ({
			type: "response",
			command: "list_foreign_sessions",
			success: true,
			data: { sessions: SESSIONS },
		}),
	),
	importForeignSession: vi.fn(
		(_source: string, foreignId: string) =>
			new Promise<RpcResponse>(resolve => {
				pending.push(() =>
					resolve({
						type: "response",
						command: "import_foreign_session",
						success: true,
						data: { sessionPath: `/omp/${foreignId}.jsonl`, sessionId: foreignId, cwd: "/code/app" },
					}),
				);
			}),
	),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { rpc } });

let root: Root | null = null;

async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mount(): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	useUiStore.setState({ importDialogOpen: true });
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>{useUiStore.getState().importDialogOpen ? <ImportForeignDialog /> : null}</I18nProvider>,
		);
	});
	await flush();
}

const rows = () =>
	Array.from(document.body.querySelectorAll("label")).filter(label => label.textContent?.includes("Session"));

/** linkedom never fires React's change event (and its select value is read-only): call the control's own onChange. */
function change(element: Element | null, value?: string): void {
	if (!element) throw new Error("control not found");
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
	const target = value === undefined ? element : { value };
	props?.onChange?.({ target, currentTarget: target });
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	pending = [];
	rpc.importForeignSession.mockClear();
	useToastStore.setState({ toasts: [] });
	useSessionStore.getState().reset();
});

describe("ImportForeignDialog", () => {
	it("filters by project and time, selects all shown sessions and imports them with progress", async () => {
		await mount();
		expect(rows()).toHaveLength(3);

		await act(async () => change(document.body.querySelector("select[data-import-project]"), "/code/app"));
		expect(rows()).toHaveLength(2);
		await act(async () => change(document.body.querySelector("select[data-import-range]"), "30"));
		expect(rows()).toHaveLength(1);
		await act(async () => change(document.body.querySelector("select[data-import-range]"), "all"));

		await act(async () => change(document.body.querySelector("[data-import-select-all]")));
		const importButton = Array.from(document.body.querySelectorAll("button")).find(
			button => button.textContent?.trim() === translate("import.importN", { count: 2 }),
		);
		expect(importButton).toBeDefined();
		await act(async () => importButton?.click());
		await flush();
		expect(document.body.querySelector("[data-import-progress]")?.textContent).toContain(
			translate("import.progress", { done: 0, total: 2 }),
		);
		await act(async () => pending.shift()?.());
		await flush();
		expect(document.body.querySelector("[data-import-progress]")?.textContent).toContain(
			translate("import.progress", { done: 1, total: 2 }),
		);
		await act(async () => pending.shift()?.());
		await flush();
		expect(rpc.importForeignSession.mock.calls.map(call => call[1])).toEqual(["a", "b"]);
		expect(useToastStore.getState().toasts.at(-1)?.message).toBe(translate("import.imported", { count: 2 }));
		expect(document.body.querySelector("[data-import-progress]")).toBeNull();
	});

	it("keeps importing after the dialog closes and reports by toast", async () => {
		await mount();
		await act(async () => change(document.body.querySelector("[data-import-select-all]")));
		const importButton = Array.from(document.body.querySelectorAll("button")).find(button =>
			button.textContent?.includes(translate("import.importN", { count: 3 })),
		);
		await act(async () => importButton?.click());
		await flush();

		// Closing mid-import (the store flag is what App renders the dialog from).
		await act(async () => {
			root?.unmount();
		});
		root = null;
		for (let i = 0; i < 3; i++) {
			await act(async () => pending.shift()?.());
			await flush();
		}
		expect(rpc.importForeignSession).toHaveBeenCalledTimes(3);
		expect(useToastStore.getState().toasts.at(-1)?.message).toBe(translate("import.imported", { count: 3 }));
	});
});
