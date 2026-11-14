import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ViewCloseFacts } from "../agent-control/service";
import type { HostConnection } from "./host-server";
import { ViewControl, type ViewTransport } from "./view-control";

function view(host: string, incarnation = "first"): ViewCloseFacts {
	return {
		handle: { viewHost: host, window: "window", tabId: `tab-${host}`, session: "saved", incarnation },
		tab: {
			tabId: `tab-${host}`,
			sessionPath: "/project/saved.jsonl",
			title: "",
			cwd: "/project",
			status: "ready",
			busy: false,
			asks: [],
			hidden: false,
		},
		enabled: true,
		manageEnabled: true,
		fullEnabled: true,
	};
}

function network(beforeCommitGate?: Promise<void>, onChallenge?: (data: unknown) => void) {
	const controls = new Map<string, ViewControl>();
	const rows = new Map<string, ViewCloseFacts[]>([
		["A", []],
		["B", [view("B")]],
		["C", [view("C")]],
	]);
	const channels = new Map<string, { identity: object; conn: HostConnection }>();
	const saved = new Set(["saved"]);
	const execution = new Set(["saved"]);
	const challenges: Array<{ peer: string; identity: object; data: unknown }> = [];
	for (const id of ["A", "B", "C"]) {
		const remote: ViewTransport = {
			peers: () => [...controls.keys()].filter(peer => peer !== id),
			channel: peer => {
				const target = controls.get(peer);
				if (!target) return null;
				const key = `${id}:${peer}`;
				let channel = channels.get(key);
				if (!channel) {
					const identity = {};
					const conn: HostConnection = {
						peer: { deviceId: id, name: id, staticPub: "key", nodeId: id, login: "test", pairedAt: 0 },
						emit: (event, data) => {
							if (event !== "views.challenge") throw new Error("unexpected event");
							challenges.push({ peer, identity, data });
							onChallenge?.(data);
							void controls
								.get(id)
								?.challenge(peer, identity, data)
								.catch(() => {});
						},
						close: () => target.disconnected(id, conn),
					};
					target.connected(id, conn);
					channel = { identity, conn };
					channels.set(key, channel);
				}
				const { identity, conn } = channel;
				return { identity, request: (method, params) => target.call(id, method, params, conn) };
			},
		};
		controls.set(
			id,
			new ViewControl({
				deviceId: () => id,
				listLocal: () => rows.get(id) ?? [],
				closeLocal: async (handle, ...args: unknown[]) => {
					if (id === "B" && beforeCommitGate) await beforeCommitGate;
					const beforeCommit = args[1];
					if (typeof beforeCommit === "function") {
						const current = await beforeCommit();
						if (typeof current !== "function" || !current()) throw new Error("view authorization expired");
					}
					rows.set(
						id,
						(rows.get(id) ?? []).filter(item => item.handle.incarnation !== handle.incarnation),
					);
				},
				remote,
				timeoutMs: 1000,
			}),
		);
	}
	return { controls, rows, channels, challenges, saved, execution };
}

describe("view control", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("lists both remote views and closes only the authorized view", async () => {
		const rig = network();
		const a = rig.controls.get("A")!;
		expect((await a.list()).views.map(item => item.handle.viewHost)).toEqual(["B", "C"]);
		const authorize = vi.fn(async () => {});
		await a.close(view("B").handle, authorize);
		expect(authorize).toHaveBeenCalledOnce();
		expect(rig.rows.get("B")).toEqual([]);
		expect(rig.rows.get("C")).toEqual([view("C")]);
		expect(rig.saved.has("saved")).toBe(true);
		expect(rig.execution.has("saved")).toBe(true);
	});

	it("keeps available views and reports an older unavailable peer", async () => {
		const control = new ViewControl({
			deviceId: () => "A",
			listLocal: () => [],
			closeLocal: async () => {
				throw new Error("unexpected close");
			},
			remote: {
				peers: () => ["B", "C"],
				channel: peer => ({
					identity: {},
					request: async () => {
						if (peer === "C") throw new Error("unsupported method");
						return [view("B")];
					},
				}),
			},
			timeoutMs: 1000,
		});
		expect(await control.list()).toEqual({
			views: [view("B")],
			unavailable: [{ viewHost: "C", reason: "unsupported method" }],
		});
	});

	it("propagates denial and refuses a replaced incarnation", async () => {
		const rig = network();
		const a = rig.controls.get("A")!;
		await expect(
			a.close(view("B").handle, async () => {
				throw new Error("denied");
			}),
		).rejects.toThrow("denied");
		expect(rig.rows.get("B")).toEqual([view("B")]);
		rig.rows.set("B", [view("B", "second")]);
		await expect(a.close(view("B").handle, async () => {})).rejects.toThrow();
		expect(rig.rows.get("B")).toEqual([view("B", "second")]);
	});

	it("refuses to close without an original authorization callback", async () => {
		const rig = network();
		const a = rig.controls.get("A")!;
		await expect(Reflect.apply(a.close, a, [view("B").handle])).rejects.toThrow("authorization unavailable");
		expect(rig.rows.get("B")).toEqual([view("B")]);
	});

	it("rejects changes while authorization is pending", async () => {
		const rig = network();
		const a = rig.controls.get("A")!;
		await expect(
			a.close(view("B").handle, async () => {
				rig.rows.set("B", [view("B", "second")]);
			}),
		).rejects.toThrow();
		expect(rig.rows.get("B")).toEqual([view("B", "second")]);
	});

	it("revalidates the original caller after the renderer is ready to commit", async () => {
		const ready = Promise.withResolvers<void>();
		const initiallyAuthorized = Promise.withResolvers<void>();
		const rig = network(ready.promise);
		let active = true;
		const authorize = vi.fn(async () => {
			initiallyAuthorized.resolve();
		});
		const authorization = Object.assign(authorize, {
			authorize,
			validate: vi.fn(async () => {
				if (!active) throw new Error("caller revoked");
			}),
			current: () => active,
			release: vi.fn(async () => {
				active = false;
			}),
		});
		const closing: Promise<void> = Reflect.apply(rig.controls.get("A")!.close, rig.controls.get("A"), [
			view("B").handle,
			authorization,
		]);
		const denied = expect(closing).rejects.toThrow("caller revoked");
		await Promise.race([initiallyAuthorized.promise, closing]);
		active = false;
		ready.resolve();
		await denied;
		expect(authorization.authorize).toHaveBeenCalledOnce();
		expect(authorization.validate).toHaveBeenCalledOnce();
		expect(authorization.release).toHaveBeenCalledOnce();
		expect(rig.rows.get("B")).toEqual([view("B")]);
		expect(rig.rows.get("C")).toEqual([view("C")]);
	});

	it("refuses a final challenge replay and a disconnected final receipt", async () => {
		const finalChallenge = Promise.withResolvers<void>();
		const validation = Promise.withResolvers<void>();
		const rig = network(undefined, data => {
			const event = z.object({ phase: z.string() }).safeParse(data);
			if (event.success && event.data.phase === "final") finalChallenge.resolve();
		});
		const a = rig.controls.get("A")!;
		const b = rig.controls.get("B")!;
		const authorize = vi.fn(async () => {});
		const authorization = Object.assign(authorize, {
			authorize,
			validate: vi.fn(() => validation.promise),
			current: () => true,
			release: vi.fn(async () => {}),
		});
		const closing: Promise<void> = Reflect.apply(a.close, a, [view("B").handle, authorization]);
		const denied = expect(closing).rejects.toThrow();
		await Promise.race([finalChallenge.promise, closing]);
		const challenge = rig.challenges.at(-1)!;
		const initial = z.object({ nonce: z.string() }).parse(rig.challenges[0]!.data);
		const final = z.object({ nonce: z.string() }).parse(challenge.data);
		expect(final.nonce).not.toBe(initial.nonce);
		await expect(a.challenge("B", challenge.identity, challenge.data)).rejects.toThrow();
		b.disconnected("A", rig.channels.get("A:B")!.conn);
		validation.resolve();
		await denied;
		expect(authorization.validate).toHaveBeenCalledOnce();
		expect(authorization.release).toHaveBeenCalledOnce();
		expect(rig.rows.get("B")).toEqual([view("B")]);
	});

	it("rejects wrong peers, connections, and replayed challenges", async () => {
		const rig = network();
		const a = rig.controls.get("A")!;
		const b = rig.controls.get("B")!;
		const gate = Promise.withResolvers<void>();
		const closing = a.close(view("B").handle, () => gate.promise);
		const challenge = rig.challenges[0]!;
		const parsed = z.object({ token: z.string(), nonce: z.string() }).parse(challenge.data);
		const answer = { ...parsed, handle: view("B").handle };
		const conn = rig.channels.get("A:B")!.conn;
		await expect(b.call("C", "views.authorize", answer, conn)).rejects.toThrow();
		await expect(b.call("A", "views.authorize", answer, { ...conn })).rejects.toThrow();
		await expect(a.challenge("C", challenge.identity, challenge.data)).rejects.toThrow();
		await expect(a.challenge("B", {}, challenge.data)).rejects.toThrow();
		await expect(a.challenge("B", challenge.identity, challenge.data)).rejects.toThrow();
		gate.resolve();
		await closing;
		await expect(b.call("A", "views.authorize", answer, conn)).rejects.toThrow();
	});

	it("rejects a challenge when its connection drops", async () => {
		const rig = network();
		const a = rig.controls.get("A")!;
		const b = rig.controls.get("B")!;
		const gate = Promise.withResolvers<void>();
		const closing = a.close(view("B").handle, () => gate.promise);
		const conn = rig.channels.get("A:B")!.conn;
		b.disconnected("A", conn);
		gate.resolve();
		await expect(closing).rejects.toThrow();
		expect(rig.rows.get("B")).toEqual([view("B")]);
	});

	it("expires an unanswered challenge without closing the view", async () => {
		const rig = network();
		const gate = Promise.withResolvers<void>();
		const closing = rig.controls.get("A")!.close(view("B").handle, () => gate.promise);
		const result = expect(closing).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(1000);
		await result;
		gate.resolve();
		expect(rig.rows.get("B")).toEqual([view("B")]);
	});

	it("requests a close over an incoming-only connection", async () => {
		let a!: ViewControl;
		let b!: ViewControl;
		let visible = [view("B")];
		const peer = (deviceId: string) => ({
			deviceId,
			name: deviceId,
			staticPub: "key",
			nodeId: deviceId,
			login: "test",
			pairedAt: 0,
		});
		const incoming: HostConnection = {
			peer: peer("B"),
			emit: (event, data) => {
				if (event !== "views.request") throw new Error("unexpected event");
				const request = z.object({ requestId: z.string(), method: z.string(), params: z.unknown() }).parse(data);
				void b.call("A", request.method, request.params, outgoing).then(
					result =>
						a.call(
							"B",
							"views.authorize",
							{ kind: "reply", requestId: request.requestId, ok: true, result },
							incoming,
						),
					error =>
						a.call(
							"B",
							"views.authorize",
							{ kind: "reply", requestId: request.requestId, ok: false, error: String(error) },
							incoming,
						),
				);
			},
			close: () => a.disconnected("B", incoming),
		};
		const outgoing: HostConnection = {
			peer: peer("A"),
			emit: (event, data) => {
				if (event !== "views.challenge") throw new Error("unexpected event");
				void a.call("B", "views.authorize", { kind: "event", event, data }, incoming);
			},
			close: () => b.disconnected("A", outgoing),
		};
		a = new ViewControl({
			deviceId: () => "A",
			listLocal: () => [],
			closeLocal: async () => {
				throw new Error("unexpected close");
			},
			remote: { peers: () => ["B"], channel: () => a.incomingChannel("B") },
			timeoutMs: 1000,
		});
		b = new ViewControl({
			deviceId: () => "B",
			listLocal: () => visible,
			closeLocal: async () => {
				visible = [];
			},
			remote: { peers: () => [], channel: () => null },
			timeoutMs: 1000,
		});
		a.connected("B", incoming);
		b.connectedOutgoing(outgoing);
		expect((await a.list()).views).toEqual([view("B")]);
		await a.close(view("B").handle, async () => {});
		expect(visible).toEqual([]);
	});

	it("does not accept an unchallenged success", async () => {
		const control = new ViewControl({
			deviceId: () => "A",
			listLocal: () => [],
			closeLocal: async () => {
				throw new Error("unexpected close");
			},
			remote: { peers: () => ["B"], channel: () => ({ identity: {}, request: async () => "closed" }) },
			timeoutMs: 1000,
		});
		await expect(control.close(view("B").handle, async () => {})).rejects.toThrow("not confirmed");
	});
});
