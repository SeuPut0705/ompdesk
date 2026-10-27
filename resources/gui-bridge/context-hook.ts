/**
 * A `context` hook that drops one kind of message and stays off the request path while the session holds none.
 *
 * Stock's `ExtensionRunner.emitContext` runs before every provider request, and as soon as any extension has a
 * `context` handler it `structuredClone`s the whole context and `Bun.deepEquals` each message against its original,
 * even when every handler returns nothing (measured on omp 18.13.1: a 200-tool-call turn took 2.65 s with the bridge
 * against 1.64 s without it, and that clone and comparison were 1.2 s of the bridge's 1.95 s of extra CPU over two
 * such turns). The messages these hooks drop (the idle recap, a covered xd:// mount notice) are in a few sessions
 * only, so each hook takes itself out of the extension's handler table after a request whose context, and the
 * session's branch, hold none of them, and is put back wherever one can enter: a session load or move in the tree,
 * and the next prompt's `before_agent_start`, from where it may not leave until the run's `agent_start` (stock adds a
 * mount notice after that hook, behind a possible pre-prompt compaction whose context holds no notice yet, and the
 * run's first request can come before `agent_start` reaches the extension); and {@link armContextHook}, which holds it
 * on while the bridge adds one itself (a side request of the session can run before the message is in the branch).
 *
 * The handler table (`pi.extension.handlers`, capability `contextHookIdle`) is an omp internal, read at run time: an
 * omp without it keeps the hook on every request, as before. Removal replaces the table's array, never splices it, so
 * a request iterating the old array runs every handler it started with. No omp imports (not even types): the GUI's
 * vitest installs it on a fake `pi`.
 */

/** The slice of omp's extension context read here (stock's `ExtensionContext.sessionManager`). */
export interface ContextHookContext {
	sessionManager: { getBranch(): readonly unknown[] };
}

/** The slice of omp's ExtensionAPI the hook registers on (stock's typed overloads fit it). */
export interface ContextHookHost {
	on(event: string, handler: (event: never, ctx: never) => unknown): void;
}

/** By `customType`, then by the session's manager: puts that session's hook back (see {@link armContextHook}). */
const armers = new Map<string, WeakMap<object, () => void>>();
/** By `customType`, then by the session's manager: deliveries in flight that hold the hook on (see {@link armContextHook}). */
const holds = new Map<string, WeakMap<object, number>>();

/** The extension's handler table behind `pi.on`, or undefined on an omp (or a fake) without one. */
function handlerTable(pi: ContextHookHost): Map<string, unknown[]> | undefined {
	const extension = "extension" in pi ? pi.extension : undefined;
	const handlers =
		typeof extension === "object" && extension !== null && "handlers" in extension ? extension.handlers : undefined;
	return handlers instanceof Map ? handlers : undefined;
}

function contains(entries: readonly unknown[], customType: string): boolean {
	return entries.some(
		entry => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === customType,
	);
}

function perSession<V>(tables: Map<string, WeakMap<object, V>>, customType: string): WeakMap<object, V> {
	let table = tables.get(customType);
	if (!table) {
		table = new WeakMap();
		tables.set(customType, table);
	}
	return table;
}

/**
 * Puts the `customType` hook of the session `sessionManager` belongs to back on the request path and keeps it there
 * until the returned release: called around the bridge adding such a message outside a prompt (session-recap.ts), so
 * a side request of the session that runs before the message is in the branch cannot take the hook off. Release once
 * the message is in (the branch then keeps the hook) or the add failed.
 */
export function armContextHook(customType: string, sessionManager: object): () => void {
	const held = perSession(holds, customType);
	held.set(sessionManager, (held.get(sessionManager) ?? 0) + 1);
	armers.get(customType)?.get(sessionManager)?.();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const count = (held.get(sessionManager) ?? 1) - 1;
		if (count > 0) held.set(sessionManager, count);
		else held.delete(sessionManager);
	};
}

/**
 * Registers `handler` as a `context` handler of `pi` that runs only while messages of `customType` may be sent.
 * Called once per extension instance (main and every subagent rebinding): each has its own handler table.
 */
export function installContextHook<Event extends { messages: readonly unknown[] }, Ctx extends ContextHookContext, R>(
	pi: ContextHookHost,
	customType: string,
	handler: (event: Event, ctx: Ctx) => R,
): void {
	const table = handlerTable(pi);
	const sessions = perSession(armers, customType);
	const held = perSession(holds, customType);
	let armed = false;
	/**
	 * Between this extension's `before_agent_start` and the next `agent_start` (or `turn_start`: a follow-up stock
	 * prepares inside a running loop starts no run, and gets no mount notice): the hook stays (see the header).
	 */
	let preparing = false;
	const arm = () => {
		if (armed) return;
		armed = true;
		pi.on("context", hook);
	};
	const hook = (event: Event, ctx: Ctx): R => {
		const result = handler(event, ctx);
		// A call may carry part of the context only (stock's live steering transforms just the steering messages):
		// the session's branch says whether the rest holds one.
		const leave =
			table &&
			!preparing &&
			!held.has(ctx.sessionManager) &&
			!contains(event.messages, customType) &&
			!contains(ctx.sessionManager.getBranch(), customType);
		if (leave) {
			const list = table.get("context") ?? [];
			table.set(
				"context",
				list.filter(other => other !== hook),
			);
			armed = false;
			sessions.set(ctx.sessionManager, arm);
		}
		return result;
	};
	arm();
	pi.on("before_agent_start", () => {
		preparing = true;
		arm();
		return undefined;
	});
	pi.on("agent_start", () => {
		preparing = false;
		arm();
	});
	pi.on("turn_start", () => {
		preparing = false;
	});
	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) pi.on(event, arm);
}
