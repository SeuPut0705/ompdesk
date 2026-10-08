/**
 * A tab whose omp runs on a paired host (A side). It stands in for a
 * SidecarManager in the pool: commands, side-channel frames and lifecycle
 * calls go to the host as `tab.*` requests, and the host's SidecarManager
 * events come back as `tab.event` and are re-emitted verbatim, so the pool's
 * wiring, ipc.ts and the renderer treat it like any local tab.
 *
 * Link state is tab state: when the link drops, the tab reports status
 * `error` with the offline message and refuses commands (`remote_offline`).
 * When it comes back, the tab re-opens on the host — the host still holds
 * the running sidecar for a while and re-sends its status; after that it
 * starts a new one on the newest session file.
 */
import { EventEmitter } from "node:events";
import { codedError } from "../../shared/ipc-error-codes";
import type { RemoteLinkState } from "../../shared/ipc-types";
import type { RpcCommand, RpcResponse, SidecarStatus, SidecarStatusPayload } from "../../shared/rpc-types";
import type { BridgeConnectResult } from "../bridge-health";
import type { RpcClient } from "../rpc-client";
import type { SidecarLike } from "../sidecar-pool";
import {
	HOST_COMMAND_TIMEOUT_MS,
	LINK_SLACK_MS,
	TabBridgeArg,
	type TabEventMessage,
	TabOpenResult,
	TabSessionArg,
	TabStatusArg,
} from "./app-protocol";

/** The slice of RemoteClient a tab needs. */
export interface RemoteLink {
	readonly deviceId: string;
	readonly state: RemoteLinkState;
	request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}

export interface RemoteSidecarOptions {
	link: RemoteLink;
	/** This tab's id; the host scopes it to this device. */
	rtab: string;
	cwd: string;
	kind: "agent" | "chat";
	fresh: boolean;
	/** Status message while the host is unreachable, in the UI language. */
	offlineMessage: () => string;
	/** Called once from dispose(), so the owner can drop its routing entry. */
	onDispose?: () => void;
}

type StatusDetail = Pick<SidecarStatusPayload, "message" | "restart" | "modelFallback">;

const OFFLINE_TEXT = "The device running this tab is offline";

export class RemoteSidecar extends EventEmitter implements SidecarLike {
	readonly #link: RemoteLink;
	readonly #rtab: string;
	readonly #kind: "agent" | "chat";
	readonly #fresh: boolean;
	readonly #offlineMessage: () => string;
	readonly #onDispose: (() => void) | undefined;
	#cwd: string;
	#status: SidecarStatus = "asleep";
	#detail: StatusDetail = {};
	#processAlive = false;
	/** start()/restart() was called: the tab should run whenever the link is up. */
	#wanted = false;
	/** Session the host resumes when it has no live sidecar for this tab. */
	#resume: string | null = null;
	/** The host's answer to `tab.open` for the current link session; null until opened or after a drop. */
	#opened: Promise<TabOpenResult> | null = null;
	/** The offline status was emitted and nothing from the host has replaced it yet. */
	#offlineShown = false;
	#disposed = false;
	readonly #client: Pick<RpcClient, "command"> = {
		command: (command, timeoutMs) => this.#command(command, timeoutMs),
	};

	constructor(options: RemoteSidecarOptions) {
		super();
		this.#link = options.link;
		this.#rtab = options.rtab;
		this.#cwd = options.cwd;
		this.#kind = options.kind;
		this.#fresh = options.fresh;
		this.#offlineMessage = options.offlineMessage;
		this.#onDispose = options.onDispose;
	}

	get device(): string {
		return this.#link.deviceId;
	}

	get offline(): boolean {
		return this.#link.state !== "online";
	}

	get status(): SidecarStatus {
		return this.#status;
	}

	get statusPayload(): SidecarStatusPayload {
		return { status: this.#status, cwd: this.#cwd, ...this.#detail };
	}

	get cwd(): string {
		return this.#cwd;
	}

	get kind(): "agent" | "chat" {
		return this.#kind;
	}

	/** Null until started, like a SidecarManager before its first spawn. */
	get rpcClient(): Pick<RpcClient, "command"> | null {
		return this.#status === "asleep" ? null : this.#client;
	}

	get processAlive(): boolean {
		return this.#processAlive;
	}

	start(): void {
		if (this.#disposed) return;
		this.#wanted = true;
		this.#setStatus("starting", {});
		void this.#bringUp(null);
	}

	restart(cwd?: string, resumeSessionPath?: string): void {
		if (this.#disposed) return;
		if (cwd) this.#cwd = cwd;
		this.#wanted = true;
		this.#resume = resumeSessionPath ?? null;
		this.#setStatus("starting", {});
		void this.#bringUp({ cwd, sessionPath: resumeSessionPath });
	}

	adoptCwd(cwd: string): boolean {
		if (cwd === this.#cwd) return false;
		this.#cwd = cwd;
		this.#notify("tab.adoptCwd", { rtab: this.#rtab, cwd });
		return true;
	}

	sendSideChannel(frame: object): void {
		this.#notify("tab.sideChannel", { rtab: this.#rtab, frame });
	}

	syncImageGeneration(): void {
		this.#notify("tab.syncImageGeneration", { rtab: this.#rtab });
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#notify("tab.close", { rtab: this.#rtab });
		this.#disposed = true;
		this.#wanted = false;
		this.#opened = null;
		this.removeAllListeners();
		this.#onDispose?.();
	}

	/** A `tab.event` from the host for this tab, already parsed at the link boundary. */
	handleEvent(message: TabEventMessage): void {
		if (this.#disposed) return;
		switch (message.name) {
			case "status": {
				const parsed = TabStatusArg.safeParse(message.arg);
				if (!parsed.success) return;
				this.#offlineShown = false;
				this.#processAlive = parsed.data.processAlive;
				if (parsed.data.cwd) this.#cwd = parsed.data.cwd;
				this.#setStatus(parsed.data.status, parsed.data.statusPayload);
				return;
			}
			case "session": {
				const parsed = TabSessionArg.safeParse(message.arg);
				if (!parsed.success) return;
				this.#resume = parsed.data.sessionFile ?? null;
				this.emit("session", parsed.data);
				return;
			}
			case "bridge": {
				const parsed = TabBridgeArg.safeParse(message.arg);
				if (parsed.success) this.emit("bridge", bridgeResult(parsed.data));
				return;
			}
			default:
				this.emit(message.name, message.arg);
		}
	}

	/** The link to the host changed state. */
	linkStateChanged(state: RemoteLinkState): void {
		if (this.#disposed) return;
		if (state === "online") {
			if (this.#wanted && !this.#opened) {
				this.#setStatus("starting", {});
				void this.#bringUp(null);
			}
			return;
		}
		// This link session is over: the next one must re-open (re-attach)
		// before anything else reaches the tab on the host.
		this.#opened = null;
		if (state === "offline" && this.#status !== "asleep") this.#markOffline();
	}

	/** Fire-and-forget request; dropped while the tab is not open on a live link. */
	#notify(method: string, params: object): void {
		if (this.#disposed || this.#link.state !== "online" || !this.#opened) return;
		this.#link.request(method, params).catch(() => {});
	}

	async #bringUp(restart: { cwd?: string; sessionPath?: string } | null): Promise<void> {
		if (this.#link.state !== "online") {
			// "connecting" settles into online (bringUp again) or offline (shown then).
			if (this.#link.state === "offline") this.#markOffline();
			return;
		}
		try {
			if (!this.#opened) {
				const opened = await this.#open();
				if (this.#disposed) return;
				if (!opened.attached) {
					await this.#link.request("tab.start", { rtab: this.#rtab });
					return;
				}
				// Re-attached: the host re-sent the live status; a restart still applies.
				if (!restart) return;
			}
			if (restart) {
				await this.#link.request("tab.restart", {
					rtab: this.#rtab,
					...(restart.cwd ? { cwd: restart.cwd } : {}),
					...(restart.sessionPath ? { sessionPath: restart.sessionPath } : {}),
				});
			} else await this.#link.request("tab.start", { rtab: this.#rtab });
		} catch (error) {
			if (this.#disposed) return;
			if (this.#link.state !== "online") {
				if (this.#link.state === "offline") this.#markOffline();
				return;
			}
			this.#processAlive = false;
			this.#setStatus("error", { message: error instanceof Error ? error.message : String(error) });
		}
	}

	#open(): Promise<TabOpenResult> {
		if (this.#opened) return this.#opened;
		const opening = this.#link
			.request<unknown>("tab.open", {
				rtab: this.#rtab,
				cwd: this.#cwd,
				kind: this.#kind,
				fresh: this.#fresh,
				...(this.#resume ? { sessionPath: this.#resume } : {}),
			})
			.then(raw => {
				const result = TabOpenResult.parse(raw);
				if (result.cwd) this.#cwd = result.cwd;
				return result;
			});
		this.#opened = opening;
		opening.catch(() => {
			if (this.#opened === opening) this.#opened = null;
		});
		return opening;
	}

	async #command(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		if (this.#link.state !== "online") throw codedError("remote_offline", OFFLINE_TEXT);
		try {
			await this.#open();
			return await this.#link.request<RpcResponse>(
				"tab.command",
				{ rtab: this.#rtab, command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
				(timeoutMs ?? HOST_COMMAND_TIMEOUT_MS) + LINK_SLACK_MS,
			);
		} catch (error) {
			// The link dropped mid-request: same refusal as a command sent while offline.
			if (error instanceof Error && "code" in error && error.code === "remote_offline") {
				throw codedError("remote_offline", OFFLINE_TEXT);
			}
			throw error;
		}
	}

	#markOffline(): void {
		if (this.#offlineShown) return;
		this.#offlineShown = true;
		this.#processAlive = false;
		this.#setStatus("error", { message: this.#offlineMessage() });
	}

	#setStatus(status: SidecarStatus, detail: StatusDetail): void {
		this.#status = status;
		this.#detail = detail;
		this.emit("status", this.statusPayload);
	}
}

/** The host's serialized bridge result, with a stand-in that answers the capabilities probe. */
function bridgeResult(arg: TabBridgeArg): BridgeConnectResult {
	if (!arg.connected) return arg;
	const capabilities = { ompVersion: arg.ompVersion, unavailable: arg.unavailable };
	return {
		connected: true,
		ompVersion: arg.ompVersion,
		bridge: {
			request: async <T>(method: string): Promise<T> => {
				if (method !== "capabilities") throw new Error(`Bridge method ${method} is not available remotely`);
				return capabilities as T;
			},
		},
	};
}
