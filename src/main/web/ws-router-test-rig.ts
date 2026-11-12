/**
 * The core's page router without its edge (`web.router.test.*` in `native/ompdesk/crates/core/src/web/router.rs`),
 * for main's tests: a `WsRouter` whose core side runs on the clock and, by default, the batch and heartbeat timers the
 * test drives, its devices' grants set here, and each page socket's frames read back as the page would get them.
 * Every call answers after the frames it caused, so a test reads them once it awaited the call.
 */
import type { WebPermission, WebServerFrame } from "../../shared/web-protocol";
import { type CoreProcess, core } from "../core/process";
import { WsRouter, type WsRouterDeps } from "./ws-router";

interface Sent {
	host: number;
	socket: number;
	kind: "text" | "ping" | "close" | "terminate";
	text?: string;
	code?: number;
	reason?: string;
}

/** One page socket as the core's router wrote to it. */
export class TestSocket {
	readonly sent: WebServerFrame[] = [];
	closed: { code: number; reason: string } | null = null;
	terminated = false;
	pings = 0;
	/** Called with each frame as it comes. */
	onFrame: ((frame: WebServerFrame) => void) | null = null;

	take(sent: Sent): void {
		if (sent.kind === "text" && sent.text !== undefined) {
			const frame = JSON.parse(sent.text) as WebServerFrame;
			this.sent.push(frame);
			this.onFrame?.(frame);
		} else if (sent.kind === "ping") this.pings += 1;
		else if (sent.kind === "close") this.closed ??= { code: sent.code ?? 0, reason: sent.reason ?? "" };
		else this.terminated = true;
	}

	frames<T extends WebServerFrame["t"]>(type: T): Extract<WebServerFrame, { t: T }>[] {
		return this.sent.filter((frame): frame is Extract<WebServerFrame, { t: T }> => frame.t === type);
	}
}

const sockets = new Map<string, TestSocket>();
let listening: CoreProcess | null = null;

function socketOf(host: number, socket: number): TestSocket {
	const key = `${host}:${socket}`;
	let found = sockets.get(key);
	if (!found) {
		found = new TestSocket();
		sockets.set(key, found);
	}
	return found;
}

function listen(): void {
	const process = core();
	if (listening === process) return;
	listening = process;
	process.on("web.router.test.sent", data => {
		const sent = data as Sent;
		socketOf(sent.host, sent.socket).take(sent);
	});
}

/** A page connection the test holds: its socket and what the edge would do with it. */
export interface TestConnection {
	readonly socket: TestSocket;
	readonly connId: string;
	receive(text: string): Promise<void>;
	/** The socket ended on its own. */
	dispose(): Promise<void>;
	/** The edge closed it (a binary frame). */
	close(code: number, reason: string): Promise<void>;
}

export class TestRouterHost {
	readonly router: WsRouter;
	/** The core router's clock; every call hands it over first. */
	readonly clock: { now: number };

	private constructor(router: WsRouter, now: number) {
		this.router = router;
		this.clock = { now };
	}

	/** A router whose core side has no edge; `timers: "real"` lets the core batch and ping on its own. */
	static async open(
		deps: WsRouterDeps,
		options: { now?: number; timers?: "manual" | "real" } = {},
	): Promise<TestRouterHost> {
		listen();
		const router = new WsRouter(deps);
		const host = new TestRouterHost(router, options.now ?? 1_000_000);
		await core().call("web.router.test.open", {
			host: router.host,
			now: host.clock.now,
			manualTimers: options.timers !== "real",
			config: router.config(),
		});
		return host;
	}

	async op<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
		const { result } = await core().call<T>("web.router.test", {
			host: this.router.host,
			now: this.clock.now,
			op,
			...params,
		});
		return result;
	}

	/** Everything main and the core sent each other before this has been handled on both sides. */
	async sync(): Promise<void> {
		await this.op("sync");
	}

	/** A paired device's grants, or none: revoked. */
	async device(deviceId: string, grants: readonly WebPermission[] | null): Promise<void> {
		await this.op("device", { device: deviceId, grants });
	}

	/** A page socket the edge accepted, once its hello went out; null when the device already has its four. */
	async attach(deviceId: string, resumeFrom?: string): Promise<TestConnection | null> {
		const attached = await this.op<{ socket: number } | null>("attach", { device: deviceId, resumeFrom });
		if (!attached) return null;
		// A first hello waits for main to prepare the page's resync (`web.resync` → `web.resynced`).
		await this.sync();
		const number = attached.socket;
		const socket = socketOf(this.router.host, number);
		const connId = socket.frames("hello")[0]?.connId ?? "";
		return {
			socket,
			connId,
			receive: async text => {
				await this.op("receive", { socket: number, text });
				await this.sync();
			},
			dispose: () => this.op("dispose", { socket: number }),
			close: (code, reason) => this.op("close", { socket: number, code, text: reason }),
		};
	}

	/** The edge saw the page come back on a new socket: its old connection of that id ends (`resume.<connId>`). */
	async retire(deviceId: string, connId: string): Promise<void> {
		await this.op("retire", { device: deviceId, text: connId });
	}

	/** Every batch window open now, closed (the 75 ms timer fired). */
	async flush(): Promise<void> {
		await this.op("flush");
	}

	/** One heartbeat tick of every connection. */
	async tick(): Promise<void> {
		await this.op("tick");
	}

	/** The batch windows open now, by the delay each was armed with. */
	async pending(): Promise<number[]> {
		return this.op<number[]>("timers");
	}
}
