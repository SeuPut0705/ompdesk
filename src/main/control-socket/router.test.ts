import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlResponse } from "../../shared/control-protocol";
import type { ToolOutcome } from "../agent-control/service";
import { stopCore } from "../core/process";
import type { OutsideCaller } from "./backend";
import { ControlRig, type LineClient, TestBackend } from "./control-test-rig";
import type { ControlTuning } from "./server";

// The requests and their waits are the core's (native/ompdesk/crates/core/src/control/router.rs): every case sends a
// real request over the socket and plays main through the backend. The core's timers run for real, shortened by the
// server's tuning; where a case waits on time it is the time it names.
//
// Main hears a tab's activity only while the core asks it to watch, which it does before it resolves the session's
// name: every activity here is fired once `resolve` (or the send tool) was called, so the core is watching.

type Failure = Extract<ControlResponse, { ok: false }>;

function errorOf(response: ControlResponse): Failure["error"] {
	if (response.ok) throw new Error(`expected a failure, got ${JSON.stringify(response.result)}`);
	return response.error;
}

function resultOf(response: ControlResponse): unknown {
	if (!response.ok) throw new Error(`expected success, got ${response.error.code}: ${response.error.message}`);
	return response.result;
}

/** A start wait short enough to watch run out. */
const SHORT_START_WAIT = { startWaitMs: 100 };
const SHORT_TIMEOUT_MS = 100;

describe("control requests", () => {
	const rig = new ControlRig();
	let backend: TestBackend;
	let client: LineClient;
	let caller: OutsideCaller;

	/** One server for the case, and its connection; the poll beat is short so a state with no activity is seen soon. */
	async function serve(tuning: ControlTuning = {}): Promise<void> {
		const path = await rig.serve(backend, { tuning: { pollMs: 20, ...tuning } });
		({ client, caller } = await rig.connect(path));
	}

	/**
	 * A `state` request on the same connection, answered after every push main sent before it (the core applies main's
	 * pushes in order): a request still unanswered then was not settled by what came before.
	 */
	async function barrier(session = "t1"): Promise<void> {
		resultOf(await client.call({ method: "state", session }));
	}

	beforeEach(() => {
		backend = new TestBackend();
		backend.onRun = async () => ({ text: "sent", isError: false });
	});
	afterEach(async () => {
		try {
			// Every request let go of main's activity: none is left hearing it.
			await backend.watched(false);
		} finally {
			await rig.cleanup();
		}
	});
	afterAll(() => stopCore());

	describe("tool and state", () => {
		it("answers a tool failure as a successful request carrying isError", async () => {
			await serve();
			backend.onRun = async () => ({ text: "nope", isError: true });
			const response = await client.call({ method: "tool", tool: "ompdesk_sessions", args: { a: 1 } });
			expect(resultOf(response)).toEqual({ text: "nope", isError: true });
			expect(backend.runs).toEqual([{ caller, tool: "ompdesk_sessions", args: { a: 1 } }]);
		});

		it("reads a session's state and reports an unknown name as session_not_found", async () => {
			await serve();
			backend.add("t1", "working");
			expect(resultOf(await client.call({ method: "state", session: "t1" }))).toEqual({
				session: "t1",
				title: "title of t1",
				state: "working",
			});
			const error = errorOf(await client.call({ method: "state", session: "zzz" }));
			expect(error).toEqual({ code: "session_not_found", message: 'No session "zzz" is open' });
		});

		it("refuses an unknown method", async () => {
			await serve();
			const response = await client.call({ id: 4, method: "nope" });
			expect(errorOf(response).code).toBe("unknown_method");
		});
	});

	describe("send and wait", () => {
		it("completes a send-and-wait whose whole turn ran before the receipt came back", async () => {
			await serve();
			backend.add("t1", "idle");
			backend.onRun = async () => {
				backend.setState("t1", "working");
				backend.fire({ type: "busy", tabId: "t1" });
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
				return { text: "sent", isError: false };
			};
			const settled = resultOf(
				await client.call({
					method: "send",
					session: "t1",
					message: "hi",
					delivery: "steer",
					requestId: "r1",
					wait: {},
				}),
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
				await client.call({ method: "send", session: "t1", message: "again", wait: { until: "done" } }),
			);
			expect(done).toMatchObject({ waited: { matched: "done", stopReason: "stop" } });
		});

		it("returns only the receipt without a wait", async () => {
			await serve();
			backend.add("t1", "idle");
			expect(resultOf(await client.call({ method: "send", session: "t1", message: "hi" }))).toEqual({
				receipt: "sent",
			});
		});

		it("refuses a session that waits on the person and sends nothing", async () => {
			await serve();
			backend.add("t1", "blocked");
			const error = errorOf(await client.call({ method: "send", session: "t1", message: "hi" }));
			expect(error.code).toBe("agent_blocked");
			expect(error.message).toContain("--force");
			expect(backend.runs).toEqual([]);
		});

		it("sends to a blocked session when forced", async () => {
			await serve();
			backend.add("t1", "blocked");
			const response = await client.call({ method: "send", session: "t1", message: "hi", force: true });
			expect(resultOf(response)).toEqual({ receipt: "sent" });
			expect(backend.runs).toHaveLength(1);
		});

		it("turns the send tool's failure into tool_failed", async () => {
			await serve();
			backend.add("t1", "idle");
			backend.onRun = async () => ({ text: "Session is stopped", isError: true });
			const error = errorOf(await client.call({ method: "send", session: "t1", message: "hi", wait: {} }));
			expect(error).toEqual({ code: "tool_failed", message: "Session is stopped" });
		});

		it("answers agent_prompt_stalled when the message never starts a turn", async () => {
			await serve(SHORT_START_WAIT);
			backend.add("t1", "idle");
			const response = await client.call({ method: "send", session: "t1", message: "hi", wait: {} });
			expect(errorOf(response).code).toBe("agent_prompt_stalled");
		});

		it("waits for the turn that follows the message, then settles", async () => {
			await serve();
			backend.add("t1", "idle");
			const pending = client.call({ id: 2, method: "send", session: "t1", message: "hi", wait: {} });
			await backend.until(() => backend.runs.length === 1);
			backend.setState("t1", "working");
			backend.fire({ type: "busy", tabId: "t1" });
			await barrier();
			expect(client.answered(2)).toBe(false);
			backend.setState("t1", "idle");
			backend.fire({ type: "idle", tabId: "t1", outcome: undefined });
			expect(resultOf(await pending)).toMatchObject({
				waited: { matched: "settled", state: "idle", stopReason: "stop" },
			});
		});

		it("covers the send itself with the wait's timeout", async () => {
			await serve();
			backend.add("t1", "idle");
			const send = Promise.withResolvers<ToolOutcome>();
			backend.onRun = () => send.promise;
			const response = await client.call({
				method: "send",
				session: "t1",
				message: "hi",
				wait: { timeoutMs: SHORT_TIMEOUT_MS },
			});
			expect(errorOf(response).code).toBe("timeout");
			send.resolve({ text: "sent", isError: false });
		});

		it("counts only steps after the send: a turn that ran before it neither opens the gate nor ends the wait", async () => {
			await serve(SHORT_START_WAIT);
			backend.add("t1", "idle");
			const resolve = backend.resolve.bind(backend);
			backend.resolve = async (who, name) => {
				backend.fire({ type: "busy", tabId: "t1" });
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
				return resolve(who, name);
			};
			const error = errorOf(
				await client.call({ method: "send", session: "t1", message: "hi", wait: { until: "done" } }),
			);
			expect(error.code).toBe("agent_prompt_stalled");
			expect(error.message).toContain("no observed working or blocked state");
		});

		it("ends done on a turn end the gate consumed, but settles idle only once the session is idle now", async () => {
			await serve();
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
				resultOf(await client.call({ method: "send", session: "t1", message: "hi", wait: { until: "done" } })),
			).toMatchObject({ waited: { state: "idle", matched: "done", stopReason: "stop" } });

			let id = 10;
			for (const until of [undefined, "idle"] as const) {
				id++;
				const runs = backend.runs.length;
				const pending = client.call({
					id,
					method: "send",
					session: "t1",
					message: "hi",
					wait: until ? { until } : {},
				});
				await backend.until(() => backend.runs.length === runs + 1);
				await barrier();
				expect(client.answered(id), `${until} answered while the second turn runs`).toBe(false);
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "aborted" } });
				expect(resultOf(await pending)).toMatchObject({
					waited: { state: "idle", matched: until ?? "settled", stopReason: "aborted" },
				});
			}
		});

		it("never ends done on the turn that was running before the send, even when it ends while the send is in flight", async () => {
			await serve();
			backend.add("t1", "working");
			backend.onRun = async () => {
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "old" } });
				return { text: "sent", isError: false };
			};
			const pending = client.call({ id: 2, method: "send", session: "t1", message: "hi", wait: { until: "done" } });
			await backend.until(() => backend.runs.length === 1);
			await barrier();
			expect(client.answered(2)).toBe(false);
			backend.setState("t1", "working");
			backend.fire({ type: "busy", tabId: "t1" });
			backend.setState("t1", "idle");
			backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "new" } });
			expect(resultOf(await pending)).toMatchObject({ waited: { matched: "done", stopReason: "new" } });
		});

		it("does not settle on the idle gap between the old turn and the queued follow-up's turn", async () => {
			await serve();
			backend.add("t1", "working");
			backend.onRun = async () => {
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "old" } });
				return { text: "sent", isError: false };
			};
			const pending = client.call({ id: 2, method: "send", session: "t1", message: "hi", wait: {} });
			await backend.until(() => backend.runs.length === 1);
			await barrier();
			expect(client.answered(2)).toBe(false);
			backend.setState("t1", "working");
			backend.fire({ type: "busy", tabId: "t1" });
			await barrier();
			expect(client.answered(2)).toBe(false);
			backend.setState("t1", "idle");
			backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "new" } });
			expect(resultOf(await pending)).toMatchObject({ waited: { matched: "settled", stopReason: "new" } });
		});

		it("settles on the idle state after the grace when the follow-up was folded into the turn that ended", async () => {
			await serve(SHORT_START_WAIT);
			backend.add("t1", "working");
			backend.onRun = async () => {
				backend.setState("t1", "idle");
				backend.fire({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
				return { text: "sent", isError: false };
			};
			const response = await client.call({ method: "send", session: "t1", message: "hi", wait: {} });
			expect(resultOf(response)).toMatchObject({ waited: { matched: "settled", state: "idle" } });
		});

		it("runs the gate under the one total timeout: a nearer timeout answers timeout, not stalled", async () => {
			// The shipped start wait (5 s) and a total timeout well inside it.
			await serve();
			backend.add("t1", "idle");
			const response = await client.call({
				method: "send",
				session: "t1",
				message: "hi",
				wait: { timeoutMs: SHORT_TIMEOUT_MS },
			});
			expect(errorOf(response).code).toBe("timeout");
		});
	});

	describe("wait", () => {
		it("settles at once on a session that already idles, waits on the person or has stopped", async () => {
			await serve();
			backend.add("t1", "idle");
			backend.add("t2", "blocked");
			backend.add("t3", "stopped");
			for (const [session, state] of [
				["t1", "idle"],
				["t2", "blocked"],
				["t3", "stopped"],
			] as const)
				expect(resultOf(await client.call({ method: "wait", session }))).toMatchObject({
					matched: "settled",
					state,
				});
		});

		it("answers --until blocked and --until idle at once when the session is in that state", async () => {
			await serve();
			backend.add("t1", "blocked");
			backend.add("t2", "idle");
			expect(resultOf(await client.call({ method: "wait", session: "t1", until: "blocked" }))).toMatchObject({
				matched: "blocked",
				state: "blocked",
			});
			expect(resultOf(await client.call({ method: "wait", session: "t2", until: "idle" }))).toMatchObject({
				matched: "idle",
			});
		});

		it("holds --until done through the states and answers at the next turn end", async () => {
			await serve();
			backend.add("t1", "working");
			const pending = client.call({ id: 2, method: "wait", session: "t1", until: "done" });
			await backend.until(() => backend.resolved.length === 1);
			backend.fire({ type: "step", tabId: "t1" });
			backend.fire({ type: "idle", tabId: "other", outcome: { stopReason: "stop" } });
			await barrier();
			expect(client.answered(2)).toBe(false);
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
			await serve();
			backend.add("t1", "working");
			const pending = client.call({ method: "wait", session: "t1", until: "any" });
			await backend.until(() => backend.resolved.length === 1);
			backend.setState("t1", "blocked");
			backend.fire({ type: "ask", tabId: "t1", requestId: "q", text: "?" });
			expect(resultOf(await pending)).toMatchObject({ matched: "any", state: "blocked" });
		});

		it("notices a state change that raises no activity (a plan proposal) on its poll", async () => {
			await serve();
			backend.add("t1", "working");
			const pending = client.call({ id: 2, method: "wait", session: "t1", until: "blocked" });
			await backend.until(() => backend.resolved.length === 1);
			// The wait has its answer to the name and the session as working: only a poll can show the change.
			await barrier();
			expect(client.answered(2)).toBe(false);
			backend.setState("t1", "blocked");
			expect(resultOf(await pending)).toMatchObject({ matched: "blocked" });
		});

		it("answers session_gone when the tab is released", async () => {
			await serve();
			backend.add("t1", "working");
			const pending = client.call({ method: "wait", session: "t1" });
			await backend.until(() => backend.resolved.length === 1);
			backend.sessions.delete("t1");
			backend.fire({ type: "released", tabId: "t1" });
			expect(errorOf(await pending).code).toBe("session_gone");
		});

		it("answers timeout when the session never gets there", async () => {
			await serve();
			backend.add("t1", "working");
			const response = await client.call({ method: "wait", session: "t1", timeoutMs: SHORT_TIMEOUT_MS });
			expect(errorOf(response).code).toBe("timeout");
		});

		it("rejects a nonsense timeout or until", async () => {
			await serve();
			backend.add("t1", "idle");
			expect(errorOf(await client.call({ method: "wait", session: "t1", timeoutMs: -1 })).code).toBe("bad_request");
			expect(errorOf(await client.call({ method: "wait", session: "t1", until: "soon" })).code).toBe("bad_request");
		});

		it("leaves no listener behind when its connection closes mid-wait", async () => {
			await serve();
			backend.add("t1", "working");
			client.send({ id: 2, method: "wait", session: "t1" });
			await backend.until(() => backend.resolved.length === 1);
			await backend.watched();
			expect(backend.listeners.size).toBe(1);
			client.close();
			await client.closed;
			await backend.watched(false);
			expect(backend.listeners.size).toBe(0);
		});
	});
});
