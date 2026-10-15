/**
 * One session, one name: the title bar and Insights read the attached
 * session's name through this hook, and it must agree with the sidebar row
 * (stored title, else the first prompt), not stop at "New session".
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../shared/ipc-types";
import { I18nProvider, translate } from "../lib/i18n";
import { useSessionStore } from "../stores/session";
import { useCurrentSessionTitle } from "./use-current-session-title";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

function row(overrides: Partial<SessionInfo>): SessionInfo {
	return {
		path: "/work/s1.jsonl",
		id: "s1",
		title: null,
		cwd: "/work",
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		messageCount: 2,
		size: 10,
		status: "complete",
		firstMessage: "",
		...overrides,
	};
}

let listed: SessionInfo[] = [];
(window as unknown as { omp: unknown }).omp = {
	sessions: { list: vi.fn(async () => listed), delete: vi.fn(async () => {}), rename: vi.fn(async () => {}) },
	events: { onSessionsChanged: vi.fn(() => () => {}) },
};

function Probe() {
	return <span data-testid="title">{useCurrentSessionTitle()}</span>;
}

let root: Root;
let container: { remove: () => void };

async function titleFor(sessionName: string | null, rowOverrides: Partial<SessionInfo> | null): Promise<string> {
	listed = rowOverrides ? [row(rowOverrides)] : [];
	useSessionStore.setState({ status: "ready", sessionId: "s1", sessionName });
	container = document.createElement("div") as never;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<Probe />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	});
	return document.querySelector('[data-testid="title"]')?.textContent ?? "missing";
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useSessionStore.getState().reset();
});

describe("useCurrentSessionTitle", () => {
	it("falls back to the first prompt, as the sidebar row does", async () => {
		expect(await titleFor(null, { firstMessage: "Build the Tally app" })).toBe("Build the Tally app");
	});

	it("prefers the session's own name, then the stored title", async () => {
		expect(await titleFor("Tally", { title: "Stored", firstMessage: "Build" })).toBe("Tally");
		await act(async () => {
			root.unmount();
		});
		container.remove();
		expect(await titleFor(null, { title: "Stored", firstMessage: "Build" })).toBe("Stored");
	});

	it("names a session that is not indexed yet New session, and an indexed blank one Untitled", async () => {
		expect(await titleFor(null, null)).toBe(translate("sidebar.newSession"));
		await act(async () => {
			root.unmount();
		});
		container.remove();
		expect(await titleFor("  ", {})).toBe(translate("sidebar.untitled"));
	});
});
