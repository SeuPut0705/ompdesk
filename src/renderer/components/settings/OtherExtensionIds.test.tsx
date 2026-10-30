/**
 * Settings › Tools & extensions › other disabled extension IDs: when the three lists it subtracts cannot be read,
 * the banner says so in the person's language and keeps the raw cause as the quiet line under it, without the
 * `Error:` prefix `String(error)` adds.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { resetTabRoute } from "../../lib/tab-routing";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { OtherExtensionIds } from "./OtherExtensionIds";
import { type SettingsData, SettingsDataProvider } from "./settings-data";

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

let root: Root | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	resetTabRoute();
	vi.restoreAllMocks();
});

it("a failed read shows a localized title and the raw cause without the Error: prefix", async () => {
	const failure = {
		type: "response",
		command: "get_context_files",
		success: false,
		error: "Fixture bridge does not implement get_context_files",
	};
	const ok = { type: "response", command: "x", success: true, data: { skills: [], hooks: [], files: [] } };
	const rpc = {
		getSkills: vi.fn(async () => ok),
		getHooks: vi.fn(async () => ok),
		getContextFiles: vi.fn(async () => failure),
	};
	Object.assign(window as unknown as Record<string, unknown>, {
		omp: { rpc, events: { onConfigUpdate: () => () => {} } },
	});
	useSessionStore.setState({ status: "ready", cwd: "/repo" });
	useTabsStore.setState({
		activeTabId: "tab-1",
		tabs: [{ id: "tab-1", cwd: "/repo", status: "ready", kind: "agent", unreadDone: false }],
		bundles: new Map(),
	});
	resetTabRoute();
	const data = { values: {}, sidecarReady: true, onCommitted: () => {} } as unknown as SettingsData;
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SettingsDataProvider value={data}>
					<OtherExtensionIds />
				</SettingsDataProvider>
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});

	const text = document.body.textContent ?? "";
	expect(text).toContain("Couldn't load extensions");
	expect(document.querySelector("[data-error-detail]")?.textContent).toBe(
		"Fixture bridge does not implement get_context_files",
	);
	expect(text).not.toContain("Error:");
});
