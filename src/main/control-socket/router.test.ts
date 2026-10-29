import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlResponse, SessionState } from "../../../resources/cli/protocol";
import type { ToolOutcome } from "../agent-control/service";
import type { TabActivity } from "../sidecar-pool";
import type { ControlBackend, OutsideCaller, SessionView } from "./backend";
import { EventHub } from "./events";
import { type ConnectionContext, ControlRouter, type RoutedRequest } from "./router";

class FakeBackend implements ControlBackend {
	readonly sessions = new Map<string, SessionView>();
	readonly listeners = new Set<(activity: TabActivity) => void>();
	readonly runs: { caller: OutsideCaller; tool: string; args: unknown }[] = [];
	onRun: (tool: string, args: unknown) => Promise<ToolOutcome> = async () => ({ text: "sent", isError: false });

	add(session: string, state: SessionState, title = `title of ${session}`): void {
		this.sessions.set(session, { session, title, state });
	}

	setState(session: string, state: SessionState): void {
		const view = this.sessions.get(session);
		if (view) this.sessions.set(session, { ...view, state });
	}

	fire(activity: TabActivity): void {
		for (const listener of [...this.listeners]) listener(activity);
	}

	async run(caller: OutsideCaller, tool: string, args: unknown): Promise<ToolOutcome> {
		this.runs.push({ caller, tool, args });
		return this.onRun(tool, args);
	}

	async resolve(_caller: OutsideCaller, name: string): Promise<SessionView> {
		const view = this.sessions.get(name);
		if (!view) throw new Error(`No session "${name}" is open`);
		return view;
	}

	view(session: string): SessionView | null {
		return this.sessions.get(session) ?? null;
	}

	views(): SessionView[] {
		return [...this.sessions.values()];
	}

	observe(listener: (activity: TabActivity) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onOutsideMail(): () => void {
		return () => undefined;
	}
}

const caller: OutsideCaller = { id: "outside:cli", title: 'outside agent "cli"', cwd: "/tmp" };

function connection(signal: AbortSignal = new AbortController().signal): ConnectionContext {
	return { caller, signal, sink: { write: () => true, onDrain: () => undefined } };
}

type RequestBody = RoutedRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

type Failure = Extract<ControlResponse, { ok: false }>;

function errorOf(response: ControlResponse): Failure["error"] {
	if (response.ok) throw new Error(`expected a failure, got ${JSON.stringify(response.result)}`);
	return response.error;
}

function resultOf(response: ControlResponse): unknown {
	if (!response.ok) throw new Error(`expected success, got ${response.error.code}: ${response.error.message}`);
	return response.result;
}

describe("ControlRouter", () => {
	let backend: FakeBackend;
	let router: ControlRouter;
	const request = (body: RequestBody): RoutedRequest => ({ id: 1, ...body }) as RoutedRequest;

	beforeEach(() => {
		backend = new FakeBackend();
		router = new ControlRouter(backend, new EventHub(backend));
	});
	afterEach(() => {
		expect(backend.listeners.size).toBe(0);
		vi.useRealTimers();
	});

	describe("tool and state", () => {
		it("answers a tool failure as a successful request carrying isError", async () => {
			backend.onRun = async () => ({ text: "nope", isError: true });
			const response = await router.handle(
				request({ method: "tool", tool: "ompdesk_sessions", args: { a: 1 } }),
				connection(),
			);
			expect(resultOf(response)).toEqual({ text: "nope", isError: true });
			expect(backend.runs).toEqual([{ caller, tool: "ompdesk_sessions", args: { a: 1 } }]);
		});

		it("reads a session's state and reports an unknown name as session_not_found", async () => {
			backend.add("t1", "working");
			expect(resultOf(await router.handle(request({ method: "state", session: "t1" }), connection()))).toEqual({
				session: "t1",
				title: "title of t1",
				state: "working",
			});
			const error = errorOf(await router.handle(request({ method: "state", session: "zzz" }), connection()));
			expect(error).toEqual({ code: "session_not_found", message: 'No session "zzz" is open' });
		});

		it("refuses an unknown method", async () => {
			const response = await router.handle({ id: 4, method: "nope" } as unknown as RoutedRequest, connection());
			expect(errorOf(response).code).toBe("unknown_method");
		});
	});

	describe("send and wait", () => {
		it("completes a send-and-wait whose whole turn ran before the receipt came back", async () => {
			backend.add("t1", "idle");
			backend.onRun = async () => {
				backend.setState("t1", "working");
				backend.fire({ type: "busy", tabId: "t1" });
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
				return { text: "sent", isError: false };
			};
			const settled = resultOf(
				await router.handle(
					request({ method: "send", session: "t1", message: "hi", delivery: "steer", requestId: "r1", wait: {} }),
					connection(),
				),
			);
			expect(settled).toEqual({
				receipt: "sent",
				waited: { session: "t1", title: "title of t1", state: "idle", matched: "settled", stopReason: "stop" },
			});
			expect(backend.runs[0]).toEqual({
				caller,
				tool: "ompdesk_session_send",
				args: { session: "t1", message: "hi", delivery: "steer", request_id: "r1" },
			});

			const done = resultOf(
				await router.handle(
					request({ method: "send", session: "t1", message: "again", wait: { until: "done" } }),
					connection(),
				),
			) as { waited: { matched: string; stopReason: string } };
			expect(done.waited).toMatchObject({ matched: "done", stopReason: "stop" });
		});

		it("returns only the receipt without a wait", async () => {
			backend.add("t1", "idle");
			expect(
				resultOf(await router.handle(request({ method: "send", session: "t1", message: "hi" }), connection())),
			).toEqual({
				receipt: "sent",
			});
		});

		it("refuses a session that waits on the person and sends nothing", async () => {
			backend.add("t1", "blocked");
			const error = errorOf(
				await router.handle(request({ method: "send", session: "t1", message: "hi" }), connection()),
			);
			expect(error.code).toBe("agent_blocked");
			expect(error.message).toContain("--force");
			expect(backend.runs).toEqual([]);
		});

		it("sends to a blocked session when forced", async () => {
			backend.add("t1", "blocked");
			const response = await router.handle(
				request({ method: "send", session: "t1", message: "hi", force: true }),
				connection(),
			);
			expect(resultOf(response)).toEqual({ receipt: "sent" });
			expect(backend.runs).toHaveLength(1);
		});

		it("turns the send tool's failure into tool_failed", async () => {
			backend.add("t1", "idle");
			backend.onRun = async () => ({ text: "Session is stopped", isError: true });
			const error = errorOf(
				await router.handle(request({ method: "send", session: "t1", message: "hi", wait: {} }), connection()),
			);
			expect(error).toEqual({ code: "tool_failed", message: "Session is stopped" });
		});

		it("answers agent_prompt_stalled when the message never starts a turn", async () => {
			vi.useFakeTimers();
			backend.add("t1", "idle");
			const pending = router.handle(
				request({ method: "send", session: "t1", message: "hi", wait: {} }),
				connection(),
			);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(errorOf(await pending).code).toBe("agent_prompt_stalled");
		});

		it("waits for the turn that follows the message, then settles", async () => {
			vi.useFakeTimers();
			backend.add("t1", "idle");
			const pending = router.handle(
				request({ method: "send", session: "t1", message: "hi", wait: {} }),
				connection(),
			);
			await vi.advanceTimersByTimeAsync(0);
			backend.setState("t1", "working");
			backend.fire({ type: "busy", tabId: "t1" });
			await vi.advanceTimersByTimeAsync(100);
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(false);
			backend.setState("t1", "idle");
			backend.fire({ type: "idle", tabId: "t1", outcome: undefined });
			expect(resultOf(await pending)).toMatchObject({
				waited: { matched: "settled", state: "idle", stopReason: "stop" },
			});
		});

		it("covers the send itself with the wait's timeout", async () => {
			vi.useFakeTimers();
			backend.add("t1", "idle");
			backend.onRun = () => new Promise(() => undefined);
			const pending = router.handle(
				request({ method: "send", session: "t1", message: "hi", wait: { timeoutMs: 1_000 } }),
				connection(),
			);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(errorOf(await pending).code).toBe("timeout");
		});

		it("counts only steps after the send: a turn that ran before it neither opens the gate nor ends the wait", async () => {
			vi.useFakeTimers();
			backend.add("t1", "idle");
			const resolve = backend.resolve.bind(backend);
			backend.resolve = async (who, name) => {
				backend.fire({ type: "busy", tabId: "t1" });
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
				return resolve(who, name);
			};
			const pending = router.handle(
				request({ method: "send", session: "t1", message: "hi", wait: { until: "done" } }),
				connection(),
			);
			await vi.advanceTimersByTimeAsync(5_000);
			const error = errorOf(await pending);
			expect(error.code).toBe("agent_prompt_stalled");
			expect(error.message).toContain("no observed working or blocked state");
		});

		it("ends done on a turn end the gate consumed, but settles idle only once the session is idle now", async () => {
			const busyAgain = async (): Promise<ToolOutcome> => {
				backend.setState("t1", "idle");
				backend.fire({ type: "busy", tabId: "t1" });
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
				backend.setState("t1", "working");
				backend.fire({ type: "busy", tabId: "t1" });
				return { text: "sent", isError: false };
			};
			backend.add("t1", "idle");
			backend.onRun = busyAgain;
			expect(
				resultOf(
					await router.handle(
						request({ method: "send", session: "t1", message: "hi", wait: { until: "done" } }),
						connection(),
					),
				),
			).toMatchObject({ waited: { state: "idle", matched: "done", stopReason: "stop" } });

			for (const until of [undefined, "idle"] as const) {
				backend.onRun = busyAgain;
				let answered = false;
				const pending = router
					.handle(
						request({ method: "send", session: "t1", message: "hi", wait: until ? { until } : {} }),
						connection(),
					)
					.then(response => {
						answered = true;
						return response;
					});
				await vi.waitFor(() => expect(backend.runs.at(-1)?.tool).toBe("ompdesk_session_send"));
				await new Promise(resolve => setImmediate(resolve));
				expect(answered, `${until} answered while the second turn runs`).toBe(false);
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "aborted" } });
				expect(resultOf(await pending)).toMatchObject({
					waited: { state: "idle", matched: until ?? "settled", stopReason: "aborted" },
				});
			}
		});

		it("never ends done on the turn that was running before the send, even when it ends while the send is in flight", async () => {
			backend.add("t1", "working");
			backend.onRun = async () => {
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "old" } });
				return { text: "sent", isError: false };
			};
			let answered = false;
			const pending = router
				.handle(request({ method: "send", session: "t1", message: "hi", wait: { until: "done" } }), connection())
				.then(response => {
					answered = true;
					return response;
				});
			await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
			await new Promise(resolve => setImmediate(resolve));
			expect(answered).toBe(false);
			backend.setState("t1", "working");
			backend.fire({ type: "busy", tabId: "t1" });
			backend.setState("t1", "idle");
			backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "new" } });
			expect(resultOf(await pending)).toMatchObject({ waited: { matched: "done", stopReason: "new" } });
		});

		it("does not settle on the idle gap between the old turn and the queued follow-up's turn", async () => {
			backend.add("t1", "working");
			backend.onRun = async () => {
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "old" } });
				return { text: "sent", isError: false };
			};
			let answered = false;
			const pending = router
				.handle(request({ method: "send", session: "t1", message: "hi", wait: {} }), connection())
				.then(response => {
					answered = true;
					return response;
				});
			await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
			await new Promise(resolve => setImmediate(resolve));
			expect(answered).toBe(false);
			backend.setState("t1", "working");
			backend.fire({ type: "busy", tabId: "t1" });
			await new Promise(resolve => setImmediate(resolve));
			expect(answered).toBe(false);
			backend.setState("t1", "idle");
			backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "new" } });
			expect(resultOf(await pending)).toMatchObject({ waited: { matched: "settled", stopReason: "new" } });
		});

		it("settles on the idle state after the grace when the follow-up was folded into the turn that ended", async () => {
			vi.useFakeTimers();
			backend.add("t1", "working");
			backend.onRun = async () => {
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
				return { text: "sent", isError: false };
			};
			const pending = router.handle(
				request({ method: "send", session: "t1", message: "hi", wait: {} }),
				connection(),
			);
			await vi.advanceTimersByTimeAsync(5_500);
			expect(resultOf(await pending)).toMatchObject({ waited: { matched: "settled", state: "idle" } });
		});

		it("runs the gate under the one total timeout: a nearer timeout answers timeout, not stalled", async () => {
			vi.useFakeTimers();
			backend.add("t1", "idle");
			const pending = router.handle(
				request({ method: "send", session: "t1", message: "hi", wait: { timeoutMs: 2_000 } }),
				connection(),
			);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(errorOf(await pending).code).toBe("timeout");
		});
	});

	describe("wait", () => {
		it("settles at once on a session that already idles, waits on the person or has stopped", async () => {
			backend.add("t1", "idle");
			backend.add("t2", "blocked");
			backend.add("t3", "stopped");
			for (const [session, state] of [
				["t1", "idle"],
				["t2", "blocked"],
				["t3", "stopped"],
			] as const)
				expect(resultOf(await router.handle(request({ method: "wait", session }), connection()))).toMatchObject({
					matched: "settled",
					state,
				});
		});

		it("answers --until blocked and --until idle at once when the session is in that state", async () => {
			backend.add("t1", "blocked");
			backend.add("t2", "idle");
			expect(
				resultOf(await router.handle(request({ method: "wait", session: "t1", until: "blocked" }), connection())),
			).toMatchObject({
				matched: "blocked",
				state: "blocked",
			});
			expect(
				resultOf(await router.handle(request({ method: "wait", session: "t2", until: "idle" }), connection())),
			).toMatchObject({
				matched: "idle",
			});
		});

		it("holds --until done through the states and answers at the next turn end", async () => {
			backend.add("t1", "working");
			const pending = router.handle(request({ method: "wait", session: "t1", until: "done" }), connection());
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await Promise.resolve();
			backend.fire({ type: "step", tabId: "t1" });
			backend.fire({ type: "idle", tabId: "other", outcome: { stopReason: "stop" } });
			await Promise.resolve();
			expect(settled).toBe(false);
			backend.setState("t1", "idle");
			backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "aborted" } });
			expect(resultOf(await pending)).toEqual({
				session: "t1",
				title: "title of t1",
				state: "idle",
				matched: "done",
				stopReason: "aborted",
			});
		});

		it("answers --until any at the first change of state", async () => {
			vi.useFakeTimers();
			backend.add("t1", "working");
			const pending = router.handle(request({ method: "wait", session: "t1", until: "any" }), connection());
			await vi.advanceTimersByTimeAsync(0);
			backend.setState("t1", "blocked");
			backend.fire({ type: "ask", tabId: "t1", requestId: "q", text: "?" });
			expect(resultOf(await pending)).toMatchObject({ matched: "any", state: "blocked" });
		});

		it("notices a state change that raises no activity (a plan proposal) on its poll", async () => {
			vi.useFakeTimers();
			backend.add("t1", "working");
			const pending = router.handle(request({ method: "wait", session: "t1", until: "blocked" }), connection());
			await vi.advanceTimersByTimeAsync(0);
			backend.setState("t1", "blocked");
			await vi.advanceTimersByTimeAsync(500);
			expect(resultOf(await pending)).toMatchObject({ matched: "blocked" });
		});

		it("answers session_gone when the tab is released", async () => {
			backend.add("t1", "working");
			const pending = router.handle(request({ method: "wait", session: "t1" }), connection());
			await Promise.resolve();
			backend.sessions.delete("t1");
			backend.fire({ type: "released", tabId: "t1" });
			expect(errorOf(await pending).code).toBe("session_gone");
		});

		it("answers timeout when the session never gets there", async () => {
			vi.useFakeTimers();
			backend.add("t1", "working");
			const pending = router.handle(request({ method: "wait", session: "t1", timeoutMs: 2_000 }), connection());
			await vi.advanceTimersByTimeAsync(2_000);
			expect(errorOf(await pending).code).toBe("timeout");
		});

		it("rejects a nonsense timeout or until", async () => {
			backend.add("t1", "idle");
			expect(
				errorOf(await router.handle(request({ method: "wait", session: "t1", timeoutMs: -1 }), connection())).code,
			).toBe("bad_request");
			expect(
				errorOf(
					await router.handle(request({ method: "wait", session: "t1", until: "soon" as never }), connection()),
				).code,
			).toBe("bad_request");
		});

		it("leaves no listener behind when its connection closes mid-wait", async () => {
			vi.useFakeTimers();
			backend.add("t1", "working");
			const abort = new AbortController();
			const pending = router.handle(request({ method: "wait", session: "t1" }), connection(abort.signal));
			await vi.advanceTimersByTimeAsync(0);
			expect(backend.listeners.size).toBe(1);
			abort.abort(new Error("closed"));
			expect(errorOf(await pending).code).toBe("unavailable");
			expect(backend.listeners.size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});
