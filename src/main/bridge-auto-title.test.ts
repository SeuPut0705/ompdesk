import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TITLE_TRIGGER } from "../../resources/gui-bridge/auto-title-contracts";
import { DEFAULT_GATE_RULES, titleIsAuto } from "../../resources/gui-bridge/auto-title-core";
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
	type TitleSession,
} from "../../resources/gui-bridge/auto-title-engine";

interface Entry {
	type: "title_change";
	title: string;
	source: string;
	trigger?: string;
}

/** A session that behaves like stock's for what the engine reads: the title source rules, the revision counter, the journal. */
function build(options: { cards?: boolean; name?: string; source?: "auto" | "user" } = {}) {
	const entries: Entry[] = [];
	let name = options.name;
	let source: "auto" | "user" | undefined = options.name ? (options.source ?? "auto") : undefined;
	let revision = 0;
	if (name && source) entries.push({ type: "title_change", title: name, source });
	const listeners: Array<(event: TitleEvent) => void> = [];
	const script = {
		/** What `generateTitle` answers (the title model). */
		generate: vi.fn(async (_text: string): Promise<string | null> => "Fix login bug"),
		/** What `renameTitle()` without a title answers (a retitle from the conversation). */
		retitle: vi.fn(async (): Promise<string | null | undefined> => "Migrate build to Vite"),
		/** Runs while a title request is in flight. */
		during: undefined as undefined | (() => void),
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
		generateTitle: vi.fn(async (text: string) => {
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
			const next = await script.retitle();
			script.during?.();
			return next;
		}),
		subscribe: vi.fn((listener: (event: TitleEvent) => void) => {
			listeners.push(listener);
			return () => {};
		}),
	};
	return { session: session as unknown as TitleSession & typeof session, manager, script, entries, listeners };
}

const operator = (text: string) => ({ role: "user", attribution: "user", content: text });
const stock: AutoTitleStock = {
	operatorTitleText: (message: never) => {
		const m = message as { role?: string; attribution?: string; content?: string };
		return m.role === "user" && m.attribution === "user" ? m.content : undefined;
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

afterEach(() => {
	resetAutoTitleState();
	setAutoTitleStock(undefined);
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
