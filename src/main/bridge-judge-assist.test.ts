/**
 * The judge-model assists' engine (resources/gui-bridge/modes/judge-assist-engine.ts) on a fake stock `judgment`
 * module: it asks only while the switch is on and stock says the judge role is native, every other state (no stock,
 * not native, switch off, an error, a timeout, an unreadable answer) answers "did not decide" so each feature keeps
 * its code rule, and a decision follows the measured thresholds. Against the real stock: bridge-judge-assist-stock.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	JUDGE_ASSIST_AVAILABLE,
	JUDGE_ASSIST_NEEDS_USER,
	JUDGE_ASSIST_PREVIEW_CHECK,
	JUDGE_ASSIST_SET,
	JUDGE_ASSIST_TIMEOUT_MS,
	NEEDS_USER_MIN,
	PREVIEW_BLANK_MIN,
	PREVIEW_ERROR_MIN,
} from "../../resources/gui-bridge/modes/judge-assist-contracts";
import {
	applyJudgeAssistSet,
	type JudgeSession,
	judgeAssistState,
	judgeAvailable,
	lastReplyText,
	newTitleFits,
	previewImageParam,
	previewProblem,
	recentTitleTurns,
	replyNeedsUser,
	sessionNeedsUser,
	setJudgeAssistEnabled,
	setJudgeAssistStockLoader,
} from "../../resources/gui-bridge/modes/judge-assist-engine";
import { type FakeJudge, fakeJudge, needsAnswer, previewAnswer, titleAnswer } from "./test-fake-judge";

const metadataForProvider = vi.fn((provider: string) => ({ provider }));

function session(): JudgeSession {
	return {
		settings: { fake: "settings" },
		modelRegistry: { fake: "registry" },
		sessionId: "sess-1",
		sessionManager: { fake: "manager" },
		model: { provider: "fake", id: "chat" },
		agent: { metadataForProvider, telemetry: { fake: "telemetry" } },
	};
}

const TURNS = [{ user: "fix the parser", assistant: "Patched it." }];
const IMAGE = { data: "AAAA", mimeType: "image/png" };

let judge: FakeJudge;

function install(answer: FakeJudge["answer"]["current"]): FakeJudge {
	judge = fakeJudge(answer);
	setJudgeAssistStockLoader(async () => judge.stock);
	return judge;
}

beforeEach(() => {
	setJudgeAssistEnabled(true);
});

afterEach(() => {
	setJudgeAssistStockLoader(undefined);
	setJudgeAssistEnabled(true);
	vi.useRealTimers();
	metadataForProvider.mockClear();
});

describe("when the judge does not decide", () => {
	it("answers undefined with no stock loader", async () => {
		setJudgeAssistStockLoader(undefined);
		expect(await replyNeedsUser(session(), "Which one?")).toBeUndefined();
		expect(await newTitleFits(session(), "A", "B", TURNS)).toBeUndefined();
		expect(await previewProblem(session(), IMAGE)).toEqual({ problem: null, judged: false });
	});

	it("answers undefined while stock's judge role is not native, and asks nothing", async () => {
		const before = judgeAssistState().requests;
		install(async () => needsAnswer(1));
		judge.native.current = false;
		expect(await replyNeedsUser(session(), "Which one?")).toBeUndefined();
		expect(await newTitleFits(session(), "A", "B", TURNS)).toBeUndefined();
		expect(await previewProblem(session(), IMAGE)).toEqual({ problem: null, judged: false });
		expect(judge.deps).toEqual([]);
		expect(judge.requests).toEqual([]);
		expect(judgeAssistState().requests).toBe(before);
	});

	it("checks the native role on every call: a role change moves the answer", async () => {
		install(async () => needsAnswer(0.9));
		judge.native.current = false;
		const one = session();
		expect(await replyNeedsUser(one, "Pick a file, which one?")).toBeUndefined();
		judge.native.current = true;
		expect(await replyNeedsUser(one, "Pick a file, which one do you want?")).toBe(true);
	});

	it("answers undefined with the switch off, without even loading stock", async () => {
		const loader = vi.fn(async () => judge.stock);
		install(async () => needsAnswer(1));
		setJudgeAssistStockLoader(loader);
		setJudgeAssistEnabled(false);
		expect(await replyNeedsUser(session(), "Which one?")).toBeUndefined();
		expect(await newTitleFits(session(), "A", "B", TURNS)).toBeUndefined();
		expect(await previewProblem(session(), IMAGE)).toEqual({ problem: null, judged: false });
		expect(loader).not.toHaveBeenCalled();
		expect(judgeAssistState().enabled).toBe(false);
	});

	it("answers undefined when the judge throws, when stock fails to load, and on an unreadable answer", async () => {
		install(async () => {
			throw new Error("provider down");
		});
		expect(await replyNeedsUser(session(), "Which one, please?")).toBeUndefined();
		expect(await newTitleFits(session(), "A", "B", TURNS)).toBeUndefined();
		expect(await previewProblem(session(), IMAGE)).toEqual({ problem: null, judged: false });

		setJudgeAssistStockLoader(async () => {
			throw new Error("module missing");
		});
		expect(await replyNeedsUser(session(), "Which one now?")).toBeUndefined();

		install(async () => ({ needs: { type: "noul" }, better: { type: "choice", choice: "C" }, error: {} }));
		expect(await replyNeedsUser(session(), "Which one then?")).toBeUndefined();
		expect(await newTitleFits(session(), "A", "B", TURNS)).toBeUndefined();
		expect(await previewProblem(session(), IMAGE)).toEqual({ problem: null, judged: false });
	});

	it("answers undefined at the limit when the judge never answers, and aborts it", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		install((_request, given) => {
			signal = given;
			return Promise.withResolvers<never>().promise;
		});
		const pending = replyNeedsUser(session(), "Which one, quickly?");
		await vi.advanceTimersByTimeAsync(JUDGE_ASSIST_TIMEOUT_MS - 1);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toBeUndefined();
		expect(signal?.aborted).toBe(true);
	});

	it("does not decide on an empty reply, and never asks", async () => {
		install(async () => needsAnswer(1));
		expect(await replyNeedsUser(session(), "  \n ")).toBeUndefined();
		expect(judge.requests).toEqual([]);
	});
});

describe("needs-user at the threshold", () => {
	it.each([
		[NEEDS_USER_MIN - 0.01, false],
		[NEEDS_USER_MIN, true],
		[0.99, true],
		[0, false],
	])("p = %s → %s", async (probability, expected) => {
		install(async () => needsAnswer(probability));
		expect(await replyNeedsUser(session(), `Shall we go on? (${probability})`)).toBe(expected);
	});

	it("keeps the measured numbers", () => {
		expect(NEEDS_USER_MIN).toBe(0.7);
		expect(PREVIEW_ERROR_MIN).toBe(0.5);
		expect(PREVIEW_BLANK_MIN).toBe(0.8);
	});

	it("sends the reply's tail as the state and the needs question", async () => {
		install(async () => needsAnswer(0.1));
		const long = `${"x".repeat(4000)} Which one do you want?`;
		await replyNeedsUser(session(), long);
		const request = judge.requests[0] as { state: { reply: string }; questions: { needs: { type: string } } };
		expect(request.state.reply.endsWith("Which one do you want?")).toBe(true);
		expect(request.state.reply.length).toBeLessThan(long.length);
		expect(request.questions.needs.type).toBe("noul");
	});
});

describe("how stock is called", () => {
	it("hands resolveJudge the purpose, the session's identity, the usage ledger, the shared cache and the agent's hooks", async () => {
		install(async () => needsAnswer(0.9));
		const live = session();
		await replyNeedsUser(live, "Which file first?");
		await newTitleFits(live, "A", "B", TURNS);
		await previewProblem(live, IMAGE);
		expect(judge.deps).toHaveLength(3);
		const [needs, title, preview] = judge.deps as Array<Record<string, unknown>>;
		expect([needs?.purpose, title?.purpose, preview?.purpose]).toEqual([
			"ompdesk-needs-user",
			"ompdesk-title-check",
			"ompdesk-preview-check",
		]);
		for (const deps of [needs, title, preview]) {
			expect(deps).toMatchObject({
				settings: live.settings,
				registry: live.modelRegistry,
				sessionModel: live.model,
				sessionId: "sess-1",
			});
			expect(deps?.onUsage).toBe(judge.journaled.onUsage);
			expect(deps?.cache).toBe(judge.cache);
			expect(deps?.telemetry).toEqual({ fake: "telemetry" });
		}
		// `journalJudgmentUsage` is given the session's own manager, once per judgment.
		expect(judge.journaled.managers).toEqual([live.sessionManager, live.sessionManager, live.sessionManager]);
		const resolver = (needs?.metadataResolver as (provider: string) => unknown) ?? (() => undefined);
		expect(resolver("fake")).toEqual({ provider: "fake" });
		expect(judgeAssistState().requests).toBeGreaterThanOrEqual(3);
	});

	it("passes no metadata resolver or telemetry for a session without its agent", async () => {
		install(async () => needsAnswer(0.9));
		const bare: JudgeSession = { ...session(), agent: undefined };
		await replyNeedsUser(bare, "Which one, bare?");
		const [deps] = judge.deps as Array<Record<string, unknown>>;
		expect(deps).not.toHaveProperty("metadataResolver");
		expect(deps?.telemetry).toBeUndefined();
	});

	it("asks once for the same reply while it is in flight, and again for a different one", async () => {
		const release = Promise.withResolvers<void>();
		install(async () => {
			await release.promise;
			return needsAnswer(0.9);
		});
		const live = session();
		const first = replyNeedsUser(live, "Which one do you want?");
		const second = replyNeedsUser(live, "Which one do you want?");
		release.resolve();
		expect(await Promise.all([first, second])).toEqual([true, true]);
		expect(judge.requests).toHaveLength(1);
		expect(await replyNeedsUser(live, "And which one after that?")).toBe(true);
		expect(judge.requests).toHaveLength(2);
		// Another session's identical reply is its own question.
		expect(await replyNeedsUser(session(), "And which one after that?")).toBe(true);
		expect(judge.requests).toHaveLength(3);
	});
});

describe("title check", () => {
	it.each([
		["B", true],
		["A", false],
		["same", false],
	] as const)("choice %s → %s", async (choice, expected) => {
		install(async () => titleAnswer(choice));
		expect(await newTitleFits(session(), "Fix login bug", "Migrate build to Vite", TURNS)).toBe(expected);
	});

	it("asks the last four exchanges with both titles", async () => {
		install(async () => titleAnswer("B"));
		const turns = Array.from({ length: 6 }, (_, index) => ({ user: `u${index}`, assistant: `a${index}` }));
		await newTitleFits(session(), "Old", "New", turns);
		const request = judge.requests[0] as {
			state: { recentTurns: Array<{ user: string }>; titleA: string; titleB: string };
			questions: { better: { type: string } };
		};
		expect(request.state.recentTurns.map(turn => turn.user)).toEqual(["u2", "u3", "u4", "u5"]);
		expect([request.state.titleA, request.state.titleB]).toEqual(["Old", "New"]);
		expect(request.questions.better.type).toBe("choice");
	});
});

describe("title turns are read lazily", () => {
	it("never builds them while the judge is off or not native, and builds them once when it asks", async () => {
		const turns = vi.fn(() => TURNS);
		install(async () => titleAnswer("B"));
		setJudgeAssistEnabled(false);
		expect(await newTitleFits(session(), "A", "B", turns)).toBeUndefined();
		setJudgeAssistEnabled(true);
		judge.native.current = false;
		expect(await newTitleFits(session(), "A", "B", turns)).toBeUndefined();
		expect(turns).not.toHaveBeenCalled();
		judge.native.current = true;
		expect(await newTitleFits(session(), "A", "B", turns)).toBe(true);
		expect(turns).toHaveBeenCalledTimes(1);
	});
});

describe("preview check", () => {
	it.each([
		["error at the threshold", PREVIEW_ERROR_MIN, 0, { problem: "error", judged: true }],
		["error just under it", PREVIEW_ERROR_MIN - 0.01, 0, { problem: null, judged: true }],
		["blank at the threshold", 0.1, PREVIEW_BLANK_MIN, { problem: "blank", judged: true }],
		["blank just under it", 0.1, PREVIEW_BLANK_MIN - 0.01, { problem: null, judged: true }],
		["both: the error wins", 0.9, 0.9, { problem: "error", judged: true }],
	] as const)("%s", async (_label, error, empty, expected) => {
		install(async () => previewAnswer(error, empty));
		expect(await previewProblem(session(), IMAGE)).toEqual(expected);
	});

	it("judges nothing when the native judge's primary model takes no images (a chat model would see the picture)", async () => {
		install(async () => previewAnswer(0.9, 0));
		judge.takesImages.current = false;
		const before = judgeAssistState().requests;
		expect(await previewProblem(session(), IMAGE)).toEqual({ problem: null, judged: false });
		expect(judge.requests).toEqual([]);
		expect(judgeAssistState().requests).toBe(before);
	});

	it("judges nothing when stock names no primary model", async () => {
		install(async () => previewAnswer(0.9, 0));
		judge.stock.resolveJudge = () => ({ judge: async () => ({ answers: previewAnswer(0.9, 0) }) });
		expect(await previewProblem(session(), IMAGE)).toEqual({ problem: null, judged: false });
	});

	it("sends the capture as an image with the two questions", async () => {
		install(async () => previewAnswer(0, 0));
		await previewProblem(session(), IMAGE);
		const request = judge.requests[0] as { images: unknown[]; questions: Record<string, unknown> };
		expect(request.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		expect(Object.keys(request.questions)).toEqual(["error", "empty"]);
	});
});

describe("transcript readers", () => {
	const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

	it("reads the last four exchanges from the tail, each user message with the last reply that followed it", () => {
		const messages = Array.from({ length: 6 }, (_, index) => [
			{ role: "user", content: `u${index}` },
			reply(`first ${index}`),
			{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
			{ role: "toolResult", content: [] },
			reply(`last ${index}`),
		]).flat();
		expect(recentTitleTurns(messages)).toEqual([
			{ user: "u2", assistant: "last 2" },
			{ user: "u3", assistant: "last 3" },
			{ user: "u4", assistant: "last 4" },
			{ user: "u5", assistant: "last 5" },
		]);
		expect(recentTitleTurns([reply("orphan"), { role: "user", content: "only" }])).toEqual([
			{ user: "only", assistant: "" },
		]);
		expect(recentTitleTurns([])).toEqual([]);
	});

	it("takes the last assistant text of the current turn, skipping tool-only messages and results", () => {
		const messages = [
			{ role: "user", content: "go" },
			reply("Working."),
			{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
			{ role: "toolResult", content: [] },
		];
		expect(lastReplyText(messages)).toBe("Working.");
	});

	it("is empty when the user spoke last or there is no reply", () => {
		expect(lastReplyText([reply("Done."), { role: "user", content: "next" }])).toBe("");
		expect(lastReplyText([])).toBe("");
	});
});

describe("judgeAvailable", () => {
	it("is false with no stock loader, with the switch off, or while the judge role is not native", async () => {
		setJudgeAssistStockLoader(undefined);
		expect(await judgeAvailable(session())).toBe(false);
		install(async () => needsAnswer(1));
		setJudgeAssistEnabled(false);
		expect(await judgeAvailable(session())).toBe(false);
		setJudgeAssistEnabled(true);
		judge.native.current = false;
		expect(await judgeAvailable(session())).toBe(false);
	});

	it("is false when stock fails to load or its check throws", async () => {
		setJudgeAssistStockLoader(async () => {
			throw new Error("module missing");
		});
		expect(await judgeAvailable(session())).toBe(false);
		install(async () => needsAnswer(1));
		judge.stock.hasNativeJudge = () => {
			throw new Error("registry gone");
		};
		expect(await judgeAvailable(session())).toBe(false);
	});

	it("is true while the judge role is native, and makes no model request", async () => {
		install(async () => needsAnswer(1));
		expect(await judgeAvailable(session())).toBe(true);
		expect(judge.deps).toEqual([]);
		expect(judge.requests).toEqual([]);
	});
});

describe("judgeAvailable for images", () => {
	it("needs a native judge whose primary model takes images, and makes no model request", async () => {
		install(async () => needsAnswer(1));
		expect(await judgeAvailable(session(), true)).toBe(true);
		judge.takesImages.current = false;
		expect(await judgeAvailable(session(), true)).toBe(false);
		// Text judgments only need a native judge.
		expect(await judgeAvailable(session())).toBe(true);
		judge.takesImages.current = true;
		judge.native.current = false;
		expect(await judgeAvailable(session(), true)).toBe(false);
		expect(judge.requests).toEqual([]);
	});

	it("is false with the switch off or when stock throws", async () => {
		install(async () => needsAnswer(1));
		judge.stock.nativeJudgmentImageBounds = () => {
			throw new Error("pi-ai changed");
		};
		expect(await judgeAvailable(session(), true)).toBe(false);
		setJudgeAssistEnabled(false);
		expect(await judgeAvailable(session(), true)).toBe(false);
	});
});

describe("session needs-user", () => {
	const asking = [
		{ role: "user", content: "fix it" },
		{ role: "assistant", content: [{ type: "text", text: "Which one do you want?" }] },
	];
	const live = (messages: unknown[] = asking) => ({ ...session(), messages });

	it("judges the last reply of the session", async () => {
		install(async () => needsAnswer(0.9));
		expect(await sessionNeedsUser(live())).toBe(true);
	});

	it("answers null without asking once the next turn started (a follow-up or goal continuation is last)", async () => {
		install(async () => needsAnswer(0.9));
		expect(await sessionNeedsUser(live([...asking, { role: "user", content: "and the tests" }]))).toBeNull();
		expect(judge.requests).toEqual([]);
	});

	it("answers null when the judge does not decide, or there is no reply", async () => {
		install(async () => needsAnswer(0.9));
		judge.native.current = false;
		expect(await sessionNeedsUser(live())).toBeNull();
		expect(await sessionNeedsUser(live([]))).toBeNull();
	});
});

describe("bridge method params", () => {
	it("names the contract's methods", () => {
		expect([JUDGE_ASSIST_SET, JUDGE_ASSIST_NEEDS_USER, JUDGE_ASSIST_AVAILABLE, JUDGE_ASSIST_PREVIEW_CHECK]).toEqual([
			"judge_assist_set",
			"judge_assist.needs_user",
			"judge_assist.available",
			"judge_assist.preview_check",
		]);
	});

	it("judge_assist_set takes a boolean only, and answers the state", () => {
		for (const params of [{ enabled: "yes" }, { enabled: 1 }, { enabled: null }, {}, null, "on"]) {
			expect(() => applyJudgeAssistSet(params)).toThrow("judge_assist_set needs {enabled: boolean}");
		}
		expect(judgeAssistState().enabled).toBe(true);
		expect(applyJudgeAssistSet({ enabled: false })).toEqual({
			enabled: false,
			requests: judgeAssistState().requests,
		});
		expect(judgeAssistState().enabled).toBe(false);
		expect(applyJudgeAssistSet({ enabled: true }).enabled).toBe(true);
	});

	it("judge_assist.preview_check takes a capture with its data and mime type only", () => {
		for (const params of [
			{},
			{ image: {} },
			{ image: { data: "", mimeType: "image/png" } },
			{ image: { data: "AA" } },
			{ image: { data: 1, mimeType: "image/png" } },
			null,
		]) {
			expect(() => previewImageParam(params)).toThrow("judge_assist.preview_check needs {image: {data, mimeType}}");
		}
		expect(previewImageParam({ image: IMAGE })).toEqual(IMAGE);
	});
});
