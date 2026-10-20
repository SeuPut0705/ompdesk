import { describe, expect, it, vi } from "vitest";
import type { AutoModeDecision } from "../../../resources/gui-bridge/modes/auto-mode-contracts";
import type { RpcResponse } from "../../shared/rpc-types";
import { createSessionStore } from "../stores/session";
import { endAutoGoal, prefetchAutoMode, runAutoMode } from "./auto-mode-client";
import { planComposerSubmit } from "./composer-submit";

const BIG = "refactor the whole settings module across all files";

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "auto_mode_decide", success: true, data };
}

function rig(decision: AutoModeDecision | Promise<RpcResponse> | Error) {
	const session = createSessionStore();
	session.setState({ sessionId: "s1" });
	const autoModeDecide = vi.fn(async () => {
		if (decision instanceof Error) throw decision;
		return decision instanceof Promise ? decision : ok(decision);
	});
	const autoModeEnd = vi.fn(async (_mode: "plan" | "goal") => ok({}));
	return { session, autoModeDecide, autoModeEnd, rpc: { autoModeDecide, autoModeEnd } };
}

const planned: AutoModeDecision = { mode: "plan", latencyMs: 300, model: "p/m" };

describe("a mode used for one request", () => {
	it("ends an automatic plan before an unrelated message, through stock's exit, and classifies that message", async () => {
		const { session, rpc, autoModeEnd, autoModeDecide } = rig({
			mode: "none",
			reason: "classified_none",
			latencyMs: 9,
		});
		session.setState({ planModeEnabled: true, autoMode: "plan" });
		await runAutoMode({ message: BIG, isStreaming: false, session, rpc, readPref: async () => true });
		expect(autoModeEnd).toHaveBeenCalledExactlyOnceWith("plan");
		expect(session.getState()).toMatchObject({ planModeEnabled: false, autoMode: null });
		expect(autoModeDecide).toHaveBeenCalledOnce();
	});

	it("keeps the automatic plan for a reply to it: a proposal awaiting approval, or a steer mid-run", async () => {
		for (const reply of [{ planPending: true, isStreaming: false }, { isStreaming: true }]) {
			const { session, rpc, autoModeEnd, autoModeDecide } = rig(planned);
			session.setState({ planModeEnabled: true, autoMode: "plan" });
			await runAutoMode({ message: BIG, session, rpc, readPref: async () => true, ...reply });
			expect(autoModeEnd).not.toHaveBeenCalled();
			expect(autoModeDecide).not.toHaveBeenCalled();
			expect(session.getState()).toMatchObject({ planModeEnabled: true, autoMode: "plan" });
		}
	});

	it("never ends the user's own plan mode, and never classifies while it is on (a manual mode wins)", async () => {
		const { session, rpc, autoModeEnd, autoModeDecide } = rig(planned);
		session.setState({ planModeEnabled: true, autoMode: null });
		await runAutoMode({ message: BIG, isStreaming: false, session, rpc, readPref: async () => true });
		expect(autoModeEnd).not.toHaveBeenCalled();
		expect(autoModeDecide).not.toHaveBeenCalled();
		expect(session.getState().planModeEnabled).toBe(true);
	});

	it("ends an automatic goal when the user stops it, and leaves the user's own goal alone", async () => {
		const auto = rig(planned);
		auto.session.setState({ goal: { objective: "ship" }, goalState: { status: "active" }, autoMode: "goal" });
		await endAutoGoal(auto.session, auto.rpc);
		expect(auto.autoModeEnd).toHaveBeenCalledExactlyOnceWith("goal");
		expect(auto.session.getState()).toMatchObject({ goal: null, goalState: null, autoMode: null });

		const own = rig(planned);
		own.session.setState({ goal: { objective: "ship" }, goalState: { status: "active" }, autoMode: null });
		await endAutoGoal(own.session, own.rpc);
		expect(own.autoModeEnd).not.toHaveBeenCalled();
		expect(own.session.getState().goal).toEqual({ objective: "ship" });
	});
});

describe("runAutoMode", () => {
	it("enters plan in the store and remembers it was automatic", async () => {
		const { session, rpc, autoModeDecide } = rig(planned);
		await runAutoMode({ message: BIG, isStreaming: false, session, rpc, readPref: async () => undefined });
		expect(autoModeDecide).toHaveBeenCalledWith(BIG);
		expect(session.getState()).toMatchObject({ planModeEnabled: true, autoMode: "plan" });
	});

	it("starts a goal in the store with the objective", async () => {
		const { session, rpc } = rig({ mode: "goal", objective: "until tests pass", latencyMs: 200 });
		await runAutoMode({
			message: "keep going until tests pass",
			isStreaming: false,
			session,
			rpc,
			readPref: async () => true,
		});
		expect(session.getState()).toMatchObject({
			goal: { objective: "until tests pass" },
			goalState: { status: "active" },
			autoMode: "goal",
		});
	});

	it("changes nothing for none", async () => {
		const { session, rpc } = rig({ mode: "none", reason: "classified_none", latencyMs: 100 });
		await runAutoMode({
			message: "what does this do?",
			isStreaming: false,
			session,
			rpc,
			readPref: async () => true,
		});
		expect(session.getState()).toMatchObject({ planModeEnabled: false, autoMode: null, goal: null });
	});

	it("asks nothing with the pref off, mid-run, for slash and bash, or while a mode the user picked is on", async () => {
		const cases: Array<() => Promise<unknown>> = [];
		const calls: Array<ReturnType<typeof rig>> = [];
		const attempt = (message: string, over: { streaming?: boolean; pref?: unknown; state?: object } = {}) => {
			const r = rig(planned);
			calls.push(r);
			r.session.setState({ ...over.state });
			cases.push(() =>
				runAutoMode({
					message,
					isStreaming: over.streaming ?? false,
					session: r.session,
					rpc: r.rpc,
					readPref: async () => ("pref" in over ? over.pref : true),
				}),
			);
		};
		attempt(BIG, { pref: false });
		attempt(BIG, { streaming: true });
		attempt("/plan do it all");
		attempt("!git status --short");
		attempt(BIG, { state: { planModeEnabled: true } });
		attempt(BIG, { state: { goalState: { status: "active" } } });
		await Promise.all(cases.map(run => run()));
		for (const r of calls) expect(r.autoModeDecide).not.toHaveBeenCalled();
	});

	it("passes a failed or refused request through as no decision", async () => {
		const failing = rig(new Error("boom"));
		await expect(
			runAutoMode({
				message: BIG,
				isStreaming: false,
				session: failing.session,
				rpc: failing.rpc,
				readPref: async () => true,
			}),
		).resolves.toBeNull();
		const refused = rig(
			Promise.resolve({ type: "response", command: "x", success: false, error: "quota" } as RpcResponse),
		);
		await runAutoMode({
			message: BIG,
			isStreaming: false,
			session: refused.session,
			rpc: refused.rpc,
			readPref: async () => true,
		});
		expect(refused.session.getState().planModeEnabled).toBe(false);
	});

	it("does not wait for a decision that never comes", async () => {
		vi.useFakeTimers();
		try {
			const { session, rpc } = rig(new Promise<RpcResponse>(() => {}));
			const pending = runAutoMode({ message: BIG, isStreaming: false, session, rpc, readPref: async () => true });
			await vi.advanceTimersByTimeAsync(3100);
			await expect(pending).resolves.toBeNull();
			expect(session.getState().planModeEnabled).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns at once when the prompt is withdrawn, and ends a plan the host picks afterwards", async () => {
		const gate = Promise.withResolvers<RpcResponse>();
		const { session, rpc, autoModeEnd } = rig(gate.promise);
		const withdraw = new AbortController();
		const deciding: boolean[] = [];
		const pending = runAutoMode({
			message: BIG,
			isStreaming: false,
			session,
			rpc,
			readPref: async () => true,
			signal: withdraw.signal,
			onDeciding: value => deciding.push(value),
		});
		await vi.waitFor(() => expect(deciding).toEqual([true]));
		withdraw.abort();
		// The host has not answered: Stop does not wait for it.
		await expect(pending).resolves.toBeNull();
		expect(deciding).toEqual([true, false]);
		expect(session.getState()).toMatchObject({ planModeEnabled: false, autoMode: null });
		expect(autoModeEnd).not.toHaveBeenCalled();

		// The host decides anyway and has already entered plan: that mode ends when the answer lands.
		gate.resolve(ok(planned));
		await vi.waitFor(() => expect(autoModeEnd).toHaveBeenCalledExactlyOnceWith("plan"));
		expect(session.getState()).toMatchObject({ planModeEnabled: false, autoMode: null });
	});

	it("hands a goal the host starts after the withdraw to onLateDecision", async () => {
		const gate = Promise.withResolvers<RpcResponse>();
		const { session, rpc, autoModeEnd } = rig(gate.promise);
		const withdraw = new AbortController();
		const late = vi.fn();
		const pending = runAutoMode({
			message: BIG,
			isStreaming: false,
			session,
			rpc,
			readPref: async () => true,
			signal: withdraw.signal,
			onLateDecision: late,
		});
		await vi.waitFor(() => expect(rpc.autoModeDecide).toHaveBeenCalled());
		withdraw.abort();
		await pending;
		const goal: AutoModeDecision = { mode: "goal", objective: "until tests pass", latencyMs: 400 };
		gate.resolve(ok(goal));
		await vi.waitFor(() => expect(late).toHaveBeenCalledExactlyOnceWith(goal));
		expect(autoModeEnd).not.toHaveBeenCalled();
		expect(session.getState().goal).toBeNull();
	});

	it("asks nothing when the prompt was withdrawn before the choice began", async () => {
		const { session, rpc, autoModeDecide } = rig(planned);
		const withdraw = new AbortController();
		withdraw.abort();
		await expect(
			runAutoMode({
				message: BIG,
				isStreaming: false,
				session,
				rpc,
				readPref: async () => true,
				signal: withdraw.signal,
			}),
		).resolves.toBeNull();
		expect(autoModeDecide).not.toHaveBeenCalled();
	});

	it("ignores a decision that lands after the session changed", async () => {
		const gate = Promise.withResolvers<RpcResponse>();
		const { session, rpc } = rig(gate.promise);
		const pending = runAutoMode({ message: BIG, isStreaming: false, session, rpc, readPref: async () => true });
		await Promise.resolve();
		session.setState({ sessionId: "s2" });
		gate.resolve(ok(planned));
		await pending;
		expect(session.getState().planModeEnabled).toBe(false);
	});
});

describe("planComposerSubmit and the automatic choice", () => {
	const rpc = { compact: vi.fn(), followUp: vi.fn(), steer: vi.fn(), prompt: vi.fn(async () => ok({})) };
	const base = { images: [], commands: [], mode: "prompt" as const, rpc };

	it("runs the choice before a plain prompt and sends the prompt unchanged afterwards", async () => {
		const order: string[] = [];
		const beforePrompt = vi.fn(async () => void order.push("choice"));
		rpc.prompt.mockImplementationOnce(async () => {
			order.push("prompt");
			return ok({});
		});
		const plan = planComposerSubmit({ ...base, message: BIG, isStreaming: false, beforePrompt });
		if (plan.kind !== "send") throw new Error("expected send");
		await plan.request();
		expect(order).toEqual(["choice", "prompt"]);
		expect(rpc.prompt).toHaveBeenLastCalledWith(BIG, []);
	});

	it("sends the prompt as a steer after a goal decision, so the goal's own turn cannot refuse it", async () => {
		// Stock's `goal create` starts the goal's turn at once; a plain prompt arriving then is refused as busy, and
		// the composer put the sent text back as "Message not sent".
		const message = "keep going until all the tests pass";
		const goal = rig({ mode: "goal", objective: message, latencyMs: 200 });
		const submit = planComposerSubmit({
			...base,
			message,
			isStreaming: false,
			beforePrompt: () =>
				runAutoMode({
					message,
					isStreaming: false,
					session: goal.session,
					rpc: goal.rpc,
					readPref: async () => true,
				}),
		});
		if (submit.kind !== "send") throw new Error("expected send");
		await submit.request();
		expect(rpc.prompt).toHaveBeenLastCalledWith(message, [], "steer");

		for (const decision of [planned, { mode: "none", reason: "classified_none", latencyMs: 100 } as const]) {
			const other = rig(decision);
			const plain = planComposerSubmit({
				...base,
				message: BIG,
				isStreaming: false,
				beforePrompt: () =>
					runAutoMode({
						message: BIG,
						isStreaming: false,
						session: other.session,
						rpc: other.rpc,
						readPref: async () => true,
					}),
			});
			if (plain.kind !== "send") throw new Error("expected send");
			await plain.request();
			expect(rpc.prompt).toHaveBeenLastCalledWith(BIG, []);
		}
	});

	it("never runs it for steer, follow-up or a slash command", async () => {
		const beforePrompt = vi.fn(async () => null);
		for (const input of [
			{ message: BIG, isStreaming: true, mode: "steer" as const },
			{ message: BIG, isStreaming: true, mode: "followUp" as const },
			{ message: "/skill:review now", isStreaming: false, mode: "prompt" as const },
		]) {
			const plan = planComposerSubmit({ ...base, ...input, beforePrompt });
			if (plan.kind === "send") await plan.request();
		}
		expect(beforePrompt).not.toHaveBeenCalled();
	});
});

describe("asking while the user types", () => {
	function typing() {
		const session = createSessionStore();
		session.setState({ sessionId: "s1" });
		const autoModePrefetch = vi.fn(async (_message?: string) => ok({ prefetched: true }));
		return { session, autoModePrefetch, rpc: { autoModePrefetch } };
	}

	it("asks the question the send will ask, with the text the send will carry", async () => {
		const { session, rpc, autoModePrefetch } = typing();
		await prefetchAutoMode({ message: BIG, isStreaming: false, session, rpc, readPref: async () => true });
		expect(autoModePrefetch).toHaveBeenCalledWith(BIG);
	});

	it("asks nothing where the send would ask nothing: pref off, mid-run, slash, bash, chat-length, a mode the user picked", async () => {
		const { session, rpc, autoModePrefetch } = typing();
		const cases: Array<{ message: string; isStreaming?: boolean; pref?: boolean; plan?: boolean }> = [
			{ message: BIG, pref: false },
			{ message: BIG, isStreaming: true },
			{ message: "/compact the whole thing please" },
			{ message: "!ls -la /tmp/somewhere" },
			{ message: "ok thanks" },
			{ message: BIG, plan: true },
		];
		for (const input of cases) {
			session.setState({ planModeEnabled: input.plan === true });
			await prefetchAutoMode({
				message: input.message,
				isStreaming: input.isStreaming ?? false,
				session,
				rpc,
				readPref: async () => input.pref ?? true,
			});
		}
		expect(autoModePrefetch).not.toHaveBeenCalled();
	});

	it("never throws: a refused or failed request changes nothing", async () => {
		const { session } = typing();
		const rpc = { autoModePrefetch: vi.fn(async () => Promise.reject(new Error("offline"))) };
		await expect(
			prefetchAutoMode({ message: BIG, isStreaming: false, session, rpc, readPref: async () => true }),
		).resolves.toBeUndefined();
		expect(session.getState().autoMode ?? null).toBeNull();
		expect(session.getState().planModeEnabled).toBe(false);
	});
});

describe("the mode is in place before the prompt leaves", () => {
	const rpc = { compact: vi.fn(), followUp: vi.fn(), steer: vi.fn(), prompt: vi.fn(async () => ok({})) };
	const base = { images: [], commands: [], mode: "prompt" as const, rpc };

	it("a plan decision has put the session in plan mode when the prompt is sent", async () => {
		const plan = rig(planned);
		let planAtPrompt: boolean | undefined;
		rpc.prompt.mockImplementationOnce(async () => {
			planAtPrompt = plan.session.getState().planModeEnabled;
			return ok({});
		});
		const submit = planComposerSubmit({
			...base,
			message: BIG,
			isStreaming: false,
			beforePrompt: () =>
				runAutoMode({
					message: BIG,
					isStreaming: false,
					session: plan.session,
					rpc: plan.rpc,
					readPref: async () => true,
				}),
		});
		if (submit.kind !== "send") throw new Error("expected send");
		await submit.request();
		// The decision's round trip (main applies stock's plan mode before it answers) ends before the prompt.
		expect(plan.autoModeDecide).toHaveBeenCalledBefore(rpc.prompt);
		expect(planAtPrompt).toBe(true);
		expect(rpc.prompt).toHaveBeenLastCalledWith(BIG, []);
	});
});
