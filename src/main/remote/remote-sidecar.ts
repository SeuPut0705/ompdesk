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
 * the running sidecar for a while and re-sends its status and the asks its
 * omp still has open (`openAsks`, the pool's open set for the tab is replaced
 * by it); after that it starts a new one on the newest session file.
 *
 * Nothing sent to the host vanishes while the link is down: a user's answer
 * (`extension_ui_response`) the host did not take — the link was down, dropped
 * while it was on its way, or the host refused it — is refused with
 * `remote_offline` (or the host's error) so its card stays open to be answered
 * again; the replies to the host's own tool and URI calls
 * wait and go out once the host tab is re-attached (and are dropped when the
 * host started a new omp, which never made those calls); a `tab.close` is
 * handed to `deferClose` and sent when the link is back (`PendingTabCloses`).
 */
import { EventEmitter } from "node:events";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import type { RemoteLinkState } from "../../shared/ipc-types";
import type { RpcCommand, RpcResponse, SidecarStatus, SidecarStatusPayload } from "../../shared/rpc-types";
import type { BridgeConnectResult } from "../bridge-health";
import type { RpcClient } from "../rpc-client";
import type { SidecarLike } from "../sidecar-types";
import {
	HOST_COMMAND_TIMEOUT_MS,
	LINK_SLACK_MS,
	TabBridgeArg,
	type TabEventMessage,
	TabOpenAsksArg,
	TabOpenResult,
	TabSessionArg,
	TabSignInArg,
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
	/** A `tab.close` the link could not carry: the owner sends it when the host is reachable again. */
	deferClose: (rtab: string) => void;
}

type StatusDetail = Pick<SidecarStatusPayload, "message" | "restart" | "modelFallback">;

const OFFLINE_TEXT = "The device running this tab is offline";

/**
 * Frames that answer a request the host's omp made (`host_tool_call`, `host_uri_request`):
 * no card waits for them, so while the link is down they wait for it.
 */
const REPLAYABLE_FRAMES: readonly string[] = ["host_tool_result", "host_uri_result"];
/** Replies kept for a link that stays down: the host's own tool calls time out long before this many pile up. */
const MAX_QUEUED_FRAMES = 64;

function isOfflineError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "remote_offline";
}

function isReplayable(frame: object): boolean {
	const type = (frame as { type?: unknown }).type;
	return typeof type === "string" && REPLAYABLE_FRAMES.includes(type);
}

/** Tabs closed here while their host was unreachable: the host keeps running them until it is told. */
export class PendingTabCloses {
	readonly #rtabs = new Set<string>();

	defer(rtab: string): void {
		this.#rtabs.add(rtab);
	}

	/** A tab opened again under this id supersedes its pending close. */
	cancel(rtab: string): void {
		this.#rtabs.delete(rtab);
	}

	/** Send every pending close; one the link refuses again stays pending. */
	flush(send: (rtab: string) => Promise<unknown>): void {
		for (const rtab of [...this.#rtabs]) {
			this.#rtabs.delete(rtab);
			send(rtab).catch((error: unknown) => {
				if (isOfflineError(error)) this.#rtabs.add(rtab);
			});
		}
	}
}

export class RemoteSidecar extends EventEmitter implements SidecarLike {
	readonly #link: RemoteLink;
	readonly #rtab: string;
	readonly #kind: "agent" | "chat";
	readonly #fresh: boolean;
	readonly #offlineMessage: () => string;
	readonly #onDispose: (() => void) | undefined;
	readonly #deferClose: (rtab: string) => void;
	#cwd: string;
	#status: SidecarStatus = "asleep";
	#detail: StatusDetail = {};
	#statusFromLink = true;
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
	/** `tab.open` was sent at some point: the host may hold this tab, whatever the link says now. */
	#openedOnce = false;
	/** Replies to the host's tool and URI calls that found the link down. */
	#queuedReplies: object[] = [];
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
		this.#deferClose = options.deferClose;
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

	/** The current status was derived here (start, link down, reconnecting), not reported by the host's omp. */
	get statusFromLink(): boolean {
		return this.#statusFromLink;
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
		// Never brought up (the pool starts a restored tab this way): like a SidecarManager before its
		// first spawn, this is a start on that session. `tab.open` carries it; a host still running the
		// session for this device (a relaunched device's takeover) keeps its omp and turn going.
		const firstStart = this.#status === "asleep";
		this.#wanted = true;
		this.#resume = resumeSessionPath ?? null;
		this.#setStatus("starting", {});
		void this.#bringUp(firstStart ? null : { cwd, sessionPath: resumeSessionPath });
	}

	adoptCwd(cwd: string): boolean {
		if (cwd === this.#cwd) return false;
		this.#cwd = cwd;
		this.#notify("tab.adoptCwd", { rtab: this.#rtab, cwd });
		return true;
	}

	/**
	 * A user's answer (`extension_ui_response`) returns a promise that settles once the host took it, and
	 * throws or rejects `remote_offline` (or the host's own refusal) when it cannot: the caller keeps its card
	 * open. Replies to the host's own calls wait for the next link instead.
	 */
	sendSideChannel(frame: object): Promise<void> | undefined {
		if (this.#disposed) return;
		if (this.#link.state === "online" && this.#opened) return this.#deliver(frame);
		if (!isReplayable(frame)) throw codedError("remote_offline", OFFLINE_TEXT);
		this.#queueReply(frame);
	}

	/** The host holds this tab's connection wait: the user's Cancel goes there. */
	async cancelHostWait(): Promise<void> {
		if (this.#link.state !== "online") throw codedError("remote_offline", OFFLINE_TEXT);
		try {
			await this.#open();
			await this.#link.request("tab.cancelWait", { rtab: this.#rtab });
		} catch (error) {
			if (isOfflineError(error)) throw codedError("remote_offline", OFFLINE_TEXT);
			throw error;
		}
	}

	syncImageGeneration(): void {
		this.#notify("tab.syncImageGeneration", { rtab: this.#rtab });
	}

	/** The host's own reply-language setting applies to the omp it runs; this machine's is not sent. */
	syncReplyLanguage(): void {}

	/** The host's own profile setting applies to the omp it runs; this machine's is not sent. */
	syncUserProfile(): void {}

	/** The host's own prompt-suggestion switches apply to the omp it runs; this machine's are not sent. */
	syncNextPrompt(): void {}

	/** The host's own automatic-title switches apply to the omp it runs; this machine's are not sent. */
	syncAutoTitle(): void {}

	/** The control tools run in the app that owns the omp; a host's tab gets them from the host. */
	syncHostTools(): void {}

	/** The host's own account-rotation setting applies to the omp it runs; this machine's is not sent. */
	syncAccountRotation(): void {}

	dispose(): void {
		if (this.#disposed) return;
		if (this.#openedOnce) this.#closeOnHost();
		this.#disposed = true;
		this.#queuedReplies = [];
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
				this.#setStatus(parsed.data.status, parsed.data.statusPayload, false);
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
			case "awaitingConnection":
				if (typeof message.arg === "boolean") this.emit("awaitingConnection", message.arg);
				return;
			case "openAsks": {
				const parsed = TabOpenAsksArg.safeParse(message.arg);
				if (parsed.success) this.emit("openAsks", parsed.data);
				return;
			}
			case "signIn": {
				const parsed = TabSignInArg.safeParse(message.arg);
				if (parsed.success) this.emit("signIn", parsed.data);
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

	/**
	 * One side-channel frame over a live link, after the host finished (re-)attaching the tab: a frame sent
	 * before then would reach a host that does not know the tab yet. A reply the link drops under is kept for
	 * the next link; anything else rejects, so its sender learns the host never took it.
	 */
	async #deliver(frame: object): Promise<void> {
		try {
			await this.#opened;
			await this.#link.request("tab.sideChannel", { rtab: this.#rtab, frame });
		} catch (error) {
			if (!isReplayable(frame)) {
				if (isOfflineError(error)) throw codedError("remote_offline", OFFLINE_TEXT);
				throw error;
			}
			if (isOfflineError(error) && !this.#disposed) this.#queueReply(frame);
		}
	}

	#queueReply(frame: object): void {
		this.#queuedReplies.push(frame);
		if (this.#queuedReplies.length > MAX_QUEUED_FRAMES) this.#queuedReplies.shift();
	}

	/** The host tab is back: its omp is the one that made these calls, so it gets the replies. */
	#replayReplies(): void {
		for (const frame of this.#queuedReplies.splice(0)) this.#deliver(frame);
	}

	#closeOnHost(): void {
		if (this.#link.state !== "online") {
			this.#deferClose(this.#rtab);
			return;
		}
		this.#link.request("tab.close", { rtab: this.#rtab }).catch((error: unknown) => {
			if (isOfflineError(error)) this.#deferClose(this.#rtab);
		});
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
			// The host deleted this session while the tab was away: the pool closes the tab instead of an error tab.
			if (ipcErrorCode(error) === "session_deleted") {
				this.emit("sessionDeleted", this.#resume);
				return;
			}
			this.#processAlive = false;
			// The link is up, so this is the host's answer (`no_workspace`, an unknown tab): the omp the tab's asks
			// came from is gone, and the pool drops their routes. A request the link dropped stays a link status.
			this.#setStatus(
				"error",
				{ message: error instanceof Error ? error.message : String(error) },
				isOfflineError(error),
			);
		}
	}

	#open(): Promise<TabOpenResult> {
		if (this.#opened) return this.#opened;
		this.#openedOnce = true;
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
				// A new omp never made the calls the old one was waiting on.
				if (result.attached) this.#replayReplies();
				else this.#queuedReplies = [];
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
			if (isOfflineError(error)) throw codedError("remote_offline", OFFLINE_TEXT);
			throw error;
		}
	}

	#markOffline(): void {
		if (this.#offlineShown) return;
		this.#offlineShown = true;
		this.#processAlive = false;
		this.#setStatus("error", { message: this.#offlineMessage() });
	}

	/** `fromLink`: this side derived the status (start, link down, reconnecting) instead of the host's omp. */
	#setStatus(status: SidecarStatus, detail: StatusDetail, fromLink = true): void {
		this.#status = status;
		this.#detail = detail;
		this.#statusFromLink = fromLink;
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
