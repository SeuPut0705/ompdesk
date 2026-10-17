import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TITLE_TRIGGER } from "../../resources/gui-bridge/modes/auto-title-contracts";
import { DEFAULT_GATE_RULES, titleIsAuto } from "../../resources/gui-bridge/modes/auto-title-core";
import {
	type AutoTitleEnv,
	type AutoTitleFrame,
	type AutoTitleStock,
	deliverAutoTitleEvent,
	handlers,
	regenerate,
	resetAutoTitleState,
	setAutoTitleStock,
	type TitleEvent,
	type TitleModel,
	type TitleSession,
} from "../../resources/gui-bridge/modes/auto-title-engine";
import { methods as replyLanguage } from "../../resources/gui-bridge/modes/reply-language";

interface Entry {
	type: "title_change";
	title: string;
	source: string;
	trigger?: string;
}

/** A session that behaves like stock's for what the engine reads: the title source rules, the revision counter, the journal. */
function build(
	options: {
		cards?: boolean;
		name?: string;
		source?: "auto" | "user";
		titlePrompt?: string;
		noDefaultKey?: boolean;
	} = {},
) {
	const entries: Entry[] = [];
	let name = options.name;
	let source: "auto" | "user" | undefined = options.name ? (options.source ?? "auto") : undefined;
	let titlePrompt = options.titlePrompt;
	let revision = 0;
	if (name && source) entries.push({ type: "title_change", title: name, source });
	const listeners: Array<(event: TitleEvent) => void> = [];
	const script = {
		/** What `generateTitle` answers (the title model). */
		generate: vi.fn(async (_text: string): Promise<string | null> => "Fix login bug"),
		/** What the retry model answers (the engine's one shorter retry, through `completeSimple`). */
		shorter: vi.fn(async (_input: string, _system: string): Promise<string | null> => null),
		/** The model each retry ran on. */
		retryModels: [] as string[],
		/** What `renameTitle()` without a title answers (a retitle from the conversation). */
		retitle: vi.fn(async (): Promise<string | null | undefined> => "Migrate build to Vite"),
		/** Runs while a title request is in flight. */
		during: undefined as undefined | (() => void),
		/** The title prompt override each title-model request ran with. */
		prompts: [] as Array<string | undefined>,
	};
	const manager = {
		getSessionId: () => "s1",
		getSessionName: () => name,
		get titleSource() {
			return source;
		},
		get titleRevision() {
			return revision;
		},
		getEntries: () => entries,
		setSessionName: vi.fn(async (next: string, from: "auto" | "user", trigger?: string) => {
			if (source === "user" && from === "auto") return false;
			name = next;
			source = from;
			if (from === "user") revision++;
			entries.push({ type: "title_change", title: next, source: from, ...(trigger ? { trigger } : {}) });
			return true;
		}),
	};
	const session = {
		sessionManager: manager,
		get sessionName() {
			return name;
		},
		sessionId: "s1",
		// What the fake stock `titleIcons` reads: OMPdesk holds `boring`, `cards` stands for icons the person chose.
		// `defaultRole` is what the fake `roleCandidatePool("default")` resolves to.
		settings: {
			icons: options.cards === false ? "boring" : "emoji",
			defaultRole: [{ provider: "anthropic", id: "default-model" }],
		},
		model: { provider: "anthropic", id: "session-model" },
		modelRegistry: {
			getApiKey: vi.fn(async (model: TitleModel) =>
				options.noDefaultKey && model.id === "default-model" ? undefined : "key",
			),
			// The fake `completeSimple` calls what the resolver hands it, so each world answers its own retries.
			resolver: (model: TitleModel) => async (context: FakeContext) => {
				script.retryModels.push(`${model.provider}/${model.id}`);
				const answer = await script.shorter(context.messages[0]?.content ?? "", context.systemPrompt[0] ?? "");
				return { content: [{ type: "text", text: answer === null ? "<title/>" : `<title>${answer}</title>` }] };
			},
		},
		generateTitle: vi.fn(async (text: string) => {
			script.prompts.push(titlePrompt);
			const title = await script.generate(text);
			script.during?.();
			return title;
		}),
		// Stock's `renameTitle`: a typed title needs a card unless icons are boring; a request that asks a model
		// reserves a revision first.
		renameTitle: vi.fn(async (title?: string) => {
			if (title && options.cards === false) return title;
			revision++;
			if (title) return `🐛 ${title}`;
			script.prompts.push(titlePrompt);
			const next = await script.retitle();
			script.during?.();
			return next;
		}),
		subscribe: vi.fn((listener: (event: TitleEvent) => void) => {
			listeners.push(listener);
			return () => {};
		}),
		get titleSystemPrompt() {
			return titlePrompt;
		},
		setTitleSystemPrompt: vi.fn((next: string | undefined) => {
			titlePrompt = next;
		}),
	};
	return { session: session as unknown as TitleSession & typeof session, manager, script, entries, listeners };
}

const operator = (text: string) => ({ role: "user", attribution: "user", content: text });

interface FakeContext {
	systemPrompt: string[];
	messages: Array<{ content: string }>;
}

const isFakeContext = (value: unknown): value is FakeContext =>
	typeof value === "object" && value !== null && "systemPrompt" in value && "messages" in value;

const stock: AutoTitleStock = {
	operatorTitleText: (message: never) => {
		const m = message as { role?: string; attribution?: string; content?: string };
		return m.role === "user" && m.attribution === "user" ? m.content : undefined;
	},
	titleSystemPrompt: "STOCK TITLE PROMPT\n",
	// Stock's card form, `<icon> <CODE>: <title>` (utils/title-card.ts).
	splitCardTitle: title => {
		const line = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u.exec(title);
		return line ? { icon: line[1] ?? "", code: line[2] ?? "", title: line[3] ?? "" } : undefined;
	},
	formatCardTitle: (card, title) => `${card.icon} ${card.code}: ${title}`,
	titleIcons: settings =>
		settings && typeof settings === "object" && "icons" in settings ? String(settings.icons) : "nf+emoji",
	log: () => {},
	roleCandidatePool: (role: string, settings: unknown) =>
		role === "default" &&
		typeof settings === "object" &&
		settings !== null &&
		"defaultRole" in settings &&
		Array.isArray(settings.defaultRole)
			? settings.defaultRole
			: [],
	resolveRoleChain: (_role: string, _settings: unknown, pool: unknown) =>
		Array.isArray(pool) ? pool.map(model => ({ model })) : [],
	completeSimple: async (_model: unknown, context: unknown, options: unknown) => {
		if (!isFakeContext(context) || typeof options !== "object" || options === null || !("apiKey" in options))
			throw new Error("unexpected completeSimple call");
		const answer = options.apiKey;
		if (typeof answer !== "function") throw new Error("no fake resolver");
		return answer(context);
	},
	normalizeGeneratedTitle: value => {
		const title = value.trim();
		return title && !/^<title\s*\/>$/i.test(title) ? title : null;
	},
};

/** Every fake settles at once, so the engine's background work finishes within a few microtask turns. */
const flush = async () => {
	for (let i = 0; i < 100; i++) await Promise.resolve();
};

let now = 0;
let frames: AutoTitleFrame[];
const envFor = (session: unknown): AutoTitleEnv => ({
	session: () => session,
	emit: (event: AutoTitleFrame) => frames.push(event),
});

/** The bridge hands the engine the live session and the switches (what main sends on connect). */
async function attach(
	session: unknown,
	params: Record<string, unknown> = { enabled: true, evolve: true, suppressed: false },
) {
	return handlers.auto_title_set(params, envFor(session));
}

const send = (session: TitleSession, event: TitleEvent) => deliverAutoTitleEvent(event, session);
const turn = async (session: TitleSession, ...tools: string[]) => {
	for (const toolName of tools) await send(session, { type: "tool_execution_end", toolName });
	now += DEFAULT_GATE_RULES.minIntervalMs;
	await send(session, { type: "agent_end", isTerminal: true });
	await flush();
};

beforeEach(() => {
	now = 0;
	frames = [];
	resetAutoTitleState(undefined, () => now);
	setAutoTitleStock(stock);
});

afterEach(async () => {
	resetAutoTitleState();
	setAutoTitleStock(undefined);
	await replyLanguage.reply_language_set({ language: null });
});

describe("first title", () => {
	it("names an unnamed session from the operator's first message with the title model, then a card, and tells the GUI", async () => {
		const world = build();
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("fix the login bug") });
		await flush();
		expect(world.script.generate).toHaveBeenCalledExactlyOnceWith("fix the login bug");
		expect(world.session.renameTitle).toHaveBeenCalledExactlyOnceWith("Fix login bug");
		expect(world.manager.setSessionName).toHaveBeenCalledExactlyOnceWith("🐛 Fix login bug", "auto", TITLE_TRIGGER);
		expect(frames).toEqual([{ type: "session_info_update", title: "🐛 Fix login bug", sessionId: "s1" }]);
		expect(titleIsAuto("🐛 Fix login bug", world.manager.titleSource, world.entries)).toBe(true);
	});

	it("subscribes once however often the switches are pushed", async () => {
		const world = build();
		await attach(world.session);
		await attach(world.session, { enabled: true, evolve: false, suppressed: false });
		expect(world.session.subscribe).toHaveBeenCalledTimes(1);
	});

	it("ignores agent-attributed and assistant messages", async () => {
		const world = build();
		await attach(world.session);
		await send(world.session, { type: "message_end", message: { role: "assistant", content: "hello" } });
		await send(world.session, { type: "message_end", message: { role: "user", attribution: "agent", content: "x" } });
		await flush();
		expect(world.script.generate).not.toHaveBeenCalled();
	});

	it("never replaces a name that is already there, typed or generated", async () => {
		for (const source of ["user", "auto"] as const) {
			const world = build({ name: "Existing", source });
			await attach(world.session);
			await send(world.session, { type: "message_end", message: operator("something else entirely") });
			await flush();
			expect(world.script.generate).not.toHaveBeenCalled();
			expect(world.manager.setSessionName).not.toHaveBeenCalled();
		}
	});

	it("does nothing when the pref is off or the user's environment suppresses titles", async () => {
		for (const params of [
			{ enabled: false, evolve: true, suppressed: false },
			{ enabled: true, evolve: true, suppressed: true },
		]) {
			const world = build();
			await attach(world.session, params);
			await send(world.session, { type: "message_end", message: operator("fix the login bug") });
			await send(world.session, { type: "agent_end", isTerminal: true });
			await flush();
			expect(world.script.generate).not.toHaveBeenCalled();
			expect(world.session.renameTitle).not.toHaveBeenCalled();
		}
	});

	it("follows the switch live: off keeps a prompt untitled, and turned on the next prompt names the session", async () => {
		const world = build();
		await attach(world.session, { enabled: false, evolve: true, suppressed: false });
		await send(world.session, { type: "message_end", message: operator("fix the login bug") });
		await send(world.session, { type: "agent_end", isTerminal: true });
		await flush();
		expect(world.manager.setSessionName).not.toHaveBeenCalled();
		// Settings turned it on: main re-attaches the session with the new switches (sidecar.syncAutoTitle).
		await attach(world.session, { enabled: true, evolve: true, suppressed: false });
		await send(world.session, { type: "message_end", message: operator("add a logout button") });
		await flush();
		expect(world.script.generate).toHaveBeenCalledTimes(1);
		expect(world.manager.setSessionName).toHaveBeenCalledTimes(1);
	});

	it("leaves the title plain when icons are boring (no card request)", async () => {
		const world = build({ cards: false });
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("fix the login bug") });
		await flush();
		expect(world.manager.setSessionName).toHaveBeenCalledExactlyOnceWith("Fix login bug", "auto", TITLE_TRIGGER);
	});

	it("does not apply a title when the person typed a name while it was generated", async () => {
		const world = build();
		await attach(world.session);
		world.script.during = () => void world.manager.setSessionName("Typed by me", "user");
		await send(world.session, { type: "message_end", message: operator("fix the login bug") });
		await flush();
		expect(world.manager.getSessionName()).toBe("Typed by me");
		expect(world.manager.setSessionName).toHaveBeenCalledTimes(1);
	});

	it("names a session the title model declined (a greeting) from the conversation once the turn ends", async () => {
		const world = build();
		world.script.generate.mockResolvedValue(null);
		world.script.retitle.mockResolvedValue("Plan the API");
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("hi") });
		await flush();
		expect(world.manager.setSessionName).not.toHaveBeenCalled();
		await send(world.session, { type: "agent_end", isTerminal: true });
		await flush();
		expect(world.manager.setSessionName).toHaveBeenCalledExactlyOnceWith("Plan the API", "auto", TITLE_TRIGGER);
	});

	it("never writes a title the model wrote as UTF-8 read as Windows-1252 (mojibake)", async () => {
		const garbled = (value: string) => new TextDecoder("windows-1252").decode(new TextEncoder().encode(value));
		const world = build();
		world.script.generate.mockResolvedValue(garbled("로그인 버그 수정"));
		world.script.retitle.mockResolvedValue(garbled("빌드 도구 이전"));
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("로그인 버그 고쳐줘") });
		await flush();
		await send(world.session, { type: "agent_end", isTerminal: true });
		await flush();
		expect(world.session.renameTitle).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(world.manager.setSessionName).not.toHaveBeenCalled();
		expect(frames).toEqual([]);
	});

	it("waits for the final settle: a continuation's agent_end names nothing", async () => {
		const world = build();
		world.script.generate.mockResolvedValue(null);
		await attach(world.session);
		await send(world.session, { type: "agent_end", isTerminal: false });
		await flush();
		expect(world.session.renameTitle).not.toHaveBeenCalled();
	});

	it("runs one request at a time and survives a failing title model", async () => {
		const world = build();
		world.script.generate.mockRejectedValue(new Error("offline"));
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("fix the login bug") });
		await send(world.session, { type: "message_end", message: operator("and the logout bug") });
		await flush();
		expect(world.script.generate).toHaveBeenCalledTimes(1);
		expect(world.manager.setSessionName).not.toHaveBeenCalled();
		// The next message tries again once the first settled.
		world.script.generate.mockResolvedValue("Fix auth bugs");
		await send(world.session, { type: "message_end", message: operator("and the logout bug") });
		await flush();
		expect(world.manager.getSessionName()).toBe("🐛 Fix auth bugs");
	});
});

describe("evolving title", () => {
	it("re-titles an automatic title after the work moved, applying a changed topic", async () => {
		const world = build({ name: "🐛 Fix login bug", source: "auto" });
		await attach(world.session);
		await turn(world.session, "edit");
		expect(world.session.renameTitle).not.toHaveBeenCalled();
		await turn(world.session, "edit", "write");
		expect(world.session.renameTitle).toHaveBeenCalledTimes(1);
		expect(world.session.renameTitle).toHaveBeenCalledWith(undefined);
		expect(world.manager.getSessionName()).toBe("Migrate build to Vite");
		expect(world.manager.setSessionName).toHaveBeenLastCalledWith("Migrate build to Vite", "auto", TITLE_TRIGGER);
		expect(frames.at(-1)).toEqual({ type: "session_info_update", title: "Migrate build to Vite", sessionId: "s1" });
	});

	it("keeps the title when the new one only rewords it", async () => {
		const world = build({ name: "Fix the login bug", source: "auto" });
		world.script.retitle.mockResolvedValue("fix login bug");
		await attach(world.session);
		await turn(world.session, "edit");
		await turn(world.session, "edit", "edit");
		expect(world.session.renameTitle).toHaveBeenCalledTimes(1);
		expect(world.manager.setSessionName).not.toHaveBeenCalled();
		expect(frames).toEqual([]);
	});

	it("asks at most once per window: the next turns wait for new work", async () => {
		const world = build({ name: "Fix login bug", source: "auto" });
		await attach(world.session);
		await turn(world.session, "edit");
		await turn(world.session, "edit", "edit");
		expect(world.session.renameTitle).toHaveBeenCalledTimes(1);
		await turn(world.session);
		await turn(world.session);
		expect(world.session.renameTitle).toHaveBeenCalledTimes(1);
	});

	it("never starts mid-turn: only a terminal agent_end counts", async () => {
		const world = build({ name: "Fix login bug", source: "auto" });
		await attach(world.session);
		for (let i = 0; i < 4; i++) {
			await send(world.session, { type: "tool_execution_end", toolName: "edit" });
			now += DEFAULT_GATE_RULES.minIntervalMs;
			await send(world.session, { type: "agent_end", isTerminal: false });
		}
		await flush();
		expect(world.session.renameTitle).not.toHaveBeenCalled();
	});

	it("never touches a title the person typed, however much work happens", async () => {
		const world = build({ name: "My own name", source: "user" });
		await attach(world.session);
		for (let i = 0; i < 4; i++) await turn(world.session, "edit", "edit", "edit");
		expect(world.session.renameTitle).not.toHaveBeenCalled();
		expect(world.manager.setSessionName).not.toHaveBeenCalled();
	});

	it("stops evolving the moment the person types over an automatic title", async () => {
		const world = build({ name: "Fix login bug", source: "auto" });
		await attach(world.session);
		await turn(world.session, "edit");
		await world.manager.setSessionName("Typed", "user");
		await turn(world.session, "edit", "edit", "edit");
		expect(world.session.renameTitle).not.toHaveBeenCalled();
		expect(world.manager.getSessionName()).toBe("Typed");
	});

	it("drops a result when the person typed while it was generated", async () => {
		const world = build({ name: "Fix login bug", source: "auto" });
		await attach(world.session);
		world.script.during = () => void world.manager.setSessionName("Typed mid-flight", "user");
		await turn(world.session, "edit");
		await turn(world.session, "edit", "edit");
		expect(world.manager.getSessionName()).toBe("Typed mid-flight");
		expect(world.manager.setSessionName).toHaveBeenCalledTimes(1);
	});

	it("is off while the sub-switch is off, and resumes when it is turned on", async () => {
		const world = build({ name: "Fix login bug", source: "auto" });
		await attach(world.session, { enabled: true, evolve: false, suppressed: false });
		await turn(world.session, "edit", "edit", "edit");
		await turn(world.session, "edit", "edit", "edit");
		expect(world.session.renameTitle).not.toHaveBeenCalled();
		await attach(world.session, { enabled: true, evolve: true, suppressed: false });
		await turn(world.session, "edit", "edit", "edit");
		await turn(world.session, "edit", "edit", "edit");
		expect(world.session.renameTitle).toHaveBeenCalled();
	});

	it("considers a quiet session after the force window", async () => {
		const world = build({ name: "Fix login bug", source: "auto" });
		await attach(world.session);
		for (let i = 0; i < DEFAULT_GATE_RULES.forceTurns - 1; i++) await turn(world.session);
		expect(world.session.renameTitle).not.toHaveBeenCalled();
		await turn(world.session);
		expect(world.session.renameTitle).toHaveBeenCalledTimes(1);
	});
});

describe("regenerate_title (the editor's auto button)", () => {
	it("saves a fresh automatic title over an automatic one", async () => {
		const world = build({ name: "Fix login bug", source: "auto" });
		await attach(world.session);
		const result = await handlers.regenerate_title({}, envFor(world.session));
		expect(result).toEqual({ title: "Migrate build to Vite" });
		expect(world.manager.setSessionName).toHaveBeenLastCalledWith("Migrate build to Vite", "auto", TITLE_TRIGGER);
		expect(frames.at(-1)).toEqual({ type: "session_info_update", title: "Migrate build to Vite", sessionId: "s1" });
	});

	it("makes a typed title automatic again: it evolves from then on, and typing stops it again", async () => {
		const world = build({ name: "My own name", source: "user" });
		await attach(world.session);
		expect(titleIsAuto("My own name", "user", world.entries)).toBe(false);
		const result = await handlers.regenerate_title({}, envFor(world.session));
		expect(result).toEqual({ title: "Migrate build to Vite" });
		// Stock refuses "auto" over a typed name, so the write is source "user" with the bridge's stamp.
		expect(world.manager.setSessionName).toHaveBeenLastCalledWith("Migrate build to Vite", "user", TITLE_TRIGGER);
		expect(titleIsAuto("Migrate build to Vite", "user", world.entries)).toBe(true);

		world.script.retitle.mockResolvedValue("Ship the release notes");
		await turn(world.session, "edit");
		await turn(world.session, "edit", "edit");
		expect(world.manager.getSessionName()).toBe("Ship the release notes");

		await world.manager.setSessionName("Typed again", "user");
		world.script.retitle.mockResolvedValue("Something else");
		await turn(world.session, "edit", "edit", "edit");
		await turn(world.session, "edit", "edit", "edit");
		expect(world.manager.getSessionName()).toBe("Typed again");
	});

	it("reports why there is no title, and writes nothing", async () => {
		const world = build({ name: "Keep me", source: "user" });
		world.script.retitle.mockResolvedValueOnce(null);
		expect(await regenerate(world.session)).toEqual({ title: null, reason: "none" });
		world.script.retitle.mockResolvedValueOnce(undefined);
		expect(await regenerate(world.session)).toEqual({ title: null, reason: "superseded" });
		expect(world.manager.setSessionName).not.toHaveBeenCalled();
		expect(world.manager.getSessionName()).toBe("Keep me");
	});

	it("does not overwrite a name the person typed while it was generating", async () => {
		const world = build({ name: "Keep me", source: "user" });
		world.script.during = () => void world.manager.setSessionName("Typed meanwhile", "user");
		expect(await regenerate(world.session)).toEqual({ title: null, reason: "superseded" });
		expect(world.manager.getSessionName()).toBe("Typed meanwhile");
	});

	it("works with the pref off: it is the person's own request", async () => {
		const world = build();
		await attach(world.session, { enabled: false, evolve: false, suppressed: true });
		expect(await handlers.regenerate_title({}, envFor(world.session))).toEqual({ title: "Migrate build to Vite" });
	});

	it("propagates a failing title model so the button can say so", async () => {
		const world = build({ name: "Keep me", source: "user" });
		world.script.retitle.mockRejectedValue(new Error("title model unavailable"));
		await expect(handlers.regenerate_title({}, envFor(world.session))).rejects.toThrow("title model unavailable");
	});
});

describe("auto_title_set", () => {
	it("refuses a malformed payload rather than reading it as on", async () => {
		const world = build();
		await expect(attach(world.session, { enabled: "yes", evolve: true })).rejects.toThrow("auto_title_set");
		await expect(handlers.auto_title_set(null, envFor(world.session))).rejects.toThrow("auto_title_set");
	});

	it("reports the switches and how many title-model requests this omp made", async () => {
		const world = build();
		expect(await attach(world.session)).toEqual({ enabled: true, evolve: true, suppressed: false, requests: 0 });
		await send(world.session, { type: "message_end", message: operator("fix the login bug") });
		await flush();
		// The title, then its card.
		expect(await attach(world.session)).toMatchObject({ requests: 2 });
	});
});

describe("title language and length", () => {
	const korean = `STOCK TITLE PROMPT\n\nLanguage, length and form`;

	it("gives every title path stock's prompt plus the line, follows reply_language_set, and keeps the length rule when off or English", async () => {
		await replyLanguage.reply_language_set({ language: "Korean" });
		const world = build();
		await attach(world.session);
		expect(world.session.titleSystemPrompt).toMatch(new RegExp(`^${korean}.*write it in Korean\\.`, "s"));

		await replyLanguage.reply_language_set({ language: "Japanese" });
		expect(world.session.titleSystemPrompt).toContain("write it in Japanese.");
		await send(world.session, { type: "message_end", message: operator("fix the login bug") });
		await flush();
		expect(world.script.prompts[0]).toContain("write it in Japanese.");

		for (const language of [null, "English", ""]) {
			await replyLanguage.reply_language_set({ language: "Korean" });
			await replyLanguage.reply_language_set({ language });
			expect(world.session.titleSystemPrompt).toMatch(new RegExp(`^${korean}`));
			expect(world.session.titleSystemPrompt).toContain("the language the user writes in");
			expect(world.session.titleSystemPrompt).not.toContain("write it in");
		}
		expect(await regenerate(world.session)).toEqual({ title: "Migrate build to Vite" });
		expect(world.script.prompts.at(-1)).toMatch(new RegExp(`^${korean}`));
	});

	it("puts the line back before a request when stock re-resolved the slot (a headless move)", async () => {
		await replyLanguage.reply_language_set({ language: "Korean" });
		const world = build();
		await attach(world.session);
		world.session.setTitleSystemPrompt(undefined);
		await send(world.session, { type: "message_end", message: operator("fix the login bug") });
		await flush();
		expect(world.script.prompts[0]).toContain("write it in Korean.");
	});

	it("leaves a person's own TITLE_SYSTEM.md as written and does not cut its titles", async () => {
		await replyLanguage.reply_language_set({ language: "Korean" });
		const world = build({ titlePrompt: "MY TITLE RULES", cards: false });
		world.script.generate.mockResolvedValue("Add support for the dark mode toggle");
		await attach(world.session);
		await replyLanguage.reply_language_set({ language: "Japanese" });
		expect(world.session.setTitleSystemPrompt).not.toHaveBeenCalled();
		await send(world.session, { type: "message_end", message: operator("add dark mode") });
		await flush();
		expect(world.script.prompts).toEqual(["MY TITLE RULES"]);
		expect(world.manager.getSessionName()).toBe("Add support for the dark mode toggle");
	});

	it("retries a title past the limits once on the default role's model, never the title chain, and keeps the shorter answer", async () => {
		await replyLanguage.reply_language_set({ language: "Korean" });
		const world = build({ cards: false });
		world.script.generate.mockResolvedValue("작업 현황판 화면 디자인");
		world.script.shorter.mockResolvedValue("현황판 디자인");
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("작업 현황판 디자인을 바꾸고 싶어") });
		await flush();
		expect(world.script.shorter).toHaveBeenCalledExactlyOnceWith(
			"작업 현황판 디자인을 바꾸고 싶어",
			expect.any(String),
		);
		const retryPrompt = world.script.shorter.mock.calls[0]?.[1] ?? "";
		expect(retryPrompt.startsWith(world.session.titleSystemPrompt ?? "-")).toBe(true);
		expect(retryPrompt).toContain('Shorter: the title "작업 현황판 화면 디자인" is too long');
		expect(retryPrompt).toContain("Keep the subject and the head noun");
		expect(world.script.retryModels).toEqual(["anthropic/default-model"]);
		// The first pass stays on the cheap title chain.
		expect(world.script.generate).toHaveBeenCalledTimes(1);
		expect(world.manager.getSessionName()).toBe("현황판 디자인");
		// The title, its retry, and the (cardless) rename.
		expect(await attach(world.session)).toMatchObject({ requests: 3 });
	});

	it("runs the retry on the session's model when the default role has no credentials", async () => {
		const world = build({ cards: false, noDefaultKey: true });
		world.script.generate.mockResolvedValue("Dark mode toggle support added");
		world.script.shorter.mockResolvedValue("Dark mode toggle");
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("add dark mode") });
		await flush();
		expect(world.script.retryModels).toEqual(["anthropic/session-model"]);
		expect(world.manager.getSessionName()).toBe("Dark mode toggle");
	});

	it("prefers the retry when it is as long as the first answer", async () => {
		const world = build({ cards: false });
		world.script.generate.mockResolvedValue("CSV export empty with filters");
		world.script.shorter.mockResolvedValue("Empty CSV export with filters");
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("csv export is empty when filtered") });
		await flush();
		expect(world.manager.getSessionName()).toBe("Empty CSV export with filters");
	});

	it("keeps the answer whole up to the hard cap when the retry is still long, and asks only once", async () => {
		await replyLanguage.reply_language_set({ language: "Korean" });
		const world = build({ cards: false });
		world.script.generate.mockResolvedValue("작업 현황판 화면 디자인");
		world.script.shorter.mockResolvedValue("작업 현황판 화면 디자인 개선");
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("작업 현황판 디자인을 바꾸고 싶어") });
		await flush();
		expect(world.script.shorter).toHaveBeenCalledTimes(1);
		// The head noun stays: no cut from the end.
		expect(world.manager.getSessionName()).toBe("작업 현황판 화면 디자인");
	});

	it("past the hard cap drops generic words, then leading ones in Korean, so the head noun stays", async () => {
		await replyLanguage.reply_language_set({ language: "Korean" });
		const world = build({ cards: false });
		world.script.generate.mockResolvedValue("로그인 화면 비밀번호 오류 메시지 표시 버그");
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("비밀번호 틀려도 에러가 안 보여") });
		await flush();
		expect(world.manager.getSessionName()).toBe("비밀번호 오류 표시 버그");
	});

	it("keeps the first answer when the retry fails", async () => {
		const world = build({ cards: false });
		world.script.generate.mockResolvedValue("Dark mode toggle support added");
		world.script.shorter.mockRejectedValue(new Error("offline"));
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("add dark mode") });
		await flush();
		expect(world.manager.getSessionName()).toBe("Dark mode toggle support added");
	});

	it("retries a regenerated title from the answer itself (stock built the context), a card the person chose kept", async () => {
		const world = build({ name: "🔑 PWERR: 로그인 오류 수정", source: "auto" });
		world.script.retitle.mockResolvedValue("🔑 PWERR: Dark mode toggle support for settings");
		world.script.shorter.mockResolvedValue("Dark mode toggle");
		await attach(world.session);
		expect(await regenerate(world.session)).toEqual({ title: "🔑 PWERR: Dark mode toggle" });
		expect(world.script.shorter).toHaveBeenCalledExactlyOnceWith(
			"Dark mode toggle support for settings",
			expect.stringContaining('the title "Dark mode toggle support for settings" is too long'),
		);
	});

	it("applies the same rule when the language is off, and never retries a title that fits", async () => {
		const world = build({ cards: false });
		world.script.generate.mockResolvedValue("CSV export empty with filters");
		world.script.shorter.mockResolvedValue("CSV export empty file");
		await attach(world.session);
		await send(world.session, { type: "message_end", message: operator("csv export is empty when filtered") });
		await flush();
		expect(world.manager.getSessionName()).toBe("CSV export empty file");

		const short = build({ cards: false });
		await attach(short.session);
		await send(short.session, { type: "message_end", message: operator("fix the login bug") });
		await flush();
		expect(short.script.shorter).not.toHaveBeenCalled();
		expect(short.manager.getSessionName()).toBe("Fix login bug");
	});
});

describe("plain titles (title.icons: boring)", () => {
	it("drops the card stock's retitle kept from the current title: the auto button and evolving come back plain", async () => {
		const world = build({ name: "🔑 PWERR: 로그인 비밀번호 오류 메시지 버그", source: "auto", cards: false });
		// Stock's `keepTitleCard` heads the fresh title with the current one's card.
		world.script.retitle.mockResolvedValue("🔑 PWERR: 작업 현황판 디자인");
		await attach(world.session);
		expect(await regenerate(world.session)).toEqual({ title: "작업 현황판 디자인" });
		expect(world.manager.getSessionName()).toBe("작업 현황판 디자인");
	});

	it("leaves a stored carded title as it is until a fresh title is made", async () => {
		const world = build({ name: "🔑 PWERR: 로그인 오류", source: "auto", cards: false });
		await attach(world.session);
		expect(world.manager.setSessionName).not.toHaveBeenCalled();
		expect(world.manager.getSessionName()).toBe("🔑 PWERR: 로그인 오류");
	});
});
