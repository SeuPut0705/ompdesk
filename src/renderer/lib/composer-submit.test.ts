/**
 * Contract tests for composer submission policy (lib/composer-submit):
 * typed slash commands always route through the prompt RPC (the server
 * parses them even mid-stream; steer/followUp would inject the text as a
 * user steer), session-replacing commands (/new, /clear) are blocked while
 * a turn runs instead of silently killing it, and local-only resolutions
 * (agentInvoked:false, no agent events) trigger a rehydrate so the
 * transcript/context bar reflect the mutation.
 */

import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AvailableCommand, RpcResponse } from "../../shared/rpc-types";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { useToastStore } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { routeCommands } from "../test-support/route-commands";
import { withGuiCommands } from "./command-registry";
import { planComposerSubmit, settleComposerResponse } from "./composer-submit";
import { translate } from "./i18n";

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

interface MockOmp {
	rpc: {
		prompt: Mock<(message: string, images?: unknown[], streamingBehavior?: string) => Promise<RpcResponse>>;
		compact: Mock<() => Promise<RpcResponse>>;
		steer: Mock<(message: string, images?: unknown[]) => Promise<RpcResponse>>;
		followUp: Mock<(message: string, images?: unknown[]) => Promise<RpcResponse>>;
		guidedGoal: Mock<(initial?: string) => Promise<RpcResponse>>;
		mcpReauth: Mock<(name: string) => Promise<RpcResponse>>;
		mcpReload: Mock<() => Promise<RpcResponse>>;
		mcpAction: Mock<(name: string, action: string) => Promise<RpcResponse>>;
		setAgentsPaused: Mock<(enabled: boolean) => Promise<RpcResponse>>;
		setPlanMode: Mock<(enabled: boolean) => Promise<RpcResponse>>;
		tan: Mock<(work: string) => Promise<RpcResponse>>;
		omfg: Mock<(complaint: string) => Promise<RpcResponse>>;
		getState: Mock<() => Promise<RpcResponse>>;
		getTranscriptPage: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
		getLastLink: Mock<() => Promise<RpcResponse>>;
	};
	app: { quit: Mock<() => void> };
	sessions: { consumePendingOpen: Mock<() => Promise<unknown>> };
	system: { openExternal: Mock<(url: string) => Promise<void>> };
	terminal: { request: Mock<(tabId: string, operation: { action: string; data?: string }) => Promise<unknown>> };
}

function installMockOmp(): MockOmp {
	const omp: MockOmp = {
		rpc: routeCommands({
			prompt: vi.fn(async () => success({})),
			compact: vi.fn(async () => ({ ...success({}), command: "compact" })),
			steer: vi.fn(async () => success({})),
			followUp: vi.fn(async () => success({})),
			guidedGoal: vi.fn(async () => success({ started: true })),
			setAgentsPaused: vi.fn(async enabled => success({ paused: enabled, pausedAt: enabled ? 123 : undefined })),
			setPlanMode: vi.fn(async enabled => success({ enabled })),
			tan: vi.fn(async () => success({ jobId: "job-1" })),
			omfg: vi.fn(async () => success({ state: "saved", savedPath: "/tmp/rule.md" })),
			mcpReauth: vi.fn(async () => success({ ok: true })),
			mcpReload: vi.fn(async () => success({ servers: [] })),
			mcpAction: vi.fn(async () => success({})),
			getState: vi.fn(async () =>
				success({
					sessionId: "s1",
					sessionName: null,
					sessionFile: null,
					cwd: "/tmp",
					isStreaming: false,
					isCompacting: false,
					contextUsage: null,
					messageCount: 0,
					queuedMessageCount: 0,
					planModeEnabled: false,
					todoPhases: [],
				}),
			),
			getTranscriptPage: vi.fn(async () => success({ messages: [], totalMessages: 0 })),
			getSubagents: vi.fn(async () => success({ subagents: [] })),
			setSubagentSubscription: vi.fn(async () => success({})),
			getLastLink: vi.fn(async () => success({ href: "https://example.com/report" })),
		}),
		sessions: { consumePendingOpen: vi.fn(async () => null) },
		app: { quit: vi.fn() },
		system: { openExternal: vi.fn(async () => {}) },
		terminal: {
			request: vi.fn(async (_tabId, operation) =>
				operation.action === "write" ? [] : [{ id: "term-1", exited: false }],
			),
		},
	};
	(globalThis as Record<string, unknown>).window = { omp, confirm: vi.fn(() => true), close: vi.fn() };
	return omp;
}

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).window;
	useToastStore.setState({ toasts: [] });
	useUiStore.setState({
		destination: "session",
		copySelectorOpen: false,
		btwRequest: null,
		shareSessionOpen: false,
		liveOpen: false,
	});
	useSessionStore.setState({ agentsPaused: false, agentsPausedAt: null });
});

const guiOnly = (name: string): AvailableCommand => ({
	name,
	description: name,
	source: "builtin",
	textModeExecutable: false,
});
describe("planComposerSubmit", () => {
	it("typed share still requires a desktop preview when Core can upload directly or discovery is pending", () => {
		const omp = installMockOmp();
		for (const commands of [[{ ...guiOnly("share"), textModeExecutable: true }], []]) {
			useUiStore.setState({ shareSessionOpen: false });
			const submit = planComposerSubmit({
				message: "/share",
				images: [],
				isStreaming: false,
				mode: "prompt",
				commands,
			});
			expect(submit.kind).toBe("handled");
			expect(useUiStore.getState().shareSessionOpen).toBe(true);
		}
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("text-capable voice and side-question commands open their explicit start surfaces", () => {
		const omp = installMockOmp();
		planComposerSubmit({
			message: "/live",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [{ ...guiOnly("live"), textModeExecutable: true }],
		});
		expect(useUiStore.getState().liveOpen).toBe(true);
		planComposerSubmit({
			message: "/btw local question",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [{ ...guiOnly("btw"), textModeExecutable: true }],
		});
		expect(useUiStore.getState().btwRequest).toBe("local question");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("routes typed /compact through its long-running RPC instead of the 8s prompt path", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/compact",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [],
		});
		expect(submit.kind).toBe("send");
		if (submit.kind !== "send") return;
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		await submit.request();
		expect(omp.rpc.compact).toHaveBeenCalledOnce();
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("routes /compact through its dedicated RPC even while streaming — never steer/followUp", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/compact",
			images: [],
			isStreaming: true,
			mode: "steer",
			commands: [],
		});
		expect(submit.kind).toBe("send");
		if (submit.kind !== "send") return;
		await submit.request();
		expect(omp.rpc.compact).toHaveBeenCalledOnce();
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		expect(omp.rpc.steer).not.toHaveBeenCalled();
		expect(omp.rpc.followUp).not.toHaveBeenCalled();
	});

	it("routes plain text through steer (or followUp) while streaming", async () => {
		const omp = installMockOmp();
		const steerSubmit = planComposerSubmit({
			message: "hello",
			images: [],
			isStreaming: true,
			mode: "steer",
			commands: [],
		});
		if (steerSubmit.kind !== "send") throw new Error("expected send");
		await steerSubmit.request();
		expect(omp.rpc.steer).toHaveBeenCalledWith("hello", []);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();

		const followUpSubmit = planComposerSubmit({
			message: "again",
			images: [],
			isStreaming: true,
			mode: "followUp",
			commands: [],
		});
		if (followUpSubmit.kind !== "send") throw new Error("expected send");
		await followUpSubmit.request();
		expect(omp.rpc.followUp).toHaveBeenCalledWith("again", []);
	});

	describe("when the host decides (a shared tab, or a page on a phone)", () => {
		it("sends a plain message as one prompt that says how to join a run, whatever this window thinks is running", async () => {
			const omp = installMockOmp();
			for (const isStreaming of [true, false]) {
				const submit = planComposerSubmit({
					message: "hello",
					images: [],
					isStreaming,
					mode: "steer",
					commands: [],
					hostDecides: true,
				});
				if (submit.kind !== "send") throw new Error("expected send");
				await submit.request();
			}
			expect(omp.rpc.prompt).toHaveBeenNthCalledWith(1, "hello", [], "steer");
			expect(omp.rpc.prompt).toHaveBeenNthCalledWith(2, "hello", [], "steer");
			expect(omp.rpc.steer).not.toHaveBeenCalled();
			expect(omp.rpc.followUp).not.toHaveBeenCalled();
		});

		it("asks for a follow-up when the follow-up mode is chosen", async () => {
			const omp = installMockOmp();
			const submit = planComposerSubmit({
				message: "later",
				images: [],
				isStreaming: true,
				mode: "followUp",
				commands: [],
				hostDecides: true,
			});
			if (submit.kind !== "send") throw new Error("expected send");
			await submit.request();
			expect(omp.rpc.prompt).toHaveBeenCalledWith("later", [], "followUp");
		});

		it("runs the pre-prompt work only when this window sees an idle agent", async () => {
			installMockOmp();
			const beforePrompt = vi.fn(async () => undefined);
			for (const isStreaming of [true, false]) {
				const submit = planComposerSubmit({
					message: "hello",
					images: [],
					isStreaming,
					mode: "steer",
					commands: [],
					hostDecides: true,
					beforePrompt,
				});
				if (submit.kind !== "send") throw new Error("expected send");
				await submit.request();
			}
			expect(beforePrompt).toHaveBeenCalledTimes(1);
		});

		it("leaves a slash command on its own path", async () => {
			const omp = installMockOmp();
			const submit = planComposerSubmit({
				message: "/compact",
				images: [],
				isStreaming: true,
				mode: "steer",
				commands: [],
				hostDecides: true,
			});
			if (submit.kind !== "send") throw new Error("expected send");
			await submit.request();
			expect(omp.rpc.compact).toHaveBeenCalledOnce();
			expect(omp.rpc.prompt).not.toHaveBeenCalled();
		});
	});

	it("routes exact /clear to the native clear path when idle — never to the model", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/clear",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [],
		});
		expect(submit.kind).toBe("clear");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("still routes /clear with args through prompt (no native interception)", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/clear extra",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [],
		});
		expect(submit.kind).toBe("send");
		if (submit.kind !== "send") return;
		await submit.request();
		expect(omp.rpc.prompt).toHaveBeenCalledWith("/clear extra", []);
	});

	it.each(["/new", "/clear", "/new extra args"])(
		"blocks %s while a turn is running instead of silently killing it",
		async message => {
			const omp = installMockOmp();
			const submit = planComposerSubmit({ message, images: [], isStreaming: true, mode: "prompt", commands: [] });
			expect(submit.kind).toBe("blocked");
			expect(omp.rpc.prompt).not.toHaveBeenCalled();
			expect(omp.rpc.steer).not.toHaveBeenCalled();
			expect(useToastStore.getState().toasts.some(toast => toast.variant === "warning")).toBe(true);
		},
	);

	it("allows /new when idle", () => {
		installMockOmp();
		const submit = planComposerSubmit({
			message: "/new",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [],
		});
		expect(submit.kind).toBe("send");
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});
});

describe("planComposerSubmit GUI-only routing", () => {
	it("routes typed TUI-only commands through a matching native GUI affordance", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/settings",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("settings")],
		});
		expect(submit.kind).toBe("handled");
		expect(useUiStore.getState().destination).toBe("settings");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("maps typed /exit to a real app quit, not closing the focused window", () => {
		const omp = installMockOmp();
		const close = vi.fn();
		((globalThis as Record<string, unknown>).window as Record<string, unknown>).close = close;
		const submit = planComposerSubmit({
			message: "/exit",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("exit")],
		});

		// window.close() leaves every other window and its running agents alive
		// while reporting the app as quit; the guard-owned quit is the only one
		// that tears the session down (and confirms first).
		expect(submit.kind).toBe("handled");
		expect(omp.app.quit).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled();
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("passes typed /guided-goal arguments to the native guided interview RPC", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/guided-goal ship reliable sync",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("guided-goal")],
		});

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.guidedGoal).toHaveBeenCalledWith("ship reliable sync");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("toggles the process-wide pause gate from typed /pause", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/pause",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("pause")],
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.setAgentsPaused).toHaveBeenCalledWith(true);
		expect(useSessionStore.getState().agentsPaused).toBe(true);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("serves /plan natively even though stock omp does not advertise it", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/plan",
			images: [],
			isStreaming: false,
			mode: "prompt",
			// Stock lists its own builtins but not /plan; the composer merges GUI commands in.
			commands: withGuiCommands([{ name: "compact", source: "builtin", description: "compact" }]),
		});
		await Promise.resolve();

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.setPlanMode).toHaveBeenCalledWith(true);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("still sends an unknown slash command to the agent", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/definitely-not-a-command hi",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: withGuiCommands([{ name: "compact", source: "builtin", description: "compact" }]),
		});
		expect(submit.kind).toBe("send");
		expect(omp.rpc.setPlanMode).not.toHaveBeenCalled();
	});

	it("opens the native copy selector for typed /copy", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/copy",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("copy")],
		});

		expect(submit.kind).toBe("handled");
		expect(useUiStore.getState().copySelectorOpen).toBe(true);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("opens the native ephemeral side-question flow for typed /btw", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/btw why did this fail?",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("btw")],
		});

		expect(submit.kind).toBe("handled");
		expect(useUiStore.getState().btwRequest).toBe("why did this fail?");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it.each(["/tan investigate the flaky test", "/tan:investigate the flaky test"])(
		"dispatches %s through the background-agent RPC",
		async message => {
			const omp = installMockOmp();
			const submit = planComposerSubmit({
				message,
				images: [],
				isStreaming: false,
				mode: "prompt",
				commands: [guiOnly("tan")],
			});
			await Promise.resolve();
			await Promise.resolve();

			expect(submit.kind).toBe("handled");
			expect(omp.rpc.tan).toHaveBeenCalledWith("investigate the flaky test");
			expect(omp.rpc.prompt).not.toHaveBeenCalled();
		},
	);

	it("runs typed /omfg through the RPC-hosted confirmation workflow", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/omfg stop repeating stale advice",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("omfg")],
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.omfg).toHaveBeenCalledWith("stop repeating stale advice");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("routes typed /drop to the GUI delete, which refuses while the focused tab runs a turn", async () => {
		const omp = installMockOmp();
		useTabsStore.setState({
			tabs: [
				{ id: "t1", cwd: "/a", status: "running", kind: "agent", unreadDone: false, sessionPath: "/s/a.jsonl" },
			],
			activeTabId: "t1",
		});
		try {
			const submit = planComposerSubmit({
				message: "/drop",
				images: [],
				isStreaming: false,
				mode: "prompt",
				commands: [guiOnly("drop")],
			});
			await Promise.resolve();

			expect(submit.kind).toBe("handled");
			// Closing a running tab would kill its turn: nothing is asked, closed or deleted.
			expect(window.confirm).not.toHaveBeenCalled();
			expect(useToastStore.getState().toasts.at(-1)?.message).toBe(translate("sidebar.menu.taskRunning"));
			expect(omp.rpc.prompt).not.toHaveBeenCalled();
		} finally {
			useTabsStore.setState({ tabs: [], activeTabId: null });
		}
	});

	it("blocks an advertised non-text command until it has a native GUI affordance", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/future-native",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("future-native")],
		});
		expect(submit.kind).toBe("blocked");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "warning")).toBe(true);
	});

	it.each([
		["/collab start", "terminal app"],
		["/join https://relay.example/s/abc", "terminal app"],
		["/leave", "terminal app"],
		["/record", "terminal"],
	])("keeps %s away from the model and says where it runs", (message, hint) => {
		const omp = installMockOmp();
		// Stock lists none of them: they only have a TUI handler.
		const submit = planComposerSubmit({
			message,
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: withGuiCommands([]),
		});
		expect(submit.kind).toBe("blocked");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		const warning = useToastStore.getState().toasts.find(toast => toast.variant === "warning");
		expect(warning?.message).toContain(hint);
	});

	it("runs /cleanse as stock's omp cleanse in the tab's terminal, request and flags as typed", async () => {
		const omp = installMockOmp();
		useTabsStore.setState({
			activeTabId: "t1",
			tabs: [{ id: "t1", cwd: "/repo", status: "ready", kind: "agent", unreadDone: false }],
		});
		const submit = planComposerSubmit({
			message: '/cleanse "ts errors" -n 4',
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: withGuiCommands([]),
		});
		expect(submit.kind).toBe("handled");
		await vi.waitFor(() =>
			expect(omp.terminal.request).toHaveBeenCalledWith("t1", {
				action: "write",
				id: "term-1",
				data: 'omp cleanse "ts errors" -n 4\r',
			}),
		);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		expect(useUiStore.getState().panelTab).toBe("terminal");
		useTabsStore.getState().reset();
	});

	it("opens the conversation's newest link for typed /open, like stock's TUI command", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/open",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: withGuiCommands([]),
		});
		expect(submit.kind).toBe("handled");
		await vi.waitFor(() => expect(omp.system.openExternal).toHaveBeenCalledWith("https://example.com/report"));
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts.at(-1)?.message).toContain("https://example.com/report");
	});

	it("says there is no link for /open when the conversation has none, and rejects other arguments", async () => {
		const omp = installMockOmp();
		omp.rpc.getLastLink.mockResolvedValueOnce(success({ href: null }));
		planComposerSubmit({
			message: "/open",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: withGuiCommands([]),
		});
		await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
		expect(useToastStore.getState().toasts[0]?.message).toBe("No link to open.");
		planComposerSubmit({
			message: "/open docs",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: withGuiCommands([]),
		});
		await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(2));
		expect(omp.system.openExternal).not.toHaveBeenCalled();
		expect(omp.rpc.getLastLink).toHaveBeenCalledTimes(1);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});
});

describe("planComposerSubmit typed /mcp", () => {
	const submitTyped = (message: string) =>
		planComposerSubmit({ message, images: [], isStreaming: false, mode: "prompt", commands: [] });
	const toastMessages = () => useToastStore.getState().toasts.map(toast => toast.message);

	it("signs in through the bridge for /mcp reauth <name> instead of sending prompt text", async () => {
		const omp = installMockOmp();
		expect(submitTyped("/mcp reauth foo").kind).toBe("handled");
		expect(omp.rpc.mcpReauth).toHaveBeenCalledExactlyOnceWith("foo");
		await vi.waitFor(() => expect(toastMessages()).toContain(translate("mcp.reauth.ok", { name: "foo" })));
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("says a sign-in the person closed was cancelled, and one already running was busy", async () => {
		const omp = installMockOmp();
		omp.rpc.mcpReauth.mockResolvedValueOnce(success({ ok: false, error: "cancelled" }));
		submitTyped("/mcp reauth foo");
		await vi.waitFor(() => expect(toastMessages()).toContain(translate("mcp.reauth.cancelled")));
		omp.rpc.mcpReauth.mockResolvedValueOnce({
			type: "response",
			command: "mcp_reauth",
			success: false,
			error: "busy",
			code: "oauth_busy",
		});
		submitTyped("/mcp reauth bar");
		await vi.waitFor(() => expect(toastMessages()).toContain(translate("mcp.reauth.busy")));
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("opens the MCP tab for a bare /mcp reauth", () => {
		const omp = installMockOmp();
		expect(submitTyped("/mcp reauth").kind).toBe("handled");
		expect(useUiStore.getState().destination).toBe("settings");
		expect(useUiStore.getState().settingsTab).toBe("tools:mcp");
		expect(omp.rpc.mcpReauth).not.toHaveBeenCalled();
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("reloads every MCP server through the bridge for /mcp reload", async () => {
		const omp = installMockOmp();
		expect(submitTyped("/mcp reload").kind).toBe("handled");
		expect(omp.rpc.mcpReload).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(toastMessages()).toContain(translate("mcpAction.reload")));
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("runs the other GUI verbs with their arguments", () => {
		const omp = installMockOmp();
		expect(submitTyped("/mcp enable foo").kind).toBe("handled");
		expect(omp.rpc.mcpAction).toHaveBeenCalledExactlyOnceWith("foo", "enable");
		expect(submitTyped("/mcp add").kind).toBe("handled");
		expect(useUiStore.getState().settingsTab).toBe("tools:mcp");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("still sends /mcp list and verbs with no GUI affordance to stock as text", async () => {
		const omp = installMockOmp();
		for (const message of ["/mcp list", "/mcp unauth foo", "/mcp"]) {
			const submit = submitTyped(message);
			expect(submit.kind).toBe("send");
			if (submit.kind !== "send") continue;
			await submit.request();
			expect(omp.rpc.prompt).toHaveBeenLastCalledWith(message, []);
		}
		expect(omp.rpc.mcpReauth).not.toHaveBeenCalled();
		expect(omp.rpc.mcpReload).not.toHaveBeenCalled();
	});
});

describe("settleComposerResponse", () => {
	it("rehydrates on agentInvoked:false (local-only slash command)", async () => {
		const omp = installMockOmp();
		await settleComposerResponse(success({ agentInvoked: false }));
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.rpc.getTranscriptPage).toHaveBeenCalled();
	});

	it("rehydrates after dedicated compaction completes", async () => {
		const omp = installMockOmp();
		await settleComposerResponse({ ...success({}), command: "compact" });
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.rpc.getTranscriptPage).toHaveBeenCalled();
	});

	it("does not rehydrate when the agent was invoked (events stream normally)", async () => {
		const omp = installMockOmp();
		await settleComposerResponse(success({ agentInvoked: true }));
		expect(omp.rpc.getState).not.toHaveBeenCalled();
	});

	it("does not rehydrate on failure responses or missing data", async () => {
		const omp = installMockOmp();
		await settleComposerResponse({ type: "response", command: "prompt", success: false, error: "boom" });
		await settleComposerResponse(success({}));
		expect(omp.rpc.getState).not.toHaveBeenCalled();
	});
});
