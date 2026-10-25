import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutPeer, CheckoutPeers } from "../../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { AgentReviewItem } from "../../../../shared/agent-control";
import type { AgentMessage, RpcAsyncJobItem, RpcJobRow } from "../../../../shared/rpc-types";
import type { FamilyEdits, FamilyMemberEdits, RpcTurnEdits } from "../../../../shared/turn-edits";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { useAttentionStore } from "../../../stores/attention";
import { useClosedChildrenStore } from "../../../stores/closed-children";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { type SessionTab, useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { useWorkBoardStore } from "../../../stores/work-board";
import type { TurnWindow } from "./WorkBoardSession";

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
// The check row reads the newest turn through the work card's builder, which batches store reads into a frame.
Object.assign(window, {
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
});

let rows: RpcJobRow[] = [];
/** What `get_git_unlanded` answers: null on main itself, as by default. */
let unlanded: unknown = null;
/** The turn "Changed" counts: the board passes the running or last finished turn. */
let turn: TurnWindow | null = null;
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { rows } }));
const getGitUnlanded = vi.fn(async () => ({ success: true, data: unlanded }));
/** What main answers for `agent_control_family_edits` (the sessions the board's session opened). */
let family: FamilyEdits = { members: [] };
const command = vi.fn(async (sent: { type: string; since?: number }) =>
	sent.type === "agent_control_family_edits"
		? { type: "response", command: sent.type, success: true, data: family }
		: { type: "response", command: sent.type, success: false, error: "unknown" },
);
Reflect.set(window, "omp", {
	rpc: { getJobs, getGitUnlanded, command },
	prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { FailedCheckWatch, NeedsCheck, SessionSlot, quietOutcome } = await import("./WorkBoardSession");
const { peerOpen } = await import("./session-board");
const { REVEAL_STEP_EVENT } = await import("../../chat/work/reveal-step");
/** What the quiet head would say (the slot tells the board). */
const outcome = vi.fn();

/** The board's own parts: a failed check is a row of Needs you, the rest is Current work. */
function Host() {
	return (
		<>
			<ul data-needs="">
				<NeedsCheck tag={{ word: "Check", tone: "danger" }} />
			</ul>
			<SessionSlot onOutcome={outcome} turn={turn} />
			<FailedCheckWatch />
		</>
	);
}

let container: HTMLElement;
let root: Root;

async function mount(extraTabs: SessionTab[] = [], parent: Partial<SessionTab> = {}): Promise<void> {
	useTabsStore.setState({
		tabs: [
			{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false, ...parent },
			{ id: "t2", cwd: "/w", status: "ready", kind: "agent", unreadDone: false },
			...extraTabs,
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

const reviewItem = (tabId: string, title: string): AgentReviewItem => ({
	tabId,
	title,
	state: "needs-review",
	commitsAhead: 0,
	files: 0,
	added: 0,
	removed: 0,
	uncommitted: 0,
	answer: "",
});

beforeEach(() => {
	getGitUnlanded.mockClear();
	command.mockClear();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.replaceChildren();
	rows = [];
	unlanded = null;
	family = { members: [] };
	useAgentReviewStore.getState().reset();
	useClosedChildrenStore.getState().reset();
	turn = null;
	useMessagesStore.getState().reset();
	useWorkBoardStore.getState().reset();
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ panelVisible: false });
});

function edit(path: string, diff: string, startTime: number): ToolEntry {
	return {
		toolName: "edit",
		args: { path },
		status: "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text: "ok" }], details: { diff } },
		isError: false,
		startTime,
		endTime: startTime + 100,
	};
}

describe("Changed row", () => {
	it("counts the files the turn's own edit tools changed, with their lines, and opens Changes", async () => {
		turn = { start: 10_000, end: null };
		finished(
			// The previous turn's edit is not this turn's.
			["e0", edit("src/old.ts", "+1 old", 2000)],
			["e1", edit("src/a.ts", "+1 one\n+2 two\n-3 three", 11_000)],
			["e2", edit("src/b.ts", "+1 b", 12_000)],
		);
		await mount();
		expect(row("changes")?.textContent).toContain("2 files changed");
		expect(row("changes")?.textContent).toContain("+3");
		expect(row("changes")?.textContent).toContain("−1");
		await press(row("changes"));
		expect(useUiStore.getState().panelTab).toBe("diff");
	});

	it("never counts what git sees in the checkout: other sessions' commits and edits stay out", async () => {
		// The user's report: a session in a checkout others push to read 1000 files, +149005 −42996 of everyone's work.
		// The row reads the turn's own tools; git only answers the separate "not in main yet" row of a branch.
		turn = { start: 10_000, end: 20_000 };
		finished(["e1", edit("src/mine.ts", "+1 mine", 11_000)]);
		unlanded = null;
		await mount();
		expect(row("changes")?.textContent).toContain("1 file changed");
		expect(row("unlanded")).toBeNull();
	});

	it("draws no line while the turn changed nothing, finished or running", async () => {
		turn = { start: 10_000, end: 20_000 };
		await mount();
		expect(row("changes")).toBeNull();
		expect(section("current")).toBeNull();
		await act(async () => root.unmount());
		turn = { start: 10_000, end: null };
		await mount();
		expect(row("changes")).toBeNull();
		expect(section("current")).toBeNull();
	});

	it("shows what the session's branch has not landed in main yet, under Current work", async () => {
		unlanded = {
			branch: "omp/agent/sidebar",
			target: "main",
			truncated: false,
			files: [
				{ path: "a.ts", status: "M", added: 3, removed: 1 },
				{ path: "b.ts", status: "A", added: 2, removed: 1 },
				{ path: "new.txt", status: "??" },
			],
		};
		await mount();
		expect(row("unlanded")?.textContent).toContain("Not in main yet · 3 files");
		expect(row("unlanded")?.textContent).toContain("+5");
		expect(row("unlanded")?.getAttribute("title")).toBe(
			"omp/agent/sidebar: commits and uncommitted work not in main yet",
		);
		expect(section("current")?.querySelector(".omp-work-board-title")?.textContent).toBe("Current work");
	});

	it("reads a capped list as at least that many, never as an exact count", async () => {
		unlanded = {
			branch: "omp/agent/big",
			target: "main",
			truncated: true,
			files: Array.from({ length: 1000 }, (_, index) => ({
				path: `f${index}.ts`,
				status: "M",
				added: 1,
				removed: 0,
			})),
		};
		await mount();
		expect(row("unlanded")?.textContent).toContain("1000+ files");
		// Lines of a cut list would read as exact too: left out.
		expect(row("unlanded")?.textContent).not.toContain("+1000");
	});

	/** A call of the tab's run finishing, as the tools store records one. */
	function finishCall(key: string, toolName: string) {
		useToolsStore.setState(state => ({
			finishedTools: new Map([...state.finishedTools, [key, bash("", { toolName })]]),
			finishedVersion: state.finishedVersion + 1,
		}));
	}

	it("never counts a call that finished before the board mounted as a new one", async () => {
		vi.useFakeTimers();
		try {
			finishCall("old-edit", "edit");
			await mount();
			await act(async () => {
				useTodoStore.getState().setTurnActive(true, Date.now());
			});
			await act(async () => finishCall("r1", "read"));
			// A hydration brings older edits in as history.
			await act(async () =>
				useToolsStore.setState(state => ({
					finishedTools: new Map([...state.finishedTools, ["older-bash", bash("git commit")]]),
					finishedVersion: state.finishedVersion + 1,
					hydrationVersion: state.hydrationVersion + 1,
				})),
			);
			await act(async () => {
				vi.advanceTimersByTime(10_000);
			});
			expect(getGitUnlanded).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads on mount, when a turn settles, and while it runs only after a call that can touch the checkout finishes, at most every 5 s", async () => {
		vi.useFakeTimers();
		try {
			await mount();
			expect(getGitUnlanded).toHaveBeenCalledTimes(1);
			await act(async () => {
				useTodoStore.getState().setTurnActive(true, Date.now());
			});
			// A running turn that finishes no call reads nothing: no timer of its own.
			await act(async () => {
				vi.advanceTimersByTime(60_000);
			});
			expect(getGitUnlanded).toHaveBeenCalledTimes(1);
			// Calls that only read the code never read the branch again, however many finish.
			await act(async () => finishCall("r1", "read"));
			await act(async () => finishCall("r2", "grep"));
			await act(async () => {
				vi.advanceTimersByTime(10_000);
			});
			expect(getGitUnlanded).toHaveBeenCalledTimes(1);
			// An lsp call can rename or move files: it reads the branch again.
			await act(async () => finishCall("l1", "lsp"));
			await act(async () => {
				vi.advanceTimersByTime(5_000);
			});
			expect(getGitUnlanded).toHaveBeenCalledTimes(2);
			// A commit mid-turn: the calls that finish read the branch once, 5 s on.
			await act(async () => finishCall("b1", "bash"));
			await act(async () => {
				vi.advanceTimersByTime(1_000);
				finishCall("e1", "edit");
			});
			expect(getGitUnlanded).toHaveBeenCalledTimes(2);
			await act(async () => {
				vi.advanceTimersByTime(4_000);
			});
			expect(getGitUnlanded).toHaveBeenCalledTimes(3);
			await act(async () => {
				useTodoStore.getState().setTurnActive(false);
			});
			expect(getGitUnlanded).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Changed row over the sessions this one opened", () => {
	/** A member's newest turn as main reads it (`get_turn_edits`): its edit calls and their results, in its folder. */
	function turnOf(cwd: string, endedAt: number, edits: Array<[path: string, diff: string]>): RpcTurnEdits {
		const messages: AgentMessage[] = [];
		edits.forEach(([path, diff], index) => {
			const id = `${cwd}-${index}`;
			messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id, name: "edit", arguments: { path } }],
				timestamp: endedAt - 1000 + index,
			});
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName: "edit",
				content: [{ type: "text", text: "ok" }],
				details: { diff },
				timestamp: endedAt - 900 + index,
			});
		});
		return { cwd, startedAt: endedAt - 2000, endedAt, messages };
	}

	// Works in the parent's own checkout and still runs: a file the parent also edited counts once.
	const login: FamilyMemberEdits = {
		key: "/s/c1.jsonl",
		title: "Login form",
		live: true,
		edits: turnOf("/w", 12_000, [
			["src/a.ts", "+1 a"],
			["src/c.ts", "+1 c\n+2 c"],
		]),
		unlanded: null,
	};
	// Finished in its own worktree: what its branch has not landed counts, not its last turn alone.
	const settings: FamilyMemberEdits = {
		key: "/s/c2.jsonl",
		title: "Settings page",
		live: false,
		edits: turnOf("/wt/c2", 15_000, [["x.ts", "+1 x"]]),
		unlanded: {
			branch: "omp/agent/settings",
			target: "main",
			truncated: false,
			files: [
				{ path: "x.ts", status: "M", added: 4, removed: 1 },
				{ path: "y.ts", status: "A", added: 1, removed: 0 },
			],
		},
	};
	const children: SessionTab[] = [
		{ id: "c1", cwd: "/w", status: "running", kind: "agent", unreadDone: false, openedBy: "t1", task: "Login form" },
		{
			id: "c2",
			cwd: "/wt/c2",
			status: "ready",
			kind: "agent",
			unreadDone: false,
			openedBy: "t1",
			task: "Settings page",
			worktree: { name: "settings", path: "/wt/c2", baseCwd: "/w", branch: "omp/agent/settings" },
			lastRun: { stopReason: "stop" },
		},
	];

	beforeEach(() => {
		command.mockClear();
		family = { members: [login, settings] };
		useSessionStore.setState({ cwd: "/w" });
	});

	it("counts the family's files once each, with their lines, and names each session's share", async () => {
		turn = { start: 10_000, end: 20_000 };
		finished(["e1", edit("src/a.ts", "+1 mine", 11_000)]);
		await mount(children);
		await act(async () => {});
		// Own a.ts; Login form's a.ts (the same file) and c.ts; Settings page's unlanded x.ts and y.ts.
		expect(row("changes")?.textContent).toContain("4 files changed");
		expect(row("changes")?.textContent).toContain("+9");
		expect(row("changes")?.textContent).toContain("−1");
		const title = row("changes")?.getAttribute("title") ?? "";
		expect(title).toContain("This session: 1 file changed +1 −0");
		expect(title).toContain("Login form: 2 files changed +3 −0");
		expect(title).toContain("Settings page: 2 files changed +5 −1");
		// Main is asked for the family of this turn, closed children since its start included.
		expect(command.mock.calls.map(([sent]) => sent)).toContainEqual({
			type: "agent_control_family_edits",
			since: 10_000,
		});
	});

	it("shows a parent that changed nothing itself by its children's work", async () => {
		// The user's report: an orchestrator whose four children edit many files read "No files changed".
		turn = { start: 10_000, end: 11_000 };
		await mount(children);
		await act(async () => {});
		expect(row("changes")?.textContent).toContain("4 files changed");
		expect(row("changes")?.textContent).toContain("+8");
	});

	it("leaves out a child that finished before this turn began", async () => {
		turn = { start: 30_000, end: null };
		await mount(children);
		await act(async () => {});
		// Settings page finished at 15 s; Login form still runs, so its turn counts.
		expect(row("changes")?.textContent).toContain("2 files changed");
		expect(row("changes")?.getAttribute("title")).not.toContain("Settings page");
	});

	it("counts the children in a window that holds no tab of them (a phone viewing the opener)", async () => {
		// The viewer knows the children only from main's review list; main reads their work, wherever they run.
		turn = { start: 10_000, end: 20_000 };
		await mount();
		await act(async () => {
			useAgentReviewStore.getState().apply({
				tabId: "t1",
				items: [{ ...reviewItem("c1", "Login form"), state: "running" }, reviewItem("c2", "Settings page")],
			});
		});
		await act(async () => {});
		expect(row("changes")?.textContent).toContain("4 files changed");
	});

	it("counts a child closed after its work landed during this turn", async () => {
		// Main closes a child whose work landed: it leaves the tab list, its share stays in the turn's count.
		turn = { start: 10_000, end: 20_000 };
		family = {
			members: [
				{
					key: "/s/c3.jsonl",
					title: "Sidebar folds",
					live: false,
					edits: turnOf("/w", 14_000, [["src/folds.ts", "+1 f\n-2 g"]]),
					unlanded: null,
				},
			],
		};
		await mount([], { sessionPath: "/s/t1.jsonl" });
		await act(async () => {
			useClosedChildrenStore.setState({
				rows: [
					{
						path: "/s/c3.jsonl",
						openedBySession: "/s/t1.jsonl",
						title: "Sidebar folds",
						cwd: "/w",
						closedAt: 15_000,
					},
				],
			});
		});
		await act(async () => {});
		expect(row("changes")?.textContent).toContain("1 file changed");
		expect(row("changes")?.getAttribute("title")).toContain("Sidebar folds: 1 file changed +1 −1");
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
		expect(section("current")).not.toBeNull();
		expect(container.querySelector('[data-needs] [data-board-session="check"]')).toBeNull();
	});

	it("is absent when the session ran no check", async () => {
		finished(["b1", bash("ls -la")]);
		await mount();
		expect(row("check")).toBeNull();
		expect(section("current")).toBeNull();
	});

	it("a failed newest check is a row of Needs you, not of Current work, and its tap asks the transcript for the call", async () => {
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
		const failed = container.querySelector('[data-needs] [data-board-session="check"]');
		expect(failed?.getAttribute("data-state")).toBe("failed");
		expect(failed?.textContent).toContain("2 tests failed");
		// It says what kind it is, in the word Needs you gives its rows.
		expect(failed?.textContent).toMatch(/^Check/);
		expect(container.querySelectorAll('[data-board-section="current"] [data-board-session="check"]')).toHaveLength(0);
		// The head, the strip, the title bar and the sidebar hear it too (FailedCheckWatch writes the attention store).
		expect(Object.hasOwn(useAttentionStore.getState().checkFailed, "t1")).toBe(true);
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
		expect(container.querySelector('[data-needs] [data-board-session="check"]')).toBeNull();
		expect(row("check")?.getAttribute("data-state")).toBe("passed");
		expect(Object.hasOwn(useAttentionStore.getState().checkFailed, "t1")).toBe(false);
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

	it("names both scopes and lists a peer of each, the other worktree's marked as such", async () => {
		useSessionStore.setState({
			checkoutPeers: checkout([peer()], [peer({ id: "t9", title: "Release notes", worktree: "/wt/notes" })]),
		});
		await mount();
		expect(row("peers")?.textContent).toContain("1 session in this checkout, 1 in this repository");
		await press(row("peers"));
		const items = [...container.querySelectorAll('[data-board-session="peer"]')];
		expect(items.map(item => [item.getAttribute("data-peer-scope"), item.textContent])).toEqual([
			["worktree", "Settings test race"],
			["repo", "Release notes · other worktree"],
		]);
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
		expect(section("current")).toBeNull();
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

describe("Current work section", () => {
	it("lists Changed, Not in main yet, Last check, Dev servers, Same checkout and Memory in that order", async () => {
		turn = { start: 500, end: null };
		unlanded = { branch: "omp/agent/x", target: "main", truncated: false, files: [{ path: "a.ts", status: "M" }] };
		finished(["e1", edit("src/a.ts", "+1 a", 600)], ["b1", bash("bun run build")]);
		rows = [serverJob("bun run dev", "Local: http://localhost:3000/")];
		useSessionStore.setState({ checkoutPeers: checkout([peer()]) });
		useMessagesStore.setState({ messages: [user, recall("Use bun")] });
		await mount();
		expect(rowKinds()).toEqual(["changes", "unlanded", "check", "dev-server", "peers", "recall"]);
		expect(section("current")?.querySelector(".omp-work-board-title")?.textContent).toBe("Current work");
	});
});

describe("What a quiet board's head says", () => {
	const t = (key: string, params?: Record<string, string | number>) => translate(key, params);

	it("names the files the last turn changed with their lines, before a passing check or an unlanded branch", async () => {
		turn = { start: 500, end: null };
		unlanded = { branch: "omp/agent/x", target: "main", truncated: false, files: [{ path: "a.ts", status: "M" }] };
		finished(["e1", edit("src/a.ts", "+1 a", 600)], ["b1", bash("bun run build")]);
		await mount();
		expect(outcome).toHaveBeenLastCalledWith("1 file changed +1 −0");
	});

	it("falls back to the passing check, then to what the branch has not landed, then to nothing", () => {
		const passed = {
			kind: "check" as const,
			check: {
				kind: "test" as const,
				state: "passed" as const,
				count: 128,
				command: "bun test",
				key: "b1",
				startedAt: 0,
			},
		};
		const unlandedRow = {
			kind: "unlanded" as const,
			branch: "omp/agent/x",
			target: "main",
			files: 3,
			added: 1,
			removed: 0,
			capped: false,
		};
		expect(quietOutcome(t, [passed, unlandedRow])).toBe("128 tests passed");
		expect(quietOutcome(t, [unlandedRow])).toBe("Not in main yet · 3 files");
		expect(quietOutcome(t, [{ kind: "recall", titles: ["x"] }])).toBeNull();
		expect(quietOutcome(t, [])).toBeNull();
	});

	it("says nothing for a check that has not passed", () => {
		const running = {
			kind: "check" as const,
			check: { kind: "test" as const, state: "running" as const, command: "bun test", key: "b1", startedAt: 0 },
		};
		expect(quietOutcome(t, [running])).toBeNull();
	});
});
