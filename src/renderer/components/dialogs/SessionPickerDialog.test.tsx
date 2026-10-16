/**
 * ⇧⌘F session search: a typed query ranks titles and first prompts at once,
 * then the main-process transcript grep adds sessions that only mention it
 * in the conversation, each quoting the matching text. The grep's pending
 * state is visible, so an empty tail never reads as "nothing else matched".
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContentMatch, SessionInfo } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { SessionPickerDialog } from "./SessionPickerDialog";

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

function session(id: string, title: string): SessionInfo {
	return {
		id,
		path: `/s/${id}.jsonl`,
		title,
		cwd: "/work/app",
		created: "2026-10-01T00:00:00.000Z",
		modified: "2026-10-02T00:00:00.000Z",
		messageCount: 4,
		size: 100,
		status: "complete",
		firstMessage: title,
	};
}

const SESSIONS = [session("a", "Queue retry design"), session("b", "Release notes")];
let pendingSearch: PromiseWithResolvers<SessionContentMatch[]> | null = null;
const search = vi.fn((_query: string, _scope: string): Promise<SessionContentMatch[]> => {
	pendingSearch = Promise.withResolvers<SessionContentMatch[]>();
	return pendingSearch.promise;
});
const list = vi.fn(async (_scope: string): Promise<SessionInfo[]> => SESSIONS);
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { sessions: { list, search } },
});

let root: Root | null = null;

async function flush(ms = 0): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

async function mount(): Promise<void> {
	useUiStore.getState().openSessionPicker();
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SessionPickerDialog />
			</I18nProvider>,
		);
	});
	await flush();
}

async function type(value: string): Promise<void> {
	const input = document.body.querySelector(
		`input[aria-label="${translate("sessionPicker.searchLabel")}"]`,
	) as unknown as Record<string, unknown>;
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
	const key = Object.getOwnPropertyNames(input).find(name => name.startsWith("__reactProps$"));
	const props = (key ? input[key] : {}) as { onChange?: (event: object) => void };
	await act(async () => props.onChange?.({ target: input, currentTarget: input }));
}

const rows = () =>
	Array.from(document.body.querySelectorAll('[role="option"]')).map(row => (row.textContent ?? "").trim());

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.setState({ sessionPickerOpen: false });
	pendingSearch = null;
	search.mockClear();
	vi.useRealTimers();
});

describe("SessionPickerDialog content search", () => {
	it("adds transcript-only hits with the matching text after title hits", async () => {
		await mount();
		await type("retry");
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toContain("Queue retry design");

		await flush(250);
		expect(search).toHaveBeenCalledWith("retry", "global");
		expect(document.body.textContent).toContain(translate("sessionPicker.searchingContent"));

		await act(async () =>
			pendingSearch?.resolve([
				{ path: "/s/a.jsonl" },
				{ path: "/s/b.jsonl", snippet: "…we moved the retry into the queue worker…" },
			]),
		);
		await flush();
		expect(document.body.textContent).not.toContain(translate("sessionPicker.searchingContent"));
		expect(rows()).toHaveLength(2);
		expect(rows()[1]).toContain("Release notes");
		expect(rows()[1]).toContain("…we moved the retry into the queue worker…");
		expect(rows()[1]).toContain(translate("sessionPicker.contentMatch"));
	});
});

describe("SessionPickerDialog listing", () => {
	it("leaves out a session file with no conversation yet (stock's header-only new session)", async () => {
		const headerOnly: SessionInfo = { ...session("empty", ""), messageCount: 0, firstMessage: "", title: null };
		list.mockResolvedValueOnce([...SESSIONS, headerOnly]);
		await mount();
		expect(rows()).toHaveLength(2);
		expect(rows().join("\n")).toContain("Queue retry design");
		expect(rows().join("\n")).toContain("Release notes");
	});
});
