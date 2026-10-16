/**
 * gui-bridge prompt suggestions (resources/gui-bridge/next-prompt-engine.ts) on a fake session, host and stock:
 * what triggers a request, what the request carries and runs on, what gets pushed, and every way it stops
 * (typing, a new run, a newer trigger, the feature off). Against the real stock: bridge-next-prompt-stock.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	NextPromptConfigFrame,
	NextPromptState,
	NextPromptUpdate,
} from "../../resources/gui-bridge/next-prompt-contracts";
import { SUGGEST_DEBOUNCE_MS } from "../../resources/gui-bridge/next-prompt-core";
import {
	type EngineEnv,
	handlers,
	install,
	type NextPromptHost,
	type NextPromptSession,
	type NextPromptStock,
	resetNextPromptState,
	setNextPromptStock,
} from "../../resources/gui-bridge/next-prompt-engine";

type BridgeEvent = NextPromptUpdate | NextPromptConfigFrame;
type BridgeEnv = EngineEnv;

interface Call {
	model: { provider: string; id: string };
	context: { systemPrompt: string[]; messages: Array<{ role: string; content: string }> };
	options: {
		maxTokens?: number;
		disableReasoning?: boolean;
		temperature?: number;
		signal: AbortSignal;
		apiKey: unknown;
		sessionId?: string;
	};
}

type Hook = (event: unknown, ctx: { agent: { kind: string } }) => void;

const SMOL = { provider: "fake", id: "smol-1" };
const MAIN = { provider: "fake", id: "main-big" };

interface World {
	session: NextPromptSession & { messages: Array<Record<string, unknown>>; usage: Array<Record<string, unknown>> };
	frames: BridgeEvent[];
	calls: Call[];
	hooks: Map<string, Hook>;
	env: BridgeEnv;
	debug: Array<[string, Record<string, unknown> | undefined]>;
	/** What the fake model answers; a function may throw or hang. */
	reply: {
		current: (
			call: Call,
		) => Promise<{ content: Array<{ type: string; text: string }>; stopReason?: string; errorMessage?: string }>;
	};
	chain: { current: Array<{ model: { provider: string; id: string } }> };
	keys: { current: (model: { id: string }) => unknown };
	skip: { current: (text: string) => boolean };
}

const text = (value: string) => ({ content: [{ type: "text", text: value }], stopReason: "stop" });

function build(): World {
	const frames: BridgeEvent[] = [];
	const calls: Call[] = [];
	const debug: World["debug"] = [];
	const hooks = new Map<string, Hook>();
	const session: World["session"] = {
		messages: [
			{ role: "user", content: "run the tests", timestamp: 1 },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Tests ran." }], timestamp: 2 },
		],
		isStreaming: false,
		isCompacting: false,
		queuedMessageCount: 0,
		sessionId: "sess-1",
		sessionFile: "/sessions/one.jsonl",
		settings: { fake: true },
		modelRegistry: {
			getApiKey: async (model: never) => keys.current(model as { id: string }),
			resolver: (model: never) => ({ resolverFor: (model as { id: string }).id }),
			getAvailable: () => [],
		},
		sessionManager: {
			getSessionId: () => "sess-1",
			getLeafId: () => "leaf-1",
			appendModelUsage: (usage: Record<string, unknown>) => {
				session.usage.push(usage);
			},
		},
		usage: [],
	};
	const reply: World["reply"] = { current: async () => text("1. commit it\n2. push it\n3. run the linter") };
	const chain: World["chain"] = { current: [{ model: SMOL }] };
	const keys: World["keys"] = { current: () => "key" };
	const skip: World["skip"] = { current: () => false };
	const stock: NextPromptStock = {
		completeSimple: async (model, context, options) => {
			const call = { model, context, options } as unknown as Call;
			calls.push(call);
			return reply.current(call);
		},
		roleCandidatePool: () => [SMOL, MAIN],
		resolveRoleChain: () => chain.current,
		shouldSkipHistory: value => skip.current(value),
	};
	setNextPromptStock(stock);
	const host: NextPromptHost = {
		on: ((event: string, handler: Hook) => {
			hooks.set(event, handler);
		}) as NextPromptHost["on"],
		logger: { debug: (message, data) => void debug.push([message, data]) },
		pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) }, MAIN_AGENT_ID: "main" },
		getCommands: () => [],
	};
	install(host);
	const env = {
		pi: {},
		session: () => session,
		context: () => {
			throw new Error("no context");
		},
		emit: (event: BridgeEvent) => void frames.push(event),
	} as unknown as BridgeEnv;
	return { session, frames, calls, hooks, env, debug, reply, chain, keys, skip };
}

const main = { agent: { kind: "main" } };
const sub = { agent: { kind: "sub" } };
const flush = async () => {
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
};
const updates = (world: World) =>
	world.frames.filter((frame): frame is NextPromptUpdate => frame.type === "next_prompt_update");

let world: World;

beforeEach(() => {
	vi.useFakeTimers();
	resetNextPromptState();
	world = build();
});

afterEach(() => {
	resetNextPromptState();
	setNextPromptStock(undefined);
	vi.useRealTimers();
});

async function turnEnds(w: World = world): Promise<void> {
	await handlers.next_prompt_set({ suggestions: true, inline: true }, w.env);
	w.hooks.get("agent_end")?.({}, main);
	await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
	await flush();
}

describe("a finished turn", () => {
	it("makes one cheap request on the smol model and pushes the ranked candidates", async () => {
		await turnEnds();
		expect(world.calls).toHaveLength(1);
		const call = world.calls[0] as Call;
		expect(call.model).toEqual(SMOL);
		expect(call.model).not.toEqual(MAIN);
		expect(call.options.disableReasoning).toBe(true);
		expect(call.options.maxTokens).toBe(512);
		expect(call.options.apiKey).toEqual({ resolverFor: "smol-1" });
		expect(call.options.sessionId).toBe("sess-1");
		expect(call.context.systemPrompt[0]).toContain("Write exactly 3 candidates");
		expect(call.context.messages[0]?.content).toContain("user: run the tests");
		// No register to name for an English user, and never an excerpt of their messages.
		expect(call.context.messages[0]?.content).toMatch(/^<conversation>\n/);
		const [update] = updates(world);
		expect(update).toMatchObject({
			status: "ready",
			trigger: "turn",
			candidates: ["commit it", "push it", "run the linter"],
			used: { model: "fake/smol-1", role: "smol" },
			sessionFile: "/sessions/one.jsonl",
			sessionId: "sess-1",
		});
		expect(typeof update?.ms).toBe("number");
		expect(world.session.usage[0]).toMatchObject({ purpose: "composer-prediction", role: "smol" });
	});

	it("carries the app state: failed command and exit, changed files, tests, plan, todos, goal, answered question", async () => {
		world.session.messages.push(
			{ role: "user", content: "fix it", timestamp: 3 },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "e", name: "edit", arguments: { path: "src/a.ts" } }],
				timestamp: 4,
			},
			{
				role: "toolResult",
				toolCallId: "e",
				toolName: "edit",
				isError: false,
				content: [],
				details: { path: "src/a.ts" },
				timestamp: 5,
			},
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "bun test" } }],
				timestamp: 6,
			},
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "bash",
				isError: true,
				content: [],
				details: { exitCode: 1 },
				timestamp: 7,
			},
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "tests fail" }], timestamp: 8 },
		);
		Object.assign(world.session, {
			getPlanModeState: () => ({ enabled: true }),
			getTodoPhases: () => [
				{
					tasks: [
						{ content: "wire api", status: "in_progress" },
						{ content: "docs", status: "pending" },
					],
				},
			],
			getGoalModeState: () => ({ enabled: true, goal: { objective: "Ship login", status: "active" } }),
		});
		await turnEnds();
		const prompt = world.calls[0]?.context.messages[0]?.content ?? "";
		expect(prompt).toContain("<app-state>");
		expect(prompt).toContain("last-failure: bash `bun test` exit 1");
		expect(prompt).toContain("files-changed: 1 (src/a.ts)");
		expect(prompt).toContain("tests: ran, failed (`bun test`)");
		expect(prompt).toContain("plan: open");
		expect(prompt).toContain("todos: 0 of 2 done; in progress: wire api; next: docs");
		expect(prompt).toContain("goal: active — Ship login");
	});

	it("carries the session's running subagents and background jobs (stock getAsyncJobSnapshot)", async () => {
		world.session.messages.push(
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{
						type: "toolCall",
						id: "w",
						name: "task",
						arguments: { i: "Wide-window work board", tasks: [{ name: "WorkBoard", task: "build it" }] },
					},
				],
				timestamp: 3,
			},
			{ role: "toolResult", toolCallId: "w", toolName: "task", isError: false, content: [], timestamp: 4 },
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Handed to WorkBoard." }],
				timestamp: 5,
			},
		);
		Object.assign(world.session, {
			getAsyncJobSnapshot: () => ({
				running: [
					{ id: "WorkBoard", type: "task", status: "running", label: "WorkBoard" },
					{ id: "b1", type: "bash", status: "running", label: "gh run watch 7", command: "gh run watch 7" },
				],
				recent: [{ id: "old", type: "task", status: "completed", label: "Finished" }],
			}),
		});
		await turnEnds();
		const prompt = world.calls[0]?.context.messages[0]?.content ?? "";
		expect(prompt).toContain("running-now: subagent WorkBoard (Wide-window work board); command `gh run watch 7`");
		expect(prompt).not.toContain("Finished");
	});

	it("pushes an empty candidate list when nothing natural fits", async () => {
		world.reply.current = async () => text("NONE");
		await turnEnds();
		expect(updates(world)[0]).toMatchObject({ status: "ready", candidates: [] });
	});

	it("names a 반말 user's register to the model and turns its 존댓말 answers into 반말", async () => {
		world.session.messages.push(
			{ role: "user", content: "배포해줘", timestamp: 3 },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "배포했어요." }], timestamp: 4 },
			{ role: "user", content: "또 존대말 나오네", timestamp: 5 },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "고칠게요." }], timestamp: 6 },
		);
		world.reply.current = async () =>
			text("롤백해도 되나요?\nWinBlank 결과 나오면 바로 알려주세요\n테스트 결과를 확인했습니다");
		await turnEnds();
		const prompt = (world.calls[0] as Call).context.messages[0]?.content ?? "";
		expect(prompt).toMatch(/^<user-style>\nregister: 반말 \(casual\)\./);
		expect(prompt).not.toContain("- 배포해줘");
		expect(updates(world)[0]?.candidates).toEqual(["롤백해도 돼?", "WinBlank 결과 나오면 바로 알려줘"]);
	});

	it("drops a candidate restating a message the user already sent", async () => {
		world.session.messages.push(
			{ role: "user", content: "모드를 추가할것은 없나? 모델풀은 삭제해야할꺼 같고", timestamp: 3 },
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "ModeScout에게 맡겼어요." }],
				timestamp: 4,
			},
			{ role: "user", content: "채팅 입력창에 뭔가 효과를 줘서 작업중이라는 느낌을 주면 좋을꺼같음", timestamp: 5 },
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "ComposerLive에게 맡겼어요." }],
				timestamp: 6,
			},
		);
		world.reply.current = async () => text("모드 추가할 건 없어? 모델풀은 지워야 할 것 같고\n효과 시안 먼저 보여줘");
		await turnEnds();
		expect(updates(world)[0]?.candidates).toEqual(["효과 시안 먼저 보여줘"]);
	});

	it("ignores a subagent's turn, a disabled feature and a session with no reply yet", async () => {
		await handlers.next_prompt_set({ suggestions: true, inline: true }, world.env);
		world.hooks.get("agent_end")?.({}, sub);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await handlers.next_prompt_set({ suggestions: false, inline: true }, world.env);
		world.hooks.get("agent_end")?.({}, main);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await handlers.next_prompt_set({ suggestions: true, inline: true }, world.env);
		world.session.messages.length = 1;
		world.hooks.get("agent_end")?.({}, main);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(0);
	});

	it("collapses a burst of turn ends into one request", async () => {
		await handlers.next_prompt_set({ suggestions: true, inline: true }, world.env);
		for (let index = 0; index < 4; index++) {
			world.hooks.get("agent_end")?.({}, main);
			await vi.advanceTimersByTimeAsync(100);
		}
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(1);
	});

	it("does not ask again for a state it already suggested for", async () => {
		await turnEnds();
		world.hooks.get("session_switch")?.({}, main);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(1);
	});
});

describe("regeneration", () => {
	it("asks again after a compaction (the history changed) and after a refresh the renderer asked for", async () => {
		await turnEnds();
		world.session.messages.splice(0, 1, { role: "user", content: "[summary]", timestamp: 9 });
		world.hooks.get("session_compact")?.({}, main);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(2);
		expect(world.calls[1]?.context.messages[0]?.content).toContain("history: compacted");
		expect(updates(world).at(-1)).toMatchObject({ trigger: "compaction" });
		await handlers.next_prompt_refresh({ reason: "bash" }, world.env);
		world.session.messages.push({
			role: "bashExecution",
			command: "git status",
			output: "",
			exitCode: 0,
			cancelled: false,
			timestamp: 10,
		});
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(3);
		expect(world.calls[2]?.context.messages[0]?.content).toContain("user-ran: `git status` exit 0");
	});

	it("asks for a session switched to whose state moved, and forces a manual refresh", async () => {
		await turnEnds();
		world.session.sessionFile = "/sessions/two.jsonl";
		world.session.sessionId = "sess-2";
		world.hooks.get("session_switch")?.({}, main);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(2);
		expect(updates(world).at(-1)).toMatchObject({ trigger: "switch", sessionFile: "/sessions/two.jsonl" });
		await handlers.next_prompt_refresh({ reason: "refresh" }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(3);
	});

	it("refuses an unknown refresh reason", async () => {
		await expect(handlers.next_prompt_refresh({ reason: "turn" }, world.env)).rejects.toThrow("reason");
	});
});

describe("cancelling", () => {
	function hang(w: World): { release: (value: string) => void } {
		let release: (value: string) => void = () => {};
		w.reply.current = () =>
			new Promise(resolve => {
				release = value => resolve(text(value));
			});
		return { release: value => release(value) };
	}

	it("aborts the running request when the user starts typing and shows nothing", async () => {
		const pending = hang(world);
		await turnEnds();
		const call = world.calls[0] as Call;
		expect(call.options.signal.aborted).toBe(false);
		await handlers.next_prompt_draft({ empty: false }, world.env);
		expect(call.options.signal.aborted).toBe(true);
		pending.release("1. late");
		await flush();
		expect(updates(world)).toEqual([]);
	});

	it("drops a waiting request on input and asks again once the draft is empty", async () => {
		await handlers.next_prompt_set({ suggestions: true, inline: true }, world.env);
		world.hooks.get("agent_end")?.({}, main);
		await handlers.next_prompt_draft({ empty: false }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		expect(world.calls).toHaveLength(0);
		await handlers.next_prompt_draft({ empty: true }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(1);
	});

	it("aborts on a new run", async () => {
		hang(world);
		await turnEnds();
		const call = world.calls[0] as Call;
		world.hooks.get("agent_start")?.({}, main);
		expect(call.options.signal.aborted).toBe(true);
	});

	it("shows nothing when the moment passed while the model answered (a run started)", async () => {
		const pending = hang(world);
		await turnEnds();
		world.session.isStreaming = true;
		pending.release("1. too late");
		await flush();
		expect(updates(world)).toEqual([]);
	});

	it("drops an answer made for running work that ended meanwhile, and asks again for the new moment", async () => {
		let running = [{ id: "WorkBoard", type: "task", status: "running", label: "WorkBoard" }];
		Object.assign(world.session, { getAsyncJobSnapshot: () => ({ running, recent: [] }) });
		const pending = hang(world);
		await turnEnds();
		expect(world.calls[0]?.context.messages[0]?.content).toContain("running-now: subagent WorkBoard");
		running = [];
		pending.release("wait for WorkBoard");
		await flush();
		expect(updates(world)).toEqual([]);
		world.reply.current = async () => text("show me the work board");
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(2);
		expect(world.calls[1]?.context.messages[0]?.content).not.toContain("running-now");
		expect(updates(world)).toEqual([
			expect.objectContaining({ status: "ready", candidates: ["show me the work board"] }),
		]);
	});

	it("cancel scopes abort what they name", async () => {
		const pending = hang(world);
		await turnEnds();
		await handlers.next_prompt_cancel({ scope: "inline" }, world.env);
		expect((world.calls[0] as Call).options.signal.aborted).toBe(false);
		await handlers.next_prompt_cancel({ scope: "suggest" }, world.env);
		expect((world.calls[0] as Call).options.signal.aborted).toBe(true);
		pending.release("x");
		await expect(handlers.next_prompt_cancel({ scope: "nope" }, world.env)).rejects.toThrow("scope");
	});

	it("switching the feature off aborts, clears the session's suggestion and reports it", async () => {
		hang(world);
		await turnEnds();
		await handlers.next_prompt_set({ suggestions: false, inline: true }, world.env);
		expect((world.calls[0] as Call).options.signal.aborted).toBe(true);
		expect(updates(world).at(-1)).toMatchObject({ status: "cleared", sessionFile: "/sessions/one.jsonl" });
		expect(world.frames.at(-1)).toMatchObject({ type: "next_prompt_config", suggestions: false });
	});
});

describe("the cheap model", () => {
	it("is unavailable, with the reason, when the smol role resolves to nothing — the main model is never used", async () => {
		world.chain.current = [];
		await turnEnds();
		expect(world.calls).toHaveLength(0);
		expect(updates(world)[0]).toMatchObject({ status: "unavailable", reason: "no_model" });
		expect(world.debug.some(([message]) => message.includes("unavailable"))).toBe(true);
	});

	it("is unavailable without credentials and tries the role chain's next model first", async () => {
		world.chain.current = [{ model: SMOL }, { model: { provider: "fake", id: "smol-2" } }];
		world.keys.current = model => (model.id === "smol-2" ? "key" : undefined);
		await turnEnds();
		expect(world.calls[0]?.model.id).toBe("smol-2");
		expect(updates(world)[0]).toMatchObject({ status: "ready", used: { model: "fake/smol-2" } });
		world.keys.current = () => undefined;
		await handlers.next_prompt_refresh({ reason: "refresh" }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(updates(world).at(-1)).toMatchObject({ status: "unavailable", reason: "no_credentials" });
	});

	it("names a refusal, an offline failure and a provider error, and recovers with the next success", async () => {
		world.reply.current = async () => {
			throw new Error("403 Forbidden: no access to this model");
		};
		await turnEnds();
		expect(updates(world)[0]).toMatchObject({ status: "unavailable", reason: "refused" });
		world.reply.current = async () => {
			throw new Error("fetch failed: getaddrinfo ENOTFOUND api.example.com");
		};
		await handlers.next_prompt_refresh({ reason: "refresh" }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(updates(world).at(-1)).toMatchObject({ status: "unavailable", reason: "offline" });
		world.reply.current = async () => ({ content: [], stopReason: "error", errorMessage: "weird" });
		await handlers.next_prompt_refresh({ reason: "refresh" }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(updates(world).at(-1)).toMatchObject({ status: "unavailable", reason: "error", detail: "weird" });
		world.reply.current = async () => text("1. ship it");
		await handlers.next_prompt_refresh({ reason: "refresh" }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(updates(world).at(-1)).toMatchObject({ status: "ready", candidates: ["ship it"] });
		const state = (await handlers.next_prompt_state({}, world.env)) as NextPromptState;
		expect(state.unavailable).toBeUndefined();
	});

	it("asks again without an output cap when the transport refuses one", async () => {
		let first = true;
		world.reply.current = async () => {
			if (first) {
				first = false;
				throw new Error("Unsupported parameter: max_output_tokens");
			}
			return text("1. ship it");
		};
		await turnEnds();
		expect(world.calls.map(call => call.options.maxTokens)).toEqual([512, undefined]);
		expect(updates(world)[0]).toMatchObject({ status: "ready", candidates: ["ship it"] });
	});
});

describe("state", () => {
	it("reports settings, the model it would use, request counts and the user's own next-prompt extension", async () => {
		await turnEnds();
		let state = (await handlers.next_prompt_state({}, world.env)) as NextPromptState;
		expect(state).toMatchObject({
			suggestions: true,
			inline: true,
			legacyExtension: false,
			model: { model: "fake/smol-1", role: "smol" },
			requests: { suggest: 1, inline: 0 },
		});
		Object.assign(world.session, {
			extensionRunner: {
				getLoadedExtensions: () => [
					{ path: "/home/u/.omp/agent/extensions/other.ts" },
					{ path: "/home/u/.omp/agent/extensions/next-prompt.ts" },
				],
				isExtensionActive: () => true,
			},
		});
		state = (await handlers.next_prompt_state({}, world.env)) as NextPromptState;
		expect(state.legacyExtension).toBe(true);
		Object.assign(world.session, {
			extensionRunner: {
				getLoadedExtensions: () => [{ path: "/x/next-prompt.ts" }],
				isExtensionActive: () => false,
			},
		});
		expect(((await handlers.next_prompt_state({}, world.env)) as NextPromptState).legacyExtension).toBe(false);
	});

	it("reports no model when the role resolves to none", async () => {
		world.chain.current = [];
		const state = (await handlers.next_prompt_state({}, world.env)) as NextPromptState;
		expect(state.model).toBeUndefined();
		expect(state.unavailable).toBe("no_model");
	});

	it("validates what main and the renderer send", async () => {
		await expect(handlers.next_prompt_set({ suggestions: "yes" }, world.env)).rejects.toThrow("suggestions");
		await expect(handlers.next_prompt_draft({}, world.env)).rejects.toThrow("empty");
	});

	it("pushes its config when the settings change", async () => {
		await handlers.next_prompt_set({ suggestions: true, inline: false }, world.env);
		expect(world.frames.at(-1)).toMatchObject({ type: "next_prompt_config", suggestions: true, inline: false });
	});
});

describe("inline completion", () => {
	const ask = (draft: string, requestId = "r1") => handlers.next_prompt_inline({ draft, requestId }, world.env);

	it("runs on the smol model and returns what follows the restated draft", async () => {
		world.reply.current = async () => text("please fix the failing test in a.ts");
		const result = await ask("please fix the");
		expect(result).toMatchObject({ requestId: "r1", text: " failing test in a.ts", used: { model: "fake/smol-1" } });
		const call = world.calls[0] as Call;
		expect(call.model).toEqual(SMOL);
		expect(call.options.maxTokens).toBe(512);
		expect(call.options.temperature).toBe(0);
		expect(call.options.disableReasoning).toBe(true);
		expect(call.context.messages[0]?.content).toContain("<draft>please fix the</draft>");
		expect(call.context.systemPrompt[0]).toContain("Reply with the whole message: first the draft exactly as typed");
		expect(((await handlers.next_prompt_state({}, world.env)) as NextPromptState).requests).toEqual({
			suggest: 0,
			inline: 1,
		});
	});

	it("makes no request for an ineligible draft, a draft stock keeps out of history, or with the switches off", async () => {
		expect(await ask("short")).toMatchObject({ text: null });
		expect(await ask("/login https://x/?code=abc")).toMatchObject({ text: null });
		expect(await ask("two\nlines of text")).toMatchObject({ text: null });
		world.skip.current = () => true;
		expect(await ask("my secret looking draft")).toMatchObject({ text: null });
		world.skip.current = () => false;
		await handlers.next_prompt_set({ suggestions: true, inline: false }, world.env);
		expect(await ask("please fix the failing")).toMatchObject({ text: null });
		await handlers.next_prompt_set({ suggestions: false, inline: true }, world.env);
		expect(await ask("please fix the failing")).toMatchObject({ text: null });
		expect(world.calls).toHaveLength(0);
	});

	it("aborts the earlier request when a newer one arrives and answers it with no completion", async () => {
		const releases: Array<(value: string) => void> = [];
		world.reply.current = call => {
			const { promise, resolve, reject } = Promise.withResolvers<ReturnType<typeof text>>();
			releases.push(value => resolve(text(value)));
			// A real transport rejects when its signal aborts.
			call.options.signal.addEventListener("abort", () => reject(new Error("aborted")));
			return promise;
		};
		const first = ask("please fix the", "a");
		await flush();
		const firstCall = world.calls[0] as Call;
		const second = ask("please fix the failing", "b");
		expect(firstCall.options.signal.aborted).toBe(true);
		expect(await first).toEqual({ requestId: "a", text: null });
		await flush();
		releases[1]?.("please fix the failing test");
		expect(await second).toMatchObject({ requestId: "b", text: " test" });
	});

	it("reports why it failed without throwing", async () => {
		world.chain.current = [];
		expect(await ask("please fix the failing")).toEqual({ requestId: "r1", text: null, reason: "no_model" });
	});

	it("tells a 반말 user's register and shows nothing for a 존댓말, assistant-voiced or copied continuation", async () => {
		world.session.messages.push(
			{ role: "user", content: "배포해줘", timestamp: 3 },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "배포했어요." }], timestamp: 4 },
			{
				role: "user",
				content: "그리고 윈도우버전에서는 추가지시가 즉시 안들어감 지금 대기열에 걸려있음",
				timestamp: 5,
			},
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "WinSteer에게 맡겼어요." }],
				timestamp: 6,
			},
		);
		world.reply.current = async () => text("그리고 지금 작업중인데 버튼이 안 되는지 확인해 볼게요.");
		expect(await ask("그리고 지금 작업중인데 버튼이")).toMatchObject({ text: null });
		expect((world.calls[0] as Call).context.messages[0]?.content).toContain("register: 반말 (casual).");
		world.reply.current = async () => text("그리고 윈도우버전에서는 추가지시가 즉시 안들어감");
		expect(await ask("그리고 윈도우버전에서는")).toMatchObject({ text: null });
		world.reply.current = async () => text("그리고 지금 작업중인데 버튼이 안 바뀌어");
		expect(await ask("그리고 지금 작업중인데 버튼이")).toMatchObject({ text: " 안 바뀌어" });
	});

	it("validates its params", async () => {
		await expect(handlers.next_prompt_inline({ draft: 1 }, world.env)).rejects.toThrow("draft");
		await expect(handlers.next_prompt_inline({ draft: "x", requestId: "" }, world.env)).rejects.toThrow("requestId");
	});
});
