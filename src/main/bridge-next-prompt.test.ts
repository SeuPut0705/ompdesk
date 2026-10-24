/**
 * gui-bridge prompt suggestions (resources/gui-bridge/modes/next-prompt-engine.ts) on a fake session, host and stock:
 * what triggers a request, what the request carries and runs on, what gets pushed, and every way it stops
 * (typing, a new run, a newer trigger, the feature off). Against the real stock: bridge-next-prompt-stock.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUDGE_ASSIST_TIMEOUT_MS } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import { setJudgeAssistEnabled, setJudgeAssistStockLoader } from "../../resources/gui-bridge/modes/judge-assist-engine";
import {
	NEXT_PROMPT_ENTRY,
	type NextPromptConfigFrame,
	type NextPromptState,
	type NextPromptUpdate,
} from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { SUGGEST_DEBOUNCE_MS } from "../../resources/gui-bridge/modes/next-prompt-core";
import {
	type EngineEnv,
	handlers,
	install,
	type NextPromptHost,
	type NextPromptSession,
	type NextPromptStock,
	resetNextPromptState,
	setNextPromptStock,
} from "../../resources/gui-bridge/modes/next-prompt-engine";
import { type FakeJudge, fakeJudge, needsAnswer } from "./test-fake-judge";
import { garbled } from "./test-mojibake";

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
/** UTF-8 read back as Windows-1252, the way the smol model once wrote a whole reply ("지금" → "ì§€ê¸ˆ"). */

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

	it("carries the session's running subagents and background jobs (stock getAsyncJobTree)", async () => {
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
			getAsyncJobTree: () => ({
				running: [
					{ id: "WorkBoard", type: "task", status: "running", label: "WorkBoard" },
					{ id: "b1", type: "bash", status: "running", label: "gh run watch 7", command: "gh run watch 7" },
					// A subagent's own shell: the tree lists it with the session's.
					{
						id: "b2",
						type: "bash",
						status: "running",
						label: "bun test",
						command: "bun test",
						ownerId: "WorkBoard",
					},
				],
				recent: [{ id: "old", type: "task", status: "completed", label: "Finished" }],
			}),
		});
		await turnEnds();
		const prompt = world.calls[0]?.context.messages[0]?.content ?? "";
		expect(prompt).toContain(
			"running-now: subagent WorkBoard (Wide-window work board); command `gh run watch 7`; command `bun test`",
		);
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

	it("drops candidates the model wrote as UTF-8 read as Windows-1252 (mojibake), keeping the clean ones", async () => {
		// The reported reply: the placeholder and the chip came out as "ì•Œê² ì–´ ê·¸ëŸ¼ ê³„ì† ì§„í–‰í•´" and
		// "ì§€ê¸ˆ ì—ì´ì „íŠ¸ë“¤ ìƒíƒœ ë‹¤ì‹œ í•œë²ˆ ì •ë¦¬í•´ì¤˜".
		world.reply.current = async () =>
			text(
				[garbled("알겠어 그럼 계속 진행해"), garbled("지금 에이전트들 상태 다시 한번 정리해줘"), "커밋해줘"].join(
					"\n",
				),
			);
		await turnEnds();
		expect(updates(world)[0]?.candidates).toEqual(["커밋해줘"]);
		world.reply.current = async () => text(garbled("지금 에이전트들 상태 다시 한번 정리해줘"));
		await handlers.next_prompt_refresh({ reason: "refresh" }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(updates(world).at(-1)).toMatchObject({ status: "ready", candidates: [] });
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

describe("the session's last suggestion (a page that reloads, a tab shown again, a relaunch)", () => {
	type Journal = Array<{ type: string; customType?: string; data?: unknown; message?: unknown }>;
	function withJournal(w: World, journal: Journal): void {
		Object.assign(w.session.sessionManager, {
			appendCustomEntry: (customType: string, data: unknown) =>
				void journal.push({ type: "custom", customType, data }),
			getBranch: () => journal,
		});
	}
	const state = async (w: World = world) => (await handlers.next_prompt_state({}, w.env)) as NextPromptState;

	it("answers it with the state, and an empty one once a new run made it stale", async () => {
		await turnEnds();
		expect((await state()).last).toMatchObject({
			candidates: ["commit it", "push it", "run the linter"],
			used: { model: "fake/smol-1", role: "smol" },
			sessionFile: "/sessions/one.jsonl",
			sessionId: "sess-1",
		});
		expect(typeof (await state()).last?.at).toBe("number");
		world.hooks.get("agent_start")?.({}, main);
		expect((await state()).last).toMatchObject({ candidates: [], sessionFile: "/sessions/one.jsonl" });
	});

	it("journals it, and an omp started on the session reads it back without asking the model", async () => {
		const journal: Journal = [];
		withJournal(world, journal);
		await turnEnds();
		expect(journal).toEqual([
			{
				type: "custom",
				customType: NEXT_PROMPT_ENTRY,
				data: expect.objectContaining({ candidates: ["commit it", "push it", "run the linter"] }),
			},
		]);
		// A relaunch: a new omp on the same session file, nothing in memory.
		resetNextPromptState();
		const again = build();
		withJournal(again, journal);
		await handlers.next_prompt_set({ suggestions: true, inline: true }, again.env);
		expect((await state(again)).last?.candidates).toEqual(["commit it", "push it", "run the linter"]);
		// The moment is the same: an emptied draft asks the model nothing.
		await handlers.next_prompt_draft({ empty: false }, again.env);
		await handlers.next_prompt_draft({ empty: true }, again.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(again.calls).toHaveLength(0);
	});

	it("never answers a journaled one a later message made stale", async () => {
		const journal: Journal = [
			{ type: "custom", customType: NEXT_PROMPT_ENTRY, data: { candidates: ["old"], at: 1, key: "k" } },
			{ type: "message", message: { role: "user", content: "next" } },
		];
		withJournal(world, journal);
		await handlers.next_prompt_set({ suggestions: true, inline: true }, world.env);
		expect((await state()).last).toBeUndefined();
	});

	it("keeps the suggestion when the person types and clears the draft: the moment did not move", async () => {
		await turnEnds();
		await handlers.next_prompt_draft({ empty: false }, world.env);
		await handlers.next_prompt_draft({ empty: true }, world.env);
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		await flush();
		expect(world.calls).toHaveLength(1);
		expect(updates(world)).toHaveLength(1);
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
		Object.assign(world.session, { getAsyncJobTree: () => ({ running, recent: [] }) });
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

	it("shows no ghost the model wrote as UTF-8 read as Windows-1252", async () => {
		world.reply.current = async () => text(`please fix the ${garbled("버튼 테스트")}`);
		expect(await ask("please fix the")).toMatchObject({ text: null });
	});

	it("validates its params", async () => {
		await expect(handlers.next_prompt_inline({ draft: 1 }, world.env)).rejects.toThrow("draft");
		await expect(handlers.next_prompt_inline({ draft: "x", requestId: "" }, world.env)).rejects.toThrow("requestId");
	});
});

describe("the judge's reading of the last reply (judge assist)", () => {
	/** Rule says nothing is asked (no question mark, no pattern), a person would still have to pick. */
	const MISSED = "Both fixes work. Tell me your pick and I will take it from there.";
	/** Rule says a question is asked, though it is only rhetorical. */
	const RHETORICAL = "The build passes now. Should I celebrate?";
	const DECISION_LINE = "last-reply: asks the user to decide or answer something";
	const DONE_LINE = "last-reply: reports work done or underway; it asks the user nothing";
	let fake: FakeJudge;

	const lastAssistant = (replyText: string) => {
		world.session.messages.push(
			{ role: "user", content: "which fix?", timestamp: 3 },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: replyText }], timestamp: 4 },
		);
	};
	const prompt = () => world.calls[0]?.context.messages[0]?.content ?? "";
	const withJudge = (probability: number) => {
		fake = fakeJudge(async () => needsAnswer(probability));
		setJudgeAssistStockLoader(async () => fake.stock);
	};

	afterEach(() => {
		setJudgeAssistStockLoader(undefined);
		setJudgeAssistEnabled(true);
	});

	it("a reply the rule misses but the judge says waits: app-state says decision and an approval-only candidate stays", async () => {
		lastAssistant(MISSED);
		world.reply.current = async () => text("1. yes, go ahead\n2. use the first one\n3. run the tests");
		withJudge(0.7);
		await turnEnds();
		expect(prompt()).toContain(DECISION_LINE);
		expect(prompt()).not.toContain(DONE_LINE);
		expect(updates(world)[0]?.candidates).toEqual(["yes, go ahead", "use the first one", "run the tests"]);
		expect((fake.requests[0] as { state: { reply: string } }).state.reply).toBe(MISSED);
		expect((fake.deps[0] as { purpose: string }).purpose).toBe("ompdesk-needs-user");
	});

	it("a reply ending in a question the judge says waits for nothing: app-state says done and the approval is dropped", async () => {
		lastAssistant(RHETORICAL);
		world.reply.current = async () => text("1. yes, go ahead\n2. run the tests\n3. push it");
		withJudge(0.69);
		await turnEnds();
		expect(prompt()).toContain(DONE_LINE);
		expect(prompt()).not.toContain(DECISION_LINE);
		expect(updates(world)[0]?.candidates).toEqual(["run the tests", "push it"]);
	});

	it("an ask still open counts as a decision whatever the judge says", async () => {
		world.session.messages.push(
			{ role: "user", content: "set it up", timestamp: 3 },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "a", name: "ask", arguments: { questions: [] } }],
				timestamp: 4,
			},
		);
		world.reply.current = async () => text("1. yes, go ahead\n2. run the tests\n3. push it");
		withJudge(0.01);
		await turnEnds();
		expect(prompt()).toContain(DECISION_LINE);
		expect(updates(world)[0]?.candidates).toContain("yes, go ahead");
	});

	it("keeps one suggestion per moment: a judged state does not move the state key", async () => {
		lastAssistant(MISSED);
		withJudge(0.9);
		await turnEnds();
		await turnEnds();
		expect(world.calls).toHaveLength(1);
		expect(updates(world)).toHaveLength(1);
	});

	it.each([
		["no native judge", () => (fake.native.current = false)],
		["the switch off", () => setJudgeAssistEnabled(false)],
		[
			"a judge that throws",
			() => {
				fake.answer.current = async () => {
					throw new Error("provider down");
				};
			},
		],
		[
			"an unreadable answer",
			() => {
				fake.answer.current = async () => ({});
			},
		],
	])("with %s the rule decides, exactly as without a judge", async (_label, disable) => {
		const results: Array<{ prompt: string; candidates: string[] | undefined }> = [];
		for (const judged of [false, true]) {
			world = build();
			lastAssistant(RHETORICAL);
			world.reply.current = async () => text("1. yes, go ahead\n2. run the tests\n3. push it");
			if (judged) {
				withJudge(0.01);
				disable();
			}
			await turnEnds();
			results.push({ prompt: prompt(), candidates: updates(world)[0]?.candidates });
			resetNextPromptState();
			setJudgeAssistStockLoader(undefined);
			setJudgeAssistEnabled(true);
		}
		expect(results[1]).toEqual(results[0]);
		expect(results[0]?.prompt).toContain(DECISION_LINE);
		expect(results[0]?.candidates).toContain("yes, go ahead");
	});

	it("a judge that never answers costs one limit, then the rule decides", async () => {
		lastAssistant(RHETORICAL);
		world.reply.current = async () => text("1. yes, go ahead\n2. run the tests\n3. push it");
		fake = fakeJudge(() => Promise.withResolvers<never>().promise);
		setJudgeAssistStockLoader(async () => fake.stock);
		await turnEnds();
		expect(updates(world)).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(JUDGE_ASSIST_TIMEOUT_MS);
		await flush();
		expect(prompt()).toContain(DECISION_LINE);
		expect(updates(world)[0]?.candidates).toContain("yes, go ahead");
	});

	it("never asks the judge for an inline completion", async () => {
		lastAssistant(MISSED);
		withJudge(0.9);
		await handlers.next_prompt_set({ suggestions: true, inline: true }, world.env);
		await handlers.next_prompt_inline({ draft: "please fix the", requestId: "r1" }, world.env);
		expect(world.calls).toHaveLength(1);
		expect(fake.requests).toEqual([]);
	});
});
