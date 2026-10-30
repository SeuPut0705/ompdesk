import { afterEach, describe, expect, it, vi } from "vitest";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import type { RemoteLinkState } from "../../shared/ipc-types";
import type { RpcResponse, SidecarStatusPayload } from "../../shared/rpc-types";
import type { BridgeConnectResult } from "../bridge-health";
import type { TabEventMessage, TabStatusArg } from "./app-protocol";
import { createReadEncoder } from "./link-events";
import { PendingTabCloses, type RemoteLink, RemoteSidecar } from "./remote-sidecar";

interface SentRequest {
	method: string;
	params: Record<string, unknown>;
	timeoutMs: number | undefined;
}

/** A RemoteClient stand-in: records requests, answers from per-method handlers, refuses while not online. */
class FakeLink implements RemoteLink {
	readonly deviceId = "host-b";
	state: RemoteLinkState = "online";
	readonly sent: SentRequest[] = [];
	attached = false;
	readonly handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
		"tab.open": params => ({ cwd: `/canonical${String(params.cwd)}`, kind: "agent", attached: this.attached }),
		"tab.command": (): RpcResponse => ({ type: "response", command: "get_state", success: true, data: { ok: 1 } }),
	};

	async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
		if (this.state !== "online") throw Object.assign(new Error("host-b is offline"), { code: "remote_offline" });
		const record = params as Record<string, unknown>;
		this.sent.push({ method, params: record, timeoutMs });
		return (this.handlers[method]?.(record) ?? null) as T;
	}

	methods(): string[] {
		return this.sent.map(request => request.method);
	}
}

function hostStatus(status: TabStatusArg["status"], extra: Partial<TabStatusArg> = {}): TabEventMessage {
	return {
		rtab: "tab-1",
		name: "status",
		arg: {
			status,
			statusPayload: {},
			processAlive: status === "ready",
			cwd: "/canonical/p",
			kind: "agent",
			...extra,
		},
	};
}

function setup(options: { startTimeoutMs?: number; keepOnHost?: () => boolean; cwd?: string } = {}): {
	link: FakeLink;
	sidecar: RemoteSidecar;
	statuses: SidecarStatusPayload[];
	disposed: number[];
	deferredCloses: string[];
	steps: string[];
} {
	const link = new FakeLink();
	const disposed: number[] = [];
	const deferredCloses: string[] = [];
	const steps: string[] = [];
	const sidecar = new RemoteSidecar({
		link,
		rtab: "tab-1",
		cwd: "/p",
		kind: "agent",
		fresh: true,
		offlineMessage: () => "Device offline",
		stalledMessage: seconds => `Host B has not started this session after ${seconds} s`,
		...options,
		log: (step, details) => steps.push(details.step === undefined ? step : `${step} ${String(details.step)}`),
		onDispose: () => disposed.push(1),
		deferClose: rtab => deferredCloses.push(rtab),
	});
	const statuses: SidecarStatusPayload[] = [];
	sidecar.on("status", (payload: SidecarStatusPayload) => statuses.push(payload));
	return { link, sidecar, statuses, disposed, deferredCloses, steps };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("RemoteSidecar", () => {
	it("opens and starts the tab on the host, then re-emits the host's events verbatim", async () => {
		const { link, sidecar, statuses } = setup();
		expect(sidecar.status).toBe("asleep");
		expect(sidecar.rpcClient).toBeNull();
		expect(sidecar.device).toBe("host-b");

		sidecar.start();
		expect(sidecar.status).toBe("starting");
		await settle();
		expect(link.methods()).toEqual(["tab.open", "tab.start"]);
		expect(link.sent[0]?.params).toEqual({ rtab: "tab-1", cwd: "/p", kind: "agent", fresh: true });
		// The host's canonical cwd wins.
		expect(sidecar.cwd).toBe("/canonical/p");

		sidecar.handleEvent(hostStatus("ready", { statusPayload: { modelFallback: "x/y" } }));
		expect(sidecar.status).toBe("ready");
		expect(sidecar.processAlive).toBe(true);
		expect(statuses.at(-1)).toEqual({ status: "ready", cwd: "/canonical/p", modelFallback: "x/y" });

		const events: unknown[] = [];
		sidecar.on("events", (batch: unknown) => events.push(batch));
		sidecar.on("extensionUi", (request: unknown) => events.push(request));
		sidecar.on("hostToolCall", (request: unknown) => events.push(request));
		const batch = [{ type: "agent_start" }];
		sidecar.handleEvent({ rtab: "tab-1", name: "events", arg: batch });
		sidecar.handleEvent({ rtab: "tab-1", name: "extensionUi", arg: { id: "ui-1", method: "confirm" } });
		sidecar.handleEvent({ rtab: "tab-1", name: "hostToolCall", arg: { id: "ht-1", toolName: "gui_notify" } });
		expect(events).toEqual([batch, { id: "ui-1", method: "confirm" }, { id: "ht-1", toolName: "gui_notify" }]);

		const bridges: BridgeConnectResult[] = [];
		sidecar.on("bridge", (result: BridgeConnectResult) => bridges.push(result));
		sidecar.handleEvent({
			rtab: "tab-1",
			name: "bridge",
			arg: { connected: true, ompVersion: "19.0.0", unavailable: [{ feature: "mcp" }] },
		});
		const bridge = bridges[0];
		if (!bridge?.connected) throw new Error("expected a connected bridge result");
		// The capabilities probe is answered from what the host already learned.
		expect(await bridge.bridge.request("capabilities")).toEqual({
			ompVersion: "19.0.0",
			unavailable: [{ feature: "mcp" }],
		});
	});

	describe("a start the host never finishes", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("reports the host by name with Restart's error status once the start outlives its deadline", async () => {
			vi.useFakeTimers();
			const { link, sidecar, statuses, steps } = setup({ startTimeoutMs: 5000 });
			sidecar.start();
			await settle();
			// The host took the tab but its omp never says it runs (a hung start on that computer).
			sidecar.handleEvent(hostStatus("starting"));
			await vi.advanceTimersByTimeAsync(4999);
			expect(sidecar.status).toBe("starting");
			await vi.advanceTimersByTimeAsync(1);
			expect(statuses.at(-1)).toEqual({
				status: "error",
				cwd: "/canonical/p",
				message: "Host B has not started this session after 5 s",
			});
			// Not the host's omp failing: its asks stay routed, and the host may still finish.
			expect(sidecar.statusFromLink).toBe(true);
			expect(steps).toEqual(["open", "start", "stalled ready"]);
			sidecar.handleEvent(hostStatus("ready"));
			expect(sidecar.status).toBe("ready");

			// Restart is a new bring-up with its own deadline.
			sidecar.restart();
			await settle();
			expect(link.methods().at(-1)).toBe("tab.restart");
			await vi.advanceTimersByTimeAsync(5000);
			expect(sidecar.status).toBe("error");
			expect(steps.at(-1)).toBe("stalled ready");
		});

		it("never fires once the host reports the tab running, and logs how the start went", async () => {
			vi.useFakeTimers();
			const { sidecar, steps } = setup({ startTimeoutMs: 5000 });
			sidecar.start();
			await settle();
			sidecar.handleEvent(hostStatus("ready"));
			await vi.advanceTimersByTimeAsync(60_000);
			expect(sidecar.status).toBe("ready");
			expect(steps).toEqual(["open", "start", "ready ready"]);
		});

		it("names a host whose open never answers instead of the link's raw timeout", async () => {
			vi.useFakeTimers();
			const { link, sidecar, steps } = setup();
			// The link gives up on `tab.open` after its own 30 s, before the 60 s start deadline.
			link.handlers["tab.open"] = () =>
				new Promise((_, reject) =>
					setTimeout(
						() => reject(Object.assign(new Error("tab.open timed out after 30000 ms"), { code: "timeout" })),
						30_000,
					),
				);
			sidecar.start();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(sidecar.statusPayload).toMatchObject({
				status: "error",
				message: "Host B has not started this session after 30 s",
			});
			expect(steps).toEqual(["failed open"]);
		});

		it("stalls on a link that never finishes connecting", async () => {
			vi.useFakeTimers();
			const { link, sidecar, steps } = setup({ startTimeoutMs: 5000 });
			link.state = "connecting";
			sidecar.start();
			await vi.advanceTimersByTimeAsync(5000);
			expect(sidecar.status).toBe("error");
			expect(steps).toEqual(["stalled link"]);
			// The link comes up: the tab opens again by itself.
			link.state = "online";
			sidecar.linkStateChanged("online");
			await settle();
			expect(link.methods()).toEqual(["tab.open", "tab.start"]);
			expect(sidecar.status).toBe("starting");
		});
	});

	it("rebuilds a get_autopilot answer sent as a delta, and asks again whole for one it holds no copy of", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		const host = createReadEncoder();
		const status = (cycles: number) => ({ active: true, cycles: Array.from({ length: cycles }, (_, n) => ({ n })) });
		let cycles = 3;
		// The host's encoder answered once for a connection this sidecar never read: its next answer is a delta of a
		// copy the sidecar lacks.
		host(status(2), false);
		link.handlers["tab.command"] = params => ({
			type: "response",
			command: "get_autopilot",
			success: true,
			data: JSON.parse(JSON.stringify(host(status(cycles++), params.fresh === true))),
		});
		const read = () => sidecar.rpcClient?.command({ type: "get_autopilot" });
		await expect(read()).resolves.toMatchObject({ data: status(4) });
		expect(
			link.sent.filter(request => request.method === "tab.command").map(request => request.params.fresh),
		).toEqual([undefined, true]);
		await expect(read()).resolves.toMatchObject({ data: status(5) });
		expect(link.sent.filter(request => request.method === "tab.command")).toHaveLength(3);
	});

	it("keeps a chain per read: the command list and the transcript's tail interleave, each rebuilt from its own copy", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		const hosts = new Map<string, ReturnType<typeof createReadEncoder>>();
		const commands = (n: number) => ({ commands: Array.from({ length: n }, (_, i) => ({ name: `skill:${i}` })) });
		const page = (n: number) => ({
			messages: Array.from({ length: n }, (_, i) => ({ role: "user", i })),
			totalMessages: n,
		});
		let n = 10;
		link.handlers["tab.command"] = params => {
			const command = params.command as { type: string };
			const key = command.type;
			let encode = hosts.get(key);
			if (!encode) {
				encode = createReadEncoder();
				hosts.set(key, encode);
			}
			const data = key === "get_available_commands" ? commands(n) : page(n);
			return {
				type: "response",
				command: key,
				success: true,
				data: JSON.parse(JSON.stringify(encode(data, params.fresh === true))),
			};
		};
		const list = () => sidecar.rpcClient?.command({ type: "get_available_commands" });
		const tail = () => sidecar.rpcClient?.command({ type: "get_transcript_page", fromEnd: true, limit: 200 });
		await expect(list()).resolves.toMatchObject({ data: commands(10) });
		await expect(tail()).resolves.toMatchObject({ data: page(10) });
		n = 11;
		await expect(list()).resolves.toMatchObject({ data: commands(11) });
		await expect(tail()).resolves.toMatchObject({ data: page(11) });
		expect(
			link.sent.filter(request => request.method === "tab.command").map(request => request.params.fresh),
		).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("forwards commands, side-channel frames and lifecycle calls to its rtab on the host", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));

		const response = await sidecar.rpcClient?.command({ type: "get_state" }, 20_000);
		expect(response).toMatchObject({ success: true, data: { ok: 1 } });
		const command = link.sent.find(request => request.method === "tab.command");
		expect(command?.params).toEqual({ rtab: "tab-1", command: { type: "get_state" }, timeoutMs: 20_000 });
		// The link waits for the host's own timeout plus the round trip.
		expect(command?.timeoutMs).toBeGreaterThan(20_000);

		// Sent once the open tab is confirmed, so it is awaited before the next calls.
		await sidecar.sendSideChannel({ type: "host_tool_result", id: "ht-1" });
		sidecar.syncImageGeneration();
		// The host's own reply-language, prompt-suggestion and account-rotation settings apply: nothing goes over the link.
		sidecar.syncReplyLanguage();
		sidecar.syncNextPrompt();
		sidecar.syncAutoTitle();
		sidecar.syncAccountRotation();
		expect(sidecar.adoptCwd("/canonical/p")).toBe(false);
		expect(sidecar.adoptCwd("/elsewhere")).toBe(true);
		sidecar.restart(undefined, "/s/next.jsonl");
		await settle();
		expect(link.sent.slice(-4).map(request => [request.method, request.params])).toEqual([
			["tab.sideChannel", { rtab: "tab-1", frame: { type: "host_tool_result", id: "ht-1" } }],
			["tab.syncImageGeneration", { rtab: "tab-1" }],
			["tab.adoptCwd", { rtab: "tab-1", cwd: "/elsewhere" }],
			["tab.restart", { rtab: "tab-1", sessionPath: "/s/next.jsonl" }],
		]);
	});

	it("marks the statuses it derives from the link apart from the ones the host's omp reports", async () => {
		const { link, sidecar } = setup();
		const seen: Array<[string, boolean | undefined]> = [];
		sidecar.on("status", (payload: SidecarStatusPayload) => seen.push([payload.status, sidecar.statusFromLink]));
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		link.state = "online";
		link.attached = true;
		sidecar.linkStateChanged("online");
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		sidecar.handleEvent(hostStatus("restarting"));
		expect(seen).toEqual([
			["starting", true],
			["ready", false],
			["error", true],
			["starting", true],
			["ready", false],
			["restarting", false],
		]);
	});

	it("hands the pool the host's reading of the turn, and drops a malformed one", () => {
		const { sidecar } = setup();
		const runs: unknown[] = [];
		sidecar.on("hostRun", run => runs.push(run));
		sidecar.handleEvent({ rtab: "tab-1", name: "run", arg: { running: true, turn: false, elapsedMs: 1200 } });
		sidecar.handleEvent({ rtab: "tab-1", name: "run", arg: { running: "yes" } });
		expect(runs).toEqual([{ running: true, turn: false, elapsedMs: 1200 }]);
	});

	describe("a re-attach after a lost link", () => {
		/** Start on omp `first`, lose the link, re-attach (`attached`), and return what the page heard from then on. */
		async function reattach(first: string | undefined, attached: boolean, again?: string): Promise<unknown[]> {
			const { link, sidecar, statuses } = setup();
			sidecar.start();
			await settle();
			sidecar.handleEvent(hostStatus("ready", first === undefined ? {} : { omp: first }));
			link.state = "offline";
			sidecar.linkStateChanged("offline");
			const from = statuses.length;
			link.state = "online";
			link.attached = attached;
			sidecar.linkStateChanged("online");
			await settle();
			if (again !== undefined) sidecar.handleEvent(hostStatus("ready", { omp: again }));
			return statuses.slice(from).map(({ status, reconnecting }) => (reconnecting ? `${status} (kept)` : status));
		}

		it("keeps the page while the host re-sends the omp it shows", async () => {
			expect(await reattach("omp-1", true, "omp-1")).toEqual(["starting (kept)", "ready"]);
		});

		it("starts the page over when the host's omp restarted while the link was down", async () => {
			expect(await reattach("omp-1", true, "omp-2")).toEqual(["starting (kept)", "starting", "ready"]);
		});

		it("starts the page over when the host no longer held the tab", async () => {
			expect(await reattach("omp-1", false)).toEqual(["starting (kept)", "starting"]);
		});

		it("starts the page over for a host that does not name its omp", async () => {
			expect(await reattach(undefined, true, "omp-1")).toEqual(["starting", "ready"]);
		});
	});

	it("reports a host's refusal to re-attach as the host's status, not a link blip", async () => {
		const { link, sidecar } = setup();
		const seen: Array<[string, boolean | undefined]> = [];
		sidecar.on("status", (payload: SidecarStatusPayload) => seen.push([payload.status, sidecar.statusFromLink]));
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		// The link is back, but the host no longer runs that tab and has no workspace to open it in.
		link.state = "online";
		link.handlers["tab.open"] = () => {
			throw new Error("No workspace");
		};
		sidecar.linkStateChanged("online");
		await settle();
		expect(seen.at(-1)).toEqual(["error", false]);
		expect(sidecar.statusPayload).toMatchObject({ status: "error", message: "No workspace" });
	});

	it("passes on a host tab's wait for another omp there to let go of its session, so the pane shows a wait", async () => {
		const { sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(
			hostStatus("error", { statusPayload: { message: "still open in another omp", sessionHeld: true } }),
		);
		expect(sidecar.statusPayload).toMatchObject({ status: "error", sessionHeld: true });
	});

	it("hands a host's session_deleted refusal to the pool as a deleted session, never an error tab", async () => {
		const { link, sidecar, statuses } = setup();
		const deleted: Array<string | null> = [];
		sidecar.on("sessionDeleted", (sessionPath: string | null) => deleted.push(sessionPath));
		link.handlers["tab.open"] = () => {
			throw codedError("session_deleted", "Session was deleted");
		};
		sidecar.restart(undefined, "/s/gone.jsonl");
		await settle();
		expect(deleted).toEqual(["/s/gone.jsonl"]);
		expect(statuses.map(entry => entry.status)).not.toContain("error");
	});

	// The user's report (29 Oct 2026): a device's relaunch restored its tabs on two sessions whose worktrees the host's
	// disk care had removed once their work landed; the one on screen opened, was refused, and stayed an error tab that
	// kept the finished session listed.
	it("hands a host's missing-folder refusal of a finished OMPdesk worktree to the pool to close; any other folder stays an error", async () => {
		const finished = setup({ cwd: "/Users/kim/.omp/wt/gui-f-07-e-contracts-3795397" });
		const missing = () => {
			throw codedError("session_folder_missing", "The folder this session belongs in no longer exists");
		};
		let gone = 0;
		finished.sidecar.on("folderGone", () => gone++);
		finished.link.handlers["tab.open"] = missing;
		finished.sidecar.restart(undefined, "/s/f07.jsonl");
		await settle();
		expect(gone).toBe(1);
		expect(finished.statuses.map(entry => entry.status)).not.toContain("error");

		// A project folder that is gone is not finished work: the tab says so and stays.
		const plain = setup({ cwd: "/tmp/scratch-3" });
		let plainGone = 0;
		plain.sidecar.on("folderGone", () => plainGone++);
		plain.link.handlers["tab.open"] = missing;
		plain.sidecar.restart(undefined, "/s/scratch.jsonl");
		await settle();
		expect(plainGone).toBe(0);
		expect(plain.statuses.at(-1)?.status).toBe("error");
	});

	it("hands on the open asks the host re-sends with each re-attach, and ignores a malformed list", async () => {
		const { link, sidecar } = setup();
		const ask = { type: "extension_ui_request", id: "ask-1", method: "ask", questions: [] };
		const approval = {
			type: "extension_ui_request",
			id: "ok-1",
			method: "select",
			title: "Allow tool: x",
			options: [],
		};
		let hostAsks: unknown = [ask];
		// The host still holds the tab: it sends the live status and its omp's open asks ahead of the answer.
		link.attached = true;
		link.handlers["tab.open"] = params => {
			sidecar.handleEvent(hostStatus("ready"));
			sidecar.handleEvent({ rtab: "tab-1", name: "openAsks", arg: hostAsks });
			return { cwd: `/canonical${String(params.cwd)}`, kind: "agent", attached: link.attached };
		};
		const lists: unknown[] = [];
		sidecar.on("openAsks", (requests: unknown) => lists.push(requests));
		const seen: string[] = [];
		sidecar.on("status", (payload: SidecarStatusPayload) => seen.push(payload.status));
		sidecar.on("openAsks", () => seen.push("openAsks"));
		sidecar.start();
		await settle();
		expect(lists).toEqual([[ask]]);

		// The link drops and comes back: the reconnect's `starting` comes first, then the host's list.
		const reconnect = async (asks: unknown) => {
			hostAsks = asks;
			link.state = "offline";
			sidecar.linkStateChanged("offline");
			link.state = "online";
			seen.length = 0;
			sidecar.linkStateChanged("online");
			await settle();
		};
		await reconnect([approval]);
		expect(seen).toEqual(["starting", "ready", "openAsks"]);
		expect(lists.at(-1)).toEqual([approval]);
		// The host's omp restarted while the link was down: nothing is open any more.
		await reconnect([]);
		expect(lists.at(-1)).toEqual([]);

		// A list that names a non-blocking request, or an entry without an id, replaces nothing.
		const before = lists.length;
		await reconnect([ask, { type: "extension_ui_request", id: "n", method: "notify", message: "hi" }]);
		await reconnect([{ type: "extension_ui_request", method: "confirm" }]);
		await reconnect({ id: "ask-1" });
		expect(lists).toHaveLength(before);
	});

	it("hands on the sign-ins the host reports running, and ignores a malformed report", () => {
		const { sidecar } = setup();
		const reports: unknown[] = [];
		sidecar.on("signIn", (arg: unknown) => reports.push(arg));
		sidecar.handleEvent({ rtab: "tab-1", name: "signIn", arg: { active: ["anthropic"] } });
		sidecar.handleEvent({
			rtab: "tab-1",
			name: "signIn",
			arg: { active: [], ended: { providerId: "anthropic", error: null } },
		});
		sidecar.handleEvent({ rtab: "tab-1", name: "signIn", arg: { active: "anthropic" } });
		sidecar.handleEvent({ rtab: "tab-1", name: "signIn", arg: { active: [], ended: { providerId: "anthropic" } } });
		expect(reports).toEqual([
			{ active: ["anthropic"] },
			{ active: [], ended: { providerId: "anthropic", error: null } },
		]);
	});

	it("goes to error with the offline message and refuses commands while the link is down", async () => {
		const { link, sidecar, statuses } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		sidecar.handleEvent({ rtab: "tab-1", name: "session", arg: { sessionId: "s1", sessionFile: "/s/one.jsonl" } });

		link.state = "offline";
		sidecar.linkStateChanged("offline");
		expect(sidecar.status).toBe("error");
		expect(sidecar.offline).toBe(true);
		expect(sidecar.processAlive).toBe(false);
		expect(statuses.at(-1)).toEqual({ status: "error", cwd: "/canonical/p", message: "Device offline" });
		// Flapping between connecting and offline during backoff reports once.
		sidecar.linkStateChanged("connecting");
		sidecar.linkStateChanged("offline");
		expect(statuses.filter(status => status.message === "Device offline")).toHaveLength(1);

		const refused = await sidecar.rpcClient?.command({ type: "get_state" }).catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("remote_offline");
	});

	it("refuses a user's answer with remote_offline while the link is down, so its card stays answerable", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		link.state = "offline";
		sidecar.linkStateChanged("offline");

		const sentBefore = link.sent.length;
		let thrown: unknown;
		try {
			sidecar.sendSideChannel({ type: "extension_ui_response", id: "x", confirmed: true });
		} catch (error) {
			thrown = error;
		}
		expect(ipcErrorCode(thrown)).toBe("remote_offline");
		expect(link.sent).toHaveLength(sentBefore);

		// Back online and re-attached, the same answer goes through.
		link.state = "online";
		link.attached = true;
		sidecar.linkStateChanged("online");
		await settle();
		sidecar.sendSideChannel({ type: "extension_ui_response", id: "x", confirmed: true });
		await settle();
		expect(link.sent.at(-1)).toMatchObject({
			method: "tab.sideChannel",
			params: { rtab: "tab-1", frame: { type: "extension_ui_response", id: "x", confirmed: true } },
		});
	});

	it("keeps replies to the host's tool calls through a link drop and sends them once the host tab is re-attached", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		link.state = "offline";
		sidecar.linkStateChanged("offline");

		sidecar.sendSideChannel({ type: "host_tool_result", id: "ht-1" });
		sidecar.sendSideChannel({ type: "host_uri_result", id: "hu-1", isError: true });
		expect(link.methods()).not.toContain("tab.sideChannel");

		link.state = "online";
		link.attached = true;
		sidecar.linkStateChanged("online");
		await settle();
		expect(
			link.sent.filter(request => request.method === "tab.sideChannel").map(request => request.params.frame),
		).toEqual([
			{ type: "host_tool_result", id: "ht-1" },
			{ type: "host_uri_result", id: "hu-1", isError: true },
		]);
	});

	it("drops those replies when the host started a new omp, which never made the calls", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		sidecar.sendSideChannel({ type: "host_tool_result", id: "ht-1" });

		link.state = "online";
		link.attached = false;
		sidecar.linkStateChanged("online");
		await settle();
		expect(link.methods()).not.toContain("tab.sideChannel");
	});

	it("keeps a reply the link dropped under for the next link", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		link.handlers["tab.sideChannel"] = () => {
			throw Object.assign(new Error("host-b is offline"), { code: "remote_offline" });
		};
		sidecar.sendSideChannel({ type: "host_tool_result", id: "ht-1" });
		await settle();
		delete link.handlers["tab.sideChannel"];

		link.state = "offline";
		sidecar.linkStateChanged("offline");
		link.state = "online";
		link.attached = true;
		const before = link.sent.length;
		sidecar.linkStateChanged("online");
		await settle();
		expect(
			link.sent
				.slice(before)
				.filter(request => request.method === "tab.sideChannel")
				.map(request => request.params.frame),
		).toEqual([{ type: "host_tool_result", id: "ht-1" }]);
	});

	it("rejects a user's answer the link drops mid-send, and one the host refuses, so its card stays", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		link.handlers["tab.sideChannel"] = () => {
			throw Object.assign(new Error("host-b is offline"), { code: "remote_offline" });
		};
		const answer = { type: "extension_ui_response", id: "x", confirmed: true };
		const dropped = Promise.resolve(sidecar.sendSideChannel(answer));
		await expect(dropped).rejects.toSatisfy(error => ipcErrorCode(error) === "remote_offline");

		link.handlers["tab.sideChannel"] = () => {
			throw new Error("Unknown tab");
		};
		await expect(Promise.resolve(sidecar.sendSideChannel(answer))).rejects.toThrow("Unknown tab");

		delete link.handlers["tab.sideChannel"];
		await expect(Promise.resolve(sidecar.sendSideChannel(answer))).resolves.toBeUndefined();
	});

	it("sends an answer only after the host finished re-attaching the tab", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		link.state = "offline";
		sidecar.linkStateChanged("offline");

		// The re-attach is still on its way when the answer arrives.
		const { promise: reopened, resolve: reopen } = Promise.withResolvers<unknown>();
		link.handlers["tab.open"] = () => reopened;
		link.state = "online";
		sidecar.linkStateChanged("online");
		await settle();
		const sent = Promise.resolve(sidecar.sendSideChannel({ type: "extension_ui_response", id: "x", value: "a" }));
		await settle();
		expect(link.methods().at(-1)).toBe("tab.open");
		reopen({ cwd: "/canonical/p", kind: "agent", attached: true });
		await sent;
		expect(link.methods().slice(-1)).toEqual(["tab.sideChannel"]);
	});

	it("closes its host tab on dispose, or hands the close to its owner when the host cannot be reached", async () => {
		const online = setup();
		online.sidecar.start();
		await settle();
		online.sidecar.dispose();
		await settle();
		expect(online.link.methods().at(-1)).toBe("tab.close");
		expect(online.deferredCloses).toEqual([]);

		const offline = setup();
		offline.sidecar.start();
		await settle();
		offline.sidecar.handleEvent(hostStatus("ready"));
		offline.link.state = "offline";
		offline.sidecar.linkStateChanged("offline");
		offline.sidecar.dispose();
		expect(offline.deferredCloses).toEqual(["tab-1"]);

		// The link drops under the close itself.
		const dropping = setup();
		dropping.sidecar.start();
		await settle();
		dropping.link.handlers["tab.close"] = () => {
			throw Object.assign(new Error("host-b is offline"), { code: "remote_offline" });
		};
		dropping.sidecar.dispose();
		await settle();
		expect(dropping.deferredCloses).toEqual(["tab-1"]);

		// A tab never opened on the host has nothing to close there.
		const unopened = setup();
		unopened.link.state = "offline";
		unopened.sidecar.dispose();
		expect(unopened.deferredCloses).toEqual([]);
	});

	it("leaves its host tab running when the app quits with its work to continue, and closes it otherwise", async () => {
		let quitting = true;
		const online = setup({ keepOnHost: () => quitting });
		online.sidecar.start();
		await settle();
		online.sidecar.handleEvent(hostStatus("ready"));
		online.sidecar.dispose();
		await settle();
		// The host owns the turn it runs: it keeps the tab through its grace period and the relaunched device adopts it.
		expect(online.link.methods()).not.toContain("tab.close");
		expect(online.deferredCloses).toEqual([]);

		const offline = setup({ keepOnHost: () => quitting });
		offline.sidecar.start();
		await settle();
		offline.link.state = "offline";
		offline.sidecar.linkStateChanged("offline");
		offline.sidecar.dispose();
		expect(offline.deferredCloses).toEqual([]);

		quitting = false;
		const closed = setup({ keepOnHost: () => quitting });
		closed.sidecar.start();
		await settle();
		closed.sidecar.dispose();
		await settle();
		expect(closed.link.methods().at(-1)).toBe("tab.close");
	});

	it("passes on the host's delete of its session", () => {
		const { sidecar } = setup();
		const deleted: Array<string | null> = [];
		sidecar.on("sessionDeleted", (path: string | null) => deleted.push(path));
		sidecar.handleEvent({ rtab: "tab-1", name: "sessionDeleted", arg: "/s/one.jsonl" });
		sidecar.handleEvent({ rtab: "tab-1", name: "sessionDeleted", arg: 7 });
		expect(deleted).toEqual(["/s/one.jsonl"]);
	});

	it("resumes when the link returns: re-attaches a running host tab, or restarts on the newest session", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		sidecar.handleEvent({ rtab: "tab-1", name: "session", arg: { sessionId: "s1", sessionFile: "/s/one.jsonl" } });

		// Within the host's grace period: re-attach, no new start.
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		link.state = "online";
		link.attached = true;
		const before = link.sent.length;
		sidecar.linkStateChanged("online");
		expect(sidecar.status).toBe("starting");
		await settle();
		expect(link.sent.slice(before).map(request => request.method)).toEqual(["tab.open"]);
		expect(link.sent[before]?.params).toMatchObject({ sessionPath: "/s/one.jsonl" });
		sidecar.handleEvent(hostStatus("ready"));
		expect(sidecar.status).toBe("ready");
		expect(sidecar.offline).toBe(false);

		// After the grace period the host forgot the tab: open + start resume the session file.
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		link.state = "online";
		link.attached = false;
		const later = link.sent.length;
		sidecar.linkStateChanged("online");
		await settle();
		expect(link.sent.slice(later).map(request => request.method)).toEqual(["tab.open", "tab.start"]);
	});

	it("never brings up a tab nobody started, and closes its host tab on dispose", async () => {
		const { link, sidecar, disposed } = setup();
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		link.state = "online";
		sidecar.linkStateChanged("online");
		await settle();
		expect(sidecar.status).toBe("asleep");
		expect(link.sent).toEqual([]);

		sidecar.start();
		await settle();
		sidecar.dispose();
		expect(link.methods().at(-1)).toBe("tab.close");
		expect(disposed).toEqual([1]);
		sidecar.dispose();
		expect(disposed).toEqual([1]);
	});

	it("mirrors the host's connection wait and sends the user's Cancel to the host", async () => {
		const { link, sidecar } = setup();
		const waits: boolean[] = [];
		sidecar.on("awaitingConnection", (awaiting: boolean) => waits.push(awaiting));
		sidecar.start();
		await settle();
		sidecar.handleEvent({ rtab: "tab-1", name: "awaitingConnection", arg: true });
		sidecar.handleEvent({ rtab: "tab-1", name: "awaitingConnection", arg: "yes" });
		sidecar.handleEvent({ rtab: "tab-1", name: "awaitingConnection", arg: false });
		expect(waits).toEqual([true, false]);

		await sidecar.cancelHostWait();
		expect(link.sent.at(-1)).toMatchObject({ method: "tab.cancelWait", params: { rtab: "tab-1" } });
		link.state = "offline";
		const refused = await sidecar.cancelHostWait().catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("remote_offline");
	});

	it("mirrors the host's scheduled retry by this computer's clock; an unreadable one is dropped", async () => {
		const { sidecar } = setup();
		const retries: unknown[] = [];
		sidecar.on("scheduledRetry", (retry: unknown) => retries.push(retry));
		sidecar.start();
		await settle();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		try {
			// The host sends what is left, never its own clock: the two computers' clocks may differ.
			sidecar.handleEvent({
				rtab: "tab-1",
				name: "scheduledRetry",
				arg: { remainingMs: 30_000, attempt: 1 },
			});
			sidecar.handleEvent({ rtab: "tab-1", name: "scheduledRetry", arg: { remainingMs: -5, attempt: 1 } });
			sidecar.handleEvent({ rtab: "tab-1", name: "scheduledRetry", arg: { at: 5, attempt: 1 } });
			sidecar.handleEvent({ rtab: "tab-1", name: "scheduledRetry", arg: null });
		} finally {
			now.mockRestore();
		}
		expect(retries).toEqual([{ at: 1_030_000, attempt: 1 }, undefined]);
	});

	it("starts a restored tab on its session without restarting the omp a host still runs for it", async () => {
		const { link, sidecar } = setup();
		link.attached = true;
		sidecar.restart(undefined, "/s/one.jsonl");
		await settle();
		expect(link.methods()).toEqual(["tab.open"]);
		expect(link.sent[0]?.params).toMatchObject({ sessionPath: "/s/one.jsonl" });

		// Once running, a restart is a restart.
		sidecar.handleEvent(hostStatus("ready"));
		sidecar.restart(undefined, "/s/one.jsonl");
		await settle();
		expect(link.methods()).toEqual(["tab.open", "tab.restart"]);
	});
});

describe("PendingTabCloses", () => {
	it("sends each deferred close once the link is back, and keeps one the link refuses", async () => {
		const closes = new PendingTabCloses();
		closes.defer("a");
		closes.defer("b");
		closes.defer("c");
		closes.cancel("c");
		const sent: string[] = [];
		closes.flush(async rtab => {
			sent.push(rtab);
			if (rtab === "b") throw Object.assign(new Error("offline"), { code: "remote_offline" });
		});
		await settle();
		expect(sent).toEqual(["a", "b"]);

		const again: string[] = [];
		closes.flush(async rtab => {
			again.push(rtab);
		});
		await settle();
		expect(again).toEqual(["b"]);
		closes.flush(async rtab => {
			again.push(rtab);
		});
		expect(again).toEqual(["b"]);
	});
});
