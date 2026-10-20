import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutPeer, CheckoutPeers } from "../../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { AgentMessage, RpcAsyncJobItem, RpcJobRow } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { useWorkBoardStore } from "../../../stores/work-board";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let rows: RpcJobRow[] = [];
let changes: unknown = { isRepo: false, root: null, base: null, files: [], truncated: false };
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { rows } }));
const getGitSessionChanges = vi.fn(async () => ({ success: true, data: changes }));
Reflect.set(window, "omp", {
	rpc: { getJobs, getGitSessionChanges },
	prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { FailedCheckSection, FailedCheckWatch, SessionSection, useSessionBoard } = await import("./WorkBoardSession");
const { peerOpen } = await import("./session-board");
const { REVEAL_STEP_EVENT } = await import("../../chat/work/reveal-step");
/** What the strip's watcher reports (WorkBoardChip's failed-check label). */
const watched = vi.fn();

function Host() {
	const board = useSessionBoard();
	return (
		<>
			{board.failedCheck ? <FailedCheckSection check={board.failedCheck} /> : null}
			<SessionSection rows={board.rows} />
			<FailedCheckWatch onChange={watched} />
		</>
	);
}

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	useTabsStore.setState({
		tabs: [
			{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false },
			{ id: "t2", cwd: "/w", status: "ready", kind: "agent", unreadDone: false },
		],
		activeTabId: "t1",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<Host />
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

const row = (kind: string) => container.querySelector(`[data-board-session="${kind}"]`);
const rowKinds = () =>
	[...container.querySelectorAll("[data-board-session]")].map(el => el.getAttribute("data-board-session"));
const section = (id: string) => container.querySelector(`[data-board-section="${id}"]`);
const press = (el: Element | null) => act(async () => (el as unknown as HTMLButtonElement).click());

function bash(command: string, patch: Partial<ToolEntry> = {}): ToolEntry {
	return {
		toolName: "bash",
		args: { command },
		status: "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text: "" }], details: { exitCode: 0 } },
		isError: false,
		startTime: 1000,
		endTime: 3000,
		...patch,
	};
}

function finished(...entries: [string, ToolEntry][]): void {
	useToolsStore.setState({ finishedTools: new Map(entries) });
}

function result(text: string, exitCode: number, extra: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text }], details: { exitCode, ...extra } };
}

const peer = (over: Partial<CheckoutPeer> = {}): CheckoutPeer => ({ id: "t2", title: "Settings test race", ...over });
const checkout = (worktree: CheckoutPeer[], repo: CheckoutPeer[] = []): CheckoutPeers => ({
	toplevel: "/w",
	commonDir: "/w/.git",
	worktree,
	repo,
	canMessage: true,
});

const user: AgentMessage = { role: "user", content: "go" };
const recall = (...titles: string[]): AgentMessage => ({
	role: "custom",
	customType: "ompdesk-memory-recall",
	content: "<memory-recall>…</memory-recall>",
	display: true,
	details: { v: 1, judged: true, items: titles.map(title => ({ title, kind: "rule" })) },
});

function serverJob(label: string, resultPreview?: string): RpcJobRow {
	const job: RpcAsyncJobItem = { id: "bg_1", type: "bash", status: "running", label, startTime: 1, resultPreview };
	return { kind: "job", depth: 0, cancellable: true, job };
}

beforeEach(() => {
	getGitSessionChanges.mockClear();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.replaceChildren();
	rows = [];
	changes = { isRepo: false, root: null, base: null, files: [], truncated: false };
	useMessagesStore.getState().reset();
	useWorkBoardStore.getState().reset();
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ panelVisible: false });
});

describe("Changed row", () => {
	it("counts what the checkout changed since the session started, with added and removed lines, and opens Changes", async () => {
		changes = {
			isRepo: true,
			root: "/w",
			base: "HEAD",
			truncated: false,
			files: [
				{ path: "a.ts", status: "M", added: 3, removed: 1 },
				{ path: "b.ts", status: "M", added: 2, removed: 1 },
				{ path: "new.txt", status: "?" },
			],
		};
		await mount();
		expect(row("changes")?.textContent).toContain("3 files changed");
		expect(row("changes")?.textContent).toContain("+5");
		expect(row("changes")?.textContent).toContain("−2");
		await press(row("changes"));
		expect(useUiStore.getState().panelTab).toBe("diff");
	});

	it("is absent outside a repository and when nothing changed", async () => {
		await mount();
		expect(row("changes")).toBeNull();
		changes = { isRepo: true, root: "/w", base: "HEAD", files: [], truncated: false };
		await act(async () => {
			useTodoStore.getState().setTurnActive(true, Date.now());
		});
		await act(async () => {
			useTodoStore.getState().setTurnActive(false);
		});
		expect(row("changes")).toBeNull();
		expect(section("session")).toBeNull();
	});

	it("reads once on mount and once when a turn settles, never on a timer", async () => {
		vi.useFakeTimers();
		try {
			await mount();
			expect(getGitSessionChanges).toHaveBeenCalledTimes(1);
			await act(async () => {
				useTodoStore.getState().setTurnActive(true, Date.now());
			});
			expect(getGitSessionChanges).toHaveBeenCalledTimes(1);
			await act(async () => {
				vi.advanceTimersByTime(60_000);
			});
			expect(getGitSessionChanges).toHaveBeenCalledTimes(1);
			await act(async () => {
				useTodoStore.getState().setTurnActive(false);
			});
			expect(getGitSessionChanges).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Last check row", () => {
	it("reads the work card's verdict of a passing test run, with its duration and command", async () => {
		finished(["b1", bash("bunx vitest run", { result: result("Tests 128 passed (128)", 0) })]);
		await mount();
		const check = row("check");
		expect(check?.getAttribute("data-state")).toBe("passed");
		expect(check?.textContent).toContain("128 tests passed");
		expect(check?.textContent).toContain("2.0s");
		expect(check?.closest("button")?.getAttribute("title") ?? check?.getAttribute("title")).toBe("bunx vitest run");
		expect(section("session")).not.toBeNull();
		expect(section("check")).toBeNull();
	});

	it("is absent when the session ran no check", async () => {
		finished(["b1", bash("ls -la")]);
		await mount();
		expect(row("check")).toBeNull();
		expect(section("session")).toBeNull();
	});

	it("a failed newest check is its own section, not a session row, and its tap asks the transcript for the call", async () => {
		finished(
			["b1", bash("bun run build", { startTime: 100, endTime: 200 })],
			[
				"b2",
				bash("bun test", {
					startTime: 5000,
					endTime: 9000,
					isError: true,
					status: "error",
					result: result("(fail) math > adds\n 3 pass\n 2 fail", 1),
				}),
			],
		);
		await mount();
		const failed = section("check")?.querySelector('[data-board-session="check"]');
		expect(failed?.getAttribute("data-state")).toBe("failed");
		expect(failed?.textContent).toContain("2 tests failed");
		expect(container.querySelectorAll('[data-board-section="session"] [data-board-session="check"]')).toHaveLength(0);
		// The strip hears it too (FailedCheckWatch, the strip's label "Check failed").
		expect(watched).toHaveBeenLastCalledWith(true);
		// The tap asks the board's own tab's transcript to open the card holding the call (it may be collapsed or
		// not mounted), not the document at large.
		const asked: unknown[] = [];
		const listen = (event: Event) => asked.push(event instanceof CustomEvent ? event.detail : null);
		window.addEventListener(REVEAL_STEP_EVENT, listen);
		await press(failed ?? null);
		window.removeEventListener(REVEAL_STEP_EVENT, listen);
		expect(asked).toEqual([{ tabId: "t1", key: "b2" }]);
	});

	it("a failed check that a later passing run replaced is no longer failed", async () => {
		finished(
			["b1", bash("bun test", { startTime: 100, endTime: 200, status: "error", result: result("1 fail", 1) })],
			["b2", bash("bun test", { startTime: 300, endTime: 400, result: result("4 pass", 0) })],
		);
		await mount();
		expect(section("check")).toBeNull();
		expect(row("check")?.getAttribute("data-state")).toBe("passed");
		expect(watched).toHaveBeenLastCalledWith(false);
	});

	it("reads running while the call runs", async () => {
		useToolsStore.setState({
			liveTools: new Map([["b1", bash("bun run typecheck", { status: "running", result: null, endTime: null })]]),
		});
		await mount();
		expect(row("check")?.getAttribute("data-state")).toBe("running");
		expect(row("check")?.textContent).toContain("types checking");
	});

	it("a backgrounded check without a verdict reads running, never passed, and passes once the verdict arrives", async () => {
		finished([
			"b1",
			bash("bunx vitest run", {
				result: result("Started in the background", 0, { async: { state: "running", jobId: "bg_9" } }),
			}),
		]);
		await mount();
		expect(row("check")?.getAttribute("data-state")).toBe("running");
		expect(row("check")?.textContent).toContain("tests running");
		await act(async () =>
			useMessagesStore.setState({
				messages: [
					{
						role: "toolResult",
						toolName: "wait",
						details: { jobs: [{ id: "bg_9", status: "completed", exitCode: 0, resultText: "12 passed" }] },
					},
				],
			}),
		);
		expect(row("check")?.getAttribute("data-state")).toBe("passed");
		expect(row("check")?.textContent).toContain("12 tests passed");
	});
});

describe("Same checkout row", () => {
	it("counts the sessions in this checkout and lists their titles, a paired device's in parentheses", async () => {
		useSessionStore.setState({
			checkoutPeers: checkout([peer(), peer({ id: null, title: "Fix the sidebar", device: "iPhone" })]),
		});
		await mount();
		const peers = row("peers");
		expect(peers?.textContent).toContain("2 sessions in this checkout");
		expect(peers?.getAttribute("title")).toBe("Settings test race\nFix the sidebar (iPhone)");
	});

	it("says repository when the others work in other worktrees only, and counts a hidden session", async () => {
		useSessionStore.setState({
			checkoutPeers: checkout([], [{ id: null, title: "", worktree: "/wt/x" }]),
		});
		await mount();
		expect(row("peers")?.textContent).toContain("1 session in this repository");
		expect(row("peers")?.getAttribute("title")).toBe("a hidden session");
	});

	it("is never shown on a session by itself", async () => {
		useSessionStore.setState({ checkoutPeers: checkout([], []) });
		await mount();
		expect(row("peers")).toBeNull();
		await act(async () => useSessionStore.setState({ checkoutPeers: null }));
		expect(row("peers")).toBeNull();
		expect(section("session")).toBeNull();
	});

	it("expands to one line per peer, each opening its own session: switch, owner window, or the host's file", async () => {
		const switchTab = vi.fn(async () => {});
		const openTab = vi.fn(async () => "new-tab");
		const getSessionOwner = vi.fn(async (path: string) =>
			path === "/s/other-window.jsonl" ? { tabId: "w2-tab", windowId: 2 } : null,
		);
		const openInNewWindow = vi.fn(async () => true);
		Reflect.set(window.omp as object, "tabs", { getSessionOwner });
		Reflect.set(window.omp as object, "sessions", { openInNewWindow });
		useSessionStore.setState({
			checkoutPeers: checkout([
				peer(),
				peer({ id: "w2-tab", title: "In another window", sessionPath: "/s/other-window.jsonl" }),
				peer({ id: null, title: "On the phone", device: "iPhone", sessionPath: "/s/phone.jsonl" }),
				peer({ id: null, title: "" }),
			]),
		});
		await mount();
		useTabsStore.setState({ switchTab, openTab });
		const items = () => [...container.querySelectorAll('[data-board-session="peer"]')];
		expect(items()).toHaveLength(0);
		// One tap lists them, and the row says it expands in place (the phone's strip stays open for it).
		expect(row("peers")?.hasAttribute("data-board-expands")).toBe(true);
		await press(row("peers"));
		expect(items().map(item => item.textContent)).toEqual([
			"Settings test race",
			"In another window",
			"On the phone · iPhone",
			"a hidden session",
		]);
		// The second peer: held by another window, so its owner is asked and that window is focused.
		await press(items()[1] ?? null);
		expect(getSessionOwner).toHaveBeenCalledWith("/s/other-window.jsonl");
		expect(openInNewWindow).toHaveBeenCalledWith({ sessionPath: "/s/other-window.jsonl" });
		// The first: a tab of this window.
		await press(items()[0] ?? null);
		expect(switchTab).toHaveBeenCalledWith("t2");
		// A paired device's session this computer runs: no owner here, so its file opens as a tab.
		await press(items()[2] ?? null);
		expect(openTab).toHaveBeenCalledWith({ sessionPath: "/s/phone.jsonl" });
		// A session hidden from agents has nothing to open.
		expect(items()[3]?.tagName).not.toBe("BUTTON");
	});
});

describe("peerOpen", () => {
	it("opens a peer of a paired host's session by the host's file, never by a tab id of this computer", () => {
		const here = {
			device: "host-1",
			tabs: [
				{ id: "t2", device: undefined },
				{ id: "r9", sessionPath: "/h/held.jsonl", device: "host-1" },
			],
		};
		expect(peerOpen({ id: "t2", title: "x", sessionPath: "/h/a.jsonl" }, here)).toEqual({
			kind: "path",
			sessionPath: "/h/a.jsonl",
			device: "host-1",
		});
		expect(peerOpen({ id: "z", title: "y", sessionPath: "/h/held.jsonl" }, here)).toEqual({
			kind: "switch",
			tabId: "r9",
		});
		expect(peerOpen({ id: null, title: "" }, here)).toBeNull();
	});
});

describe("Memory used this turn row", () => {
	it("names the first memory with how many more, and expands to one line per other title", async () => {
		useMessagesStore.setState({ messages: [user, recall("Use bun", "Sidebar paints late", "Tailscale only")] });
		await mount();
		expect(row("recall")?.textContent).toContain("Memory · Use bun");
		expect(row("recall")?.textContent).toContain("+2");
		expect(row("recall")?.getAttribute("title")).toContain("Tailscale only");
		expect(container.querySelectorAll('[data-board-session="recall-item"]')).toHaveLength(0);
		await press(row("recall"));
		expect([...container.querySelectorAll('[data-board-session="recall-item"]')].map(el => el.textContent)).toEqual([
			"Sidebar paints late",
			"Tailscale only",
		]);
		await press(row("recall"));
		expect(container.querySelectorAll('[data-board-session="recall-item"]')).toHaveLength(0);
	});

	it("is absent when the last prompt recalled nothing, even if an earlier one did", async () => {
		useMessagesStore.setState({ messages: [user, recall("Use bun"), { role: "assistant" }, user] });
		await mount();
		expect(row("recall")).toBeNull();
		await act(async () => useMessagesStore.setState({ messages: [user] }));
		expect(row("recall")).toBeNull();
	});
});

describe("Dev server row", () => {
	it("names the loopback address of a running server and opens it in Preview only when tapped", async () => {
		rows = [
			serverJob("bun run dev -- --port 5173", "  VITE ready in 412 ms\n  ➜  Local:   http://127.0.0.1:5173/\n"),
		];
		await mount();
		const server = row("dev-server");
		expect(server?.textContent).toContain("127.0.0.1:5173");
		expect(server?.closest("button")?.getAttribute("title") ?? server?.getAttribute("title")).toBe(
			"bun run dev -- --port 5173",
		);
		expect(useUiStore.getState().panelTab).not.toBe("preview");
		expect(useUiStore.getState().previewUrl).not.toBe("http://127.0.0.1:5173/");
		await press(server);
		expect(useUiStore.getState().panelTab).toBe("preview");
		expect(useUiStore.getState().previewUrl).toBe("http://127.0.0.1:5173/");
	});

	it("is absent for a job that serves nothing", async () => {
		rows = [serverJob("bunx vitest run", "RUN v3\n")];
		await mount();
		expect(row("dev-server")).toBeNull();
	});
});

describe("This session section", () => {
	it("lists Changed, Last check, Dev servers, Same checkout and Memory in that order", async () => {
		changes = { isRepo: true, root: "/w", base: "HEAD", truncated: false, files: [{ path: "a.ts", status: "M" }] };
		finished(["b1", bash("bun run build")]);
		rows = [serverJob("bun run dev", "Local: http://localhost:3000/")];
		useSessionStore.setState({ checkoutPeers: checkout([peer()]) });
		useMessagesStore.setState({ messages: [user, recall("Use bun")] });
		await mount();
		expect(rowKinds()).toEqual(["changes", "check", "dev-server", "peers", "recall"]);
		expect(section("session")?.querySelector(".omp-work-board-title")?.textContent).toBe("This session");
	});
});
