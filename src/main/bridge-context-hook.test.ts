/**
 * gui-bridge context-hook.ts: a `context` filter (the idle recap, the covered xd:// mount notice) leaves the
 * extension's handler table while its session holds nothing to drop, so stock's `emitContext` skips the whole-context
 * `structuredClone` + `Bun.deepEquals` it does before every provider request whenever any `context` handler exists.
 * The fake below is stock's table (`extension.handlers`, `pi.on` appends); bridge-context-hook-stock.test.ts pins it
 * to the installed omp.
 */
import { describe, expect, it } from "vitest";
import { armContextHook, installContextHook } from "../../resources/gui-bridge/context-hook";

/** What `pi.on` stores (stock's typed handlers); called here as stock's runner calls them. */
type Handler = (event: never, ctx: never) => unknown;
type Call = (event: unknown, ctx: unknown) => unknown;
type Message = { role: string; customType?: string };

const DROP = "drop-me";

function fakePi(options: { table?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		...(options.table === false ? {} : { extension: { handlers } }),
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	let branch: Message[] = [];
	const sessionManager = { getBranch: () => branch };
	const ctx = { sessionManager };
	let calls = 0;
	installContextHook(pi, DROP, (event: { messages: Message[] }) => {
		calls++;
		const messages = event.messages.filter(message => message.customType !== DROP);
		return messages.length === event.messages.length ? undefined : { messages };
	});
	return {
		sessionManager,
		setBranch(next: Message[]) {
			branch = next;
		},
		get calls() {
			return calls;
		},
		contextHandlers: () => handlers.get("context") ?? [],
		/** What stock's emitContext does with the handlers present when the request starts. */
		request(messages: Message[]) {
			let current = messages;
			for (const handler of handlers.get("context") ?? []) {
				const result = (handler as Call)({ type: "context", messages: current }, ctx) as
					| { messages?: Message[] }
					| undefined;
				if (result?.messages) current = result.messages;
			}
			return current;
		},
		emit(event: string) {
			for (const handler of handlers.get(event) ?? []) (handler as Call)({ type: event }, ctx);
		},
	};
}

const user: Message = { role: "user" };
const dropped: Message = { role: "custom", customType: DROP };

describe("context hook off the request path while nothing needs dropping", () => {
	it("leaves after a request whose context and branch hold none, and is back for the next prompt", () => {
		const pi = fakePi();
		expect(pi.contextHandlers()).toHaveLength(1);
		expect(pi.request([user])).toEqual([user]);
		expect(pi.contextHandlers()).toHaveLength(0);
		// Tool-loop requests of the same turn: no handler, so stock returns the context uncopied.
		pi.request([user, user]);
		expect(pi.calls).toBe(1);
		pi.emit("before_agent_start");
		expect(pi.contextHandlers()).toHaveLength(1);
		pi.emit("before_agent_start");
		expect(pi.contextHandlers()).toHaveLength(1);
	});

	it("stays and drops while the context holds one", () => {
		const pi = fakePi();
		pi.setBranch([user, dropped]);
		expect(pi.request([user, dropped, user])).toEqual([user, user]);
		expect(pi.request([user, dropped])).toEqual([user]);
		expect(pi.contextHandlers()).toHaveLength(1);
	});

	it("stays while the branch holds one a partial request does not carry (live steering)", () => {
		const pi = fakePi();
		pi.setBranch([user, dropped]);
		pi.request([user]);
		expect(pi.contextHandlers()).toHaveLength(1);
		expect(pi.request([user, dropped])).toEqual([user]);
	});

	it("comes back on a session load or a move in the tree", () => {
		for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
			const pi = fakePi();
			pi.request([user]);
			expect(pi.contextHandlers()).toHaveLength(0);
			pi.emit(event);
			expect(pi.contextHandlers(), event).toHaveLength(1);
		}
	});

	it("comes back for the session the bridge adds one to, and only that one (armContextHook)", () => {
		const main = fakePi();
		const subagent = fakePi();
		main.request([user]);
		subagent.request([user]);
		const release = armContextHook(DROP, main.sessionManager);
		expect(main.contextHandlers()).toHaveLength(1);
		expect(subagent.contextHandlers()).toHaveLength(0);
		// Another message kind's hook is not touched; arming twice registers once.
		armContextHook("other", subagent.sessionManager)();
		armContextHook(DROP, main.sessionManager)();
		release();
		expect(subagent.contextHandlers()).toHaveLength(0);
		expect(main.contextHandlers()).toHaveLength(1);
		main.setBranch([dropped]);
		expect(main.request([user, dropped])).toEqual([user]);
	});

	it("replaces the handler array, so a request already iterating it runs every handler it started with", () => {
		const pi = fakePi();
		const started = pi.contextHandlers();
		pi.request([user]);
		expect(started).toHaveLength(1);
		expect(pi.contextHandlers()).not.toBe(started);
	});

	it("stays on every request on an omp without the handler table", () => {
		const pi = fakePi({ table: false });
		pi.request([user]);
		pi.request([user]);
		expect(pi.calls).toBe(2);
		expect(pi.request([user, dropped])).toEqual([user]);
	});

	it("race: a compaction between before_agent_start and the mount notice's injection keeps the filter for the turn", () => {
		// Stock prepares a prompt as: before_agent_start → runPrePromptCompactionIfNeeded (an emitContext) → the
		// xd:// notice joins the messages → agent.prompt → agent_start. The compaction's context holds no notice yet.
		const pi = fakePi();
		pi.request([user]);
		pi.emit("before_agent_start");
		pi.request([user]);
		expect(pi.contextHandlers()).toHaveLength(1);
		// The run's first request may come before stock's agent_start reaches the extension: the notice still goes.
		expect(pi.request([user, dropped])).toEqual([user]);
		pi.emit("agent_start");
		expect(pi.request([user, dropped])).toEqual([user]);
		// A run whose context holds none leaves after its first request, as before (the 200-tool-call gain).
		pi.emit("before_agent_start");
		pi.emit("agent_start");
		pi.request([user]);
		expect(pi.contextHandlers()).toHaveLength(0);
		pi.request([user, user]);
		expect(pi.calls).toBe(5);
		// A follow-up stock prepares inside a running loop starts no run: its turn_start ends the hold.
		pi.emit("before_agent_start");
		pi.emit("turn_start");
		pi.request([user]);
		expect(pi.contextHandlers()).toHaveLength(0);
	});

	it("race: a side request while the bridge delivers a recap keeps the filter (armContextHook holds it)", () => {
		const pi = fakePi();
		pi.request([user]);
		const release = armContextHook(DROP, pi.sessionManager);
		// An ephemeral turn or idle compaction of the same session runs before the recap is in the branch.
		pi.request([user]);
		expect(pi.contextHandlers()).toHaveLength(1);
		pi.setBranch([user, dropped]);
		release();
		expect(pi.request([user, dropped])).toEqual([user]);
		expect(pi.contextHandlers()).toHaveLength(1);
	});
});
