import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { DesktopSlotState } from "../../resources/gui-bridge/desktop-slot-contracts";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { DesktopSlotHost } from "./desktop-slot-host";
import type { SidecarLike } from "./sidecar-types";

interface BridgeCall {
	tab: string;
	method: string;
	params: unknown;
}

class FakeSidecar extends EventEmitter {
	device: string | undefined;
	aborted = 0;
	restarts = 0;
	/** The omp process: its exit is what proves the session is gone. */
	readonly exit = Promise.withResolvers<void>();
	/** Whether a restart ends the process (SIGTERM honoured). */
	exitsOnRestart = true;
	readonly rpcClient: { command(command: RpcCommand): Promise<RpcResponse> };
	constructor(
		readonly cwd: string,
		private readonly world: World,
		private readonly tab: string,
	) {
		super();
		this.rpcClient = {
			command: async command => {
				if (command.type === "abort") this.aborted++;
				if (command.type === "desktop_slot_bridge") {
					this.world.calls.push({ tab: this.tab, method: command.method, params: command.params });
					await this.world.revokeGate?.();
					if (command.method === "desktop_slot.revoke" && this.world.revokeFails) {
						return {
							type: "response",
							success: false,
							error: "Timed out revoking computer control",
						} as RpcResponse;
					}
				}
				return { type: "response", success: true } as RpcResponse;
			},
		};
	}

	whenExited(): Promise<void> {
		return this.exit.promise;
	}

	restart(): void {
		this.restarts++;
		if (this.exitsOnRestart) this.exit.resolve();
	}

	/** The process exits, then the manager reports it. */
	die(status = "exited"): void {
		this.exit.resolve();
		this.emit("status", { status });
	}
}

class World {
	calls: BridgeCall[] = [];
	states: DesktopSlotState[] = [];
	stopped: string[] = [];
	titles = new Map<string, string>();
	revokeGate: (() => Promise<void>) | undefined;
	revokeFails = false;
	readonly host = new DesktopSlotHost({
		killConfirmMs: 50,
		pool: {
			tabFacts: tabId => (this.titles.has(tabId) ? { title: this.titles.get(tabId) ?? "" } : null),
			noteStopped: tabId => this.stopped.push(tabId),
		},
		broadcast: state => this.states.push(state),
	});

	tab(tabId: string, title: string): FakeSidecar {
		const sidecar = new FakeSidecar(`/work/${tabId}`, this, tabId);
		this.titles.set(tabId, title);
		this.host.attachSidecar(tabId, sidecar as unknown as SidecarLike);
		return sidecar;
	}

	frame(sidecar: FakeSidecar, frame: Record<string, unknown>): void {
		this.host.frame(sidecar as unknown as SidecarLike, frame);
	}
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 25; i++) await Promise.resolve();
};

describe("DesktopSlotHost", () => {
	it("grants a free slot through the bridge and shows the session by its title", async () => {
		const world = new World();
		const a = world.tab("a", "Fix the build");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		await flush();
		expect(world.calls).toEqual([
			{ tab: "a", method: "desktop_slot.grant", params: { requestId: "r1", waited: false } },
		]);
		expect(world.states.at(-1)?.holder).toMatchObject({ tabId: "a", title: "Fix the build" });
	});

	it("queues a second tab, and grants it as waited once the holder releases", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		expect(world.host.state().queue).toEqual([{ tabId: "b", title: "B" }]);
		expect(world.calls.filter(call => call.tab === "b")).toEqual([]);
		world.frame(a, { type: "desktop_slot_release", reason: "turn_end" });
		await flush();
		expect(world.calls.at(-1)).toEqual({
			tab: "b",
			method: "desktop_slot.grant",
			params: { requestId: "r2", waited: true },
		});
	});

	it("revokes a released (closed) holder's tab before the next session is granted", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		const gate = Promise.withResolvers<void>();
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		world.revokeGate = () => gate.promise;
		world.host.observeActivity({ type: "released", tabId: "a" });
		await flush();
		expect(world.calls.at(-1)).toEqual({ tab: "a", method: "desktop_slot.revoke", params: { reason: "closed" } });
		expect(world.calls.filter(call => call.tab === "b")).toEqual([]);
		gate.resolve();
		await flush();
		expect(world.calls.at(-1)).toMatchObject({ tab: "b", method: "desktop_slot.grant" });
	});

	it("drops a holder whose process went away, without a revoke", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		a.die();
		await flush();
		expect(world.calls.some(call => call.method === "desktop_slot.revoke")).toBe(false);
		expect(world.host.state().holder?.tabId).toBe("b");
	});

	it("keeps the slot through a health-check `error` over a live process", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		a.emit("status", { status: "error" });
		expect(world.host.state().holder?.tabId).toBe("a");
	});

	it("stop aborts the holder's run, revokes it and hands the slot on", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		await world.host.stop();
		expect(a.aborted).toBe(1);
		expect(world.stopped).toEqual(["a"]);
		expect(world.calls.map(call => `${call.tab}:${call.method}`)).toEqual([
			"a:desktop_slot.grant",
			"a:desktop_slot.revoke",
			"b:desktop_slot.grant",
		]);
	});

	it("does not hand over when the holder's revoke fails; the process exiting afterwards does", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		world.revokeFails = true;
		await world.host.stop();
		expect(world.host.state().holder).toMatchObject({ tabId: "a", revokeFailed: true });
		expect(world.calls.filter(call => call.tab === "b")).toEqual([]);
		a.die();
		await flush();
		expect(world.host.state().holder?.tabId).toBe("b");
		expect(world.calls.at(-1)).toMatchObject({ tab: "b", method: "desktop_slot.grant" });
	});

	it("does not treat a status change as the holder's death until its process has exited", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		a.emit("status", { status: "ready" });
		a.emit("status", { status: "starting" });
		await flush();
		expect(world.host.state().holder?.tabId).toBe("a");
		a.exit.resolve();
		await flush();
		expect(world.host.state().holder?.tabId).toBe("b");
	});

	it("retries the revoke on the user's try-again and frees the slot once it is confirmed", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		await flush();
		world.revokeFails = true;
		await world.host.stop();
		expect(world.host.state().holder?.revokeFailed).toBe(true);
		world.revokeFails = false;
		world.host.retry();
		await flush();
		expect(world.host.state().holder).toBeNull();
	});

	it("kills the failed session's omp and frees the slot only when it has exited", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		world.revokeFails = true;
		await world.host.stop();
		// An omp that ignores the signal is not confirmed gone: the slot stays with it.
		a.exitsOnRestart = false;
		expect(await world.host.killHolder()).toBe(false);
		expect(a.restarts).toBe(1);
		expect(world.host.state().holder?.tabId).toBe("a");
		a.exitsOnRestart = true;
		expect(await world.host.killHolder()).toBe(true);
		expect(world.host.state().holder?.tabId).toBe("b");
	});

	it("does nothing on stop when nobody holds the slot", async () => {
		const world = new World();
		await world.host.stop();
		expect(world.calls).toEqual([]);
		expect(world.stopped).toEqual([]);
	});

	it("leaves a tab on a paired host to that host's slot", async () => {
		const world = new World();
		const remote = new FakeSidecar("/x", world, "r");
		remote.device = "dev-1";
		world.host.attachSidecar("remote-tab", remote as unknown as SidecarLike);
		remote.emit("status", { status: "exited" });
		expect(world.host.state()).toEqual({ holder: null, queue: [] });
	});

	it("serves a tab this host runs for a paired device, named after its folder", async () => {
		const world = new World();
		const hosted = new FakeSidecar("/work/shared-project", world, "hosted");
		world.frame(hosted, { type: "desktop_slot_acquire", requestId: "h1" });
		await flush();
		expect(world.host.state().holder?.title).toBe("shared-project");
		expect(world.calls).toEqual([
			{ tab: "hosted", method: "desktop_slot.grant", params: { requestId: "h1", waited: false } },
		]);
	});

	it("ignores an acquire without a request id", () => {
		const world = new World();
		const a = world.tab("a", "A");
		world.frame(a, { type: "desktop_slot_acquire" });
		expect(world.host.state().holder).toBeNull();
	});
});
