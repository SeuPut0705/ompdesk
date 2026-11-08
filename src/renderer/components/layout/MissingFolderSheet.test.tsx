/**
 * The sheet a click on a stored session whose folder is gone opens (`openTab`'s `folder-missing` refusal): its
 * transcript read-only with no composer, a banner naming the folder, and Restore when disk care saved the worktree
 * else Archive, which archives the session under its own id on this computer and under `hostOrderKey` on a device.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SessionInfo } from "../../../shared/ipc-types";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { preloadMarkdownPipeline } from "../../lib/markdown";
import { hostOrderKey } from "../../lib/project-order";
import { resetSessionListFeeds } from "../../stores/session-list";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { type MissingFolderRequest, useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
(window as unknown as Record<string, unknown>).setTimeout = setTimeout;
(window as unknown as Record<string, unknown>).clearTimeout = clearTimeout;

// Deferred until after the globals above: react-dom computes DOM support flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { MissingFolderSheetHost } = await import("./MissingFolderSheetHost");
// The sheet loads lazily; loaded once here, every mount resolves within a tick.
await import("./MissingFolderSheet");

interface TestElement {
	textContent: string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => ArrayLike<TestElement>;
	click: () => void;
}

const PATH = "/sessions/moda.jsonl";
const FOLDER = "/Users/seuput/Desktop/GitHub/moda-office";
const SAVED = { id: "sv1", branch: "omp/agent/x", removedAt: 1_800_000_000_000 };

const row = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	path: PATH,
	id: "moda-id",
	title: "Moda office web move",
	cwd: FOLDER,
	created: "2026-11-01T00:00:00Z",
	modified: "2026-11-01T00:00:00Z",
	messageCount: 2,
	size: 1,
	status: "complete",
	firstMessage: "move the office to the web",
	...overrides,
});

const MESSAGES: AgentMessage[] = [
	{ role: "user", timestamp: 1_000, content: [{ type: "text", text: "Move the office to the web" }] },
	{ role: "assistant", timestamp: 2_000, content: [{ type: "text", text: "The office page is moved." }] },
];

let root: Root | undefined;
let container: TestElement;
let messages: Mock<(sessionPath: string, device?: string) => Promise<AgentMessage[]>>;
let listShared: Mock<(device?: string) => Promise<unknown>>;
let openTab: Mock<(args?: unknown) => Promise<string | null>>;
let setSessionsArchived: Mock<(ids: readonly string[], archived: boolean) => Promise<void>>;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<MissingFolderSheetHost />
			</I18nProvider>,
		);
	});
	for (let round = 0; round < 6; round++) await flush();
}

async function open(request: Partial<MissingFolderRequest> = {}): Promise<void> {
	await mount();
	act(() => useUiStore.getState().openMissingFolder({ sessionPath: PATH, folder: FOLDER, ...request }));
	for (let round = 0; round < 6; round++) await flush();
}

const sheet = () => document.querySelector("[data-missing-folder-sheet]") as unknown as TestElement | null;
const restoreButton = () => document.querySelector("[data-missing-folder-restore]") as unknown as TestElement | null;
const archiveButton = () => document.querySelector("[data-missing-folder-archive]") as unknown as TestElement | null;

beforeAll(() => preloadMarkdownPipeline());

beforeEach(() => {
	messages = vi.fn(async () => MESSAGES);
	listShared = vi.fn(async () => ({ version: "1.1", sessions: [row()] }));
	openTab = vi.fn(async () => null);
	setSessionsArchived = vi.fn(async () => {});
	(window as unknown as { omp: unknown }).omp = {
		sessions: { messages, listShared },
		events: new Proxy({}, { get: () => () => () => {} }),
		prefs: { get: async () => undefined, set: async () => {} },
		runtime: { logSnapshot: async () => ({ lines: [], nextSequence: 0 }) },
	};
	resetSessionListFeeds();
	useTabsStore.setState({ openTab });
	useSidebarPrefs.setState({ setSessionsArchived });
	useUiStore.setState({ missingFolder: null, viewSheet: null, transcriptDetail: "compact" });
});

afterEach(async () => {
	if (root) {
		await act(async () => root?.unmount());
		root = undefined;
	}
	document.body.innerHTML = "";
	useUiStore.setState({ missingFolder: null });
	useToastStore.setState({ toasts: [] });
});

describe("the missing-folder sheet", () => {
	it("shows the session's title, a banner naming the folder and its transcript read-only, with no composer", async () => {
		await open();
		expect(sheet()).not.toBeNull();
		expect(document.body.textContent).toContain("Moda office web move");
		expect(sheet()?.textContent).toContain(translate("missingFolder.banner", { folder: FOLDER }));
		expect(sheet()?.textContent).toContain("Move the office to the web");
		expect(sheet()?.textContent).toContain("The office page is moved.");
		expect(messages).toHaveBeenCalledWith(PATH, undefined);
		expect(document.querySelector("textarea")).toBeNull();
		expect(document.querySelector("[data-composer]")).toBeNull();
	});

	it("offers Restore, and only Restore, when disk care saved the worktree, and restoring reopens it there", async () => {
		await open({ saved: SAVED });
		expect(sheet()?.textContent).toContain(translate("missingFolder.bannerSaved", { folder: FOLDER }));
		expect(restoreButton()?.textContent).toBe(translate("missingFolder.restore"));
		expect(archiveButton()).toBeNull();

		await act(async () => restoreButton()?.click());
		await flush();
		expect(openTab).toHaveBeenCalledWith({ sessionPath: PATH, kind: "agent", restoreSaved: true });
		expect(useUiStore.getState().missingFolder).toBeNull();
		expect(setSessionsArchived).not.toHaveBeenCalled();
	});

	it("offers Archive, and only Archive, when nothing was saved, and archives the session by its id", async () => {
		await open();
		expect(archiveButton()?.textContent).toBe(translate("missingFolder.archive"));
		expect(restoreButton()).toBeNull();

		await act(async () => archiveButton()?.click());
		await flush();
		expect(setSessionsArchived).toHaveBeenCalledWith(["moda-id"], true);
		expect(openTab).not.toHaveBeenCalled();
		expect(useUiStore.getState().missingFolder).toBeNull();
	});

	it("reads a paired device's session from that device and archives it under the device's key", async () => {
		await open({ device: "dev-1" });
		expect(messages).toHaveBeenCalledWith(PATH, "dev-1");
		expect(listShared).toHaveBeenCalledWith("dev-1");

		await act(async () => archiveButton()?.click());
		await flush();
		expect(setSessionsArchived).toHaveBeenCalledWith([hostOrderKey("dev-1", "moda-id")], true);
	});

	it("restores a device's session on that device", async () => {
		await open({ device: "dev-1", saved: SAVED });
		await act(async () => restoreButton()?.click());
		await flush();
		expect(openTab).toHaveBeenCalledWith({ sessionPath: PATH, kind: "agent", restoreSaved: true, device: "dev-1" });
	});

	it("says a transcript that could not be read, with Retry, and keeps the action", async () => {
		messages.mockRejectedValueOnce(new Error("The user hid that session from agents."));
		await open();
		expect(sheet()?.textContent).toContain(translate("subagent.transcriptFailed"));
		expect(sheet()?.textContent).toContain("hid that session");
		expect(archiveButton()).not.toBeNull();
		const retry = Array.from(sheet()?.querySelectorAll("button") ?? []).find(button =>
			button.textContent?.includes(translate("common.retry")),
		);
		await act(async () => retry?.click());
		for (let round = 0; round < 4; round++) await flush();
		expect(messages).toHaveBeenCalledTimes(2);
		expect(sheet()?.textContent).toContain("The office page is moved.");
	});

	it("shows the transcript's static skeleton, never a spinner, until a first read answers", async () => {
		const pending = Promise.withResolvers<AgentMessage[]>();
		messages.mockReturnValueOnce(pending.promise);
		await open();
		expect(sheet()?.querySelector("[data-skeleton-row]")).not.toBeNull();
		expect(sheet()?.querySelector(".omp-spinner, [data-spinner]")).toBeNull();
		await act(async () => pending.resolve(MESSAGES));
		await flush();
		expect(sheet()?.querySelector("[data-skeleton-row]")).toBeNull();
		expect(sheet()?.textContent).toContain("The office page is moved.");
	});
});
