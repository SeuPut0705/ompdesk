/**
 * TabRuntimeProvider follows a runtime replaced by a session change on the
 * same tab (drop, /new, resume), so window-level surfaces (stats, settings,
 * the side panel) never keep commanding the retired runtime.
 */
import { parseHTML } from "linkedom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionStore, useSessionStore } from "../stores/session";
import {
	deleteSessionRuntime,
	sessionRuntime,
	sessionRuntimeStore,
	useTabCommand,
} from "../stores/session-runtime-context";
import { replaceTabRuntime } from "../stores/tab-runtime";
import { FocusedRuntimeProvider, TabRuntimeProvider } from "./tab-runtime-provider";

const { document, window, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLElement;
let seenCommand: unknown = null;

function Probe() {
	seenCommand = useTabCommand();
	return <span>{useSessionStore(s => s.sessionId)}</span>;
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	deleteSessionRuntime("t1");
	seenCommand = null;
});

describe("TabRuntimeProvider", () => {
	it("hands its subtree the tab's replacement runtime after a same-tab session change", async () => {
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container);
		root = createRoot(container as unknown as Element);
		await act(async () => root.render(<TabRuntimeProvider tabId="t1">{<Probe />}</TabRuntimeProvider>));
		await act(async () => sessionRuntimeStore<SessionStore>("t1", "session")?.setState({ sessionId: "deleted" }));
		expect(container.textContent).toBe("deleted");

		await act(async () => {
			replaceTabRuntime("t1");
			sessionRuntimeStore<SessionStore>("t1", "session")?.setState({ sessionId: "replacement" });
		});

		expect(container.textContent).toBe("replacement");
		expect(seenCommand).toBe(sessionRuntime("t1")?.command);
	});
});

describe("FocusedRuntimeProvider", () => {
	it("keeps the app surface mounted when the first tab list names the focused tab", async () => {
		// The whole surface used to remount here (its wrapper changed type), so a phone drawer opened right after the
		// page loaded closed again: AppShell's drawer sync ran anew and put the session list away.
		let mounts = 0;
		function Surface() {
			useEffect(() => {
				mounts++;
			}, []);
			return <Probe />;
		}
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container);
		root = createRoot(container as unknown as Element);
		await act(async () => root.render(<FocusedRuntimeProvider tabId={null}>{<Surface />}</FocusedRuntimeProvider>));
		await act(async () => root.render(<FocusedRuntimeProvider tabId="t1">{<Surface />}</FocusedRuntimeProvider>));
		expect(mounts).toBe(1);
		expect(seenCommand).toBe(sessionRuntime("t1")?.command);
	});
});
