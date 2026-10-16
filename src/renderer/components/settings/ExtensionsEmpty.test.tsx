/**
 * Settings › Tools & extensions › MCP servers with nothing configured: the
 * empty state carries the only "Add server" action and says there are none,
 * so the toolbar repeats neither the action nor a "0 servers" count.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { resetTabRoute } from "../../lib/tab-routing";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { ExtensionsSection } from "./ExtensionsSection";

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

it("an empty MCP list shows one Add server action and no zero count", async () => {
	const getMcpServers = vi.fn(async () => ({
		type: "response",
		command: "mcp",
		success: true,
		data: { servers: [] },
	}));
	const builtinRea = { get: vi.fn(async () => ({ enabled: true, available: true, nodeVersion: "v24.11.0" })) };
	const prefs = { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) };
	Object.assign(window as unknown as Record<string, unknown>, { omp: { rpc: { getMcpServers }, builtinRea, prefs } });
	useSessionStore.setState({ status: "ready", cwd: "/repo" });
	useTabsStore.setState({
		activeTabId: "tab-1",
		tabs: [{ id: "tab-1", cwd: "/repo", status: "ready", kind: "agent", unreadDone: false }],
		bundles: new Map(),
	});
	resetTabRoute();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ExtensionsSection onTabChange={() => {}} query="" tab="mcp" />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(getMcpServers).toHaveBeenCalledTimes(1);
	const text = document.body.textContent ?? "";
	expect(text).toContain("No MCP servers configured.");
	const add = Array.from(document.querySelectorAll("button")).filter(
		button => (button.textContent ?? "").trim() === "Add server",
	);
	expect(add).toHaveLength(1);
	expect(text).not.toContain("0 servers");
});
