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
 * by it); after that it starts a new one on the newest session file. The
 * re-open reports `starting` with `reconnecting` while the host may still run
 * the omp the page shows (the page keeps it and only reads what it missed),
 * and a plain `starting` once the host's answer shows another omp.
 *
 * Nothing sent to the host vanishes while the link is down: a user's answer
 * (`extension_ui_response`) the host did not take — the link was down, dropped
 * while it was on its way, or the host refused it — is refused with
 * `remote_offline` (or the host's error) so its card stays open to be answered
 * again; the replies to the host's own tool and URI calls
 * wait and go out once the host tab is re-attached (and are dropped when the
 * host started a new omp, which never made those calls); a `tab.close` is
 * handed to `deferClose` and sent when the link is back (`PendingTabCloses`).
 *
 * An app quit whose work continues after the relaunch (`keepOnHost`) closes nothing on the host: the host owns
 * the turns it runs for this device, keeps the tab through its grace period, and the relaunched device's
 * `tab.open` on the same session adopts it.
 */
import { EventEmitter } from "node:events";
import { z } from "zod";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import type { IpcScheduledRetry, RemoteLinkState } from "../../shared/ipc-types";
import { isOmpdeskWorktreeFolder } from "../../shared/project-origin";
import { MAX_RPC_COMMAND_TIMEOUT_MS } from "../../shared/rpc-client";
import type { RpcCommand, RpcResponse, SidecarStatus, SidecarStatusPayload } from "../../shared/rpc-types";
import type { BridgeConnectResult } from "../bridge-health";
import type { RpcClient } from "../rpc-client";
import type { SidecarLike } from "../sidecar-types";
import type { SignInCallbackPage } from "../sign-in-callback";
import {
	HOST_COMMAND_TIMEOUT_MS,
	LINK_SLACK_MS,
	SIGN_IN_CALLBACK_METHOD,
	SignInCallbackReply,
	TabBridgeArg,
	type TabEventMessage,
	TabOpenAsksArg,
	TabOpenResult,
	TabRunArg,
	TabScheduledRetryArg,
	TabSessionArg,
	TabSignInArg,
	TabStatusArg,
} from "./app-protocol";
import type { ImageBlobCache } from "./image-blob-cache";
import { createLinkEventDecoder, createReadDecoder, encodedReadKey, type WireSubagentFrame } from "./link-events";
import { tabHolderOf } from "./protocol";
import { type SignInRelay, type SignInRelayOptions, startSignInRelay } from "./sign-in-relay";
import type { TranscriptCache } from "./transcript-cache";

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
	/**
	 * Read at dispose: true while an approved app quit leaves interrupted work to continue (Settings › General), so
	 * the host's tab and its running turn outlive this process. Absent: dispose always closes the host's tab.
	 */
	keepOnHost?: () => boolean;
	/**
	 * Status message while the host leaves a bring-up request unanswered (the link's own request timeout), in the UI
	 * language: the tab keeps waiting and asks again, never an error.
	 */
	unansweredMessage: () => string;
	/** One line per bring-up step for the runtime log: which step a tab that has not come up yet waits on. */
	log?: (step: RemoteTabLogStep, details: Record<string, string | number | boolean>) => void;
	/**
	 * This device's pictures by content address: a subagent transcript read asks the host for its blob references
	 * (`imageRefs`) and reads each picture's bytes from here, or from the host once. Absent: the host sends the bytes.
	 */
	imageBlobs?: ImageBlobCache;
	/**
	 * This device's copies of the tab's transcripts (`TranscriptCache`): a subagent journal read and a tail page read
	 * ask the host only for what changed since this device last read them, across relaunches. Absent: every read asks.
	 */
	transcripts?: TranscriptCache;
	/**
	 * Stand in on this computer's loopback for the host's browser sign-in callback while the host's `login` runs
	 * (sign-in-relay.ts): `failure` is the browser page's words when the host could not take it. Absent: no stand-in.
	 */
	signInRelay?: Pick<SignInRelayOptions, "failure" | "port">;
}

type StatusDetail = Pick<
	SidecarStatusPayload,
	"message" | "restart" | "modelFallback" | "reconnecting" | "sessionHeld" | "slow" | "queued"
>;

/** A bring-up's steps: the link up, `tab.open` sent, `tab.start` sent, then the host's status that says the tab runs. */
type BringUpStep = "link" | "open" | "start" | "ready";
export type RemoteTabLogStep = "open" | "start" | "ready" | "unanswered" | "failed";

const OFFLINE_TEXT = "The device running this tab is offline";

/** The browser page a sign-in raised, as far as standing in for its callback reads it. */
const OpenUrlRequest = z.object({ method: z.literal("open_url"), url: z.string(), launchUrl: z.string().optional() });

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
	#link: RemoteLink;
	readonly #rtab: string;
	readonly #linkEvents = createLinkEventDecoder();
	/** One per read that crosses as deltas (`encodedReadKey`). */
	readonly #reads = new Map<string, (wire: unknown) => unknown>();
	readonly #kind: "agent" | "chat";
	readonly #fresh: boolean;
	readonly #offlineMessage: () => string;
	readonly #onDispose: (() => void) | undefined;
	readonly #deferClose: (rtab: string) => void;
	readonly #keepOnHost: () => boolean;
	#cwd: string;
	#status: SidecarStatus = "asleep";
	#detail: StatusDetail = {};
	#statusFromLink = true;
	#processAlive = false;
	/** The host's last open said this tab views a tab one of its windows owns. */
	#viewing = false;
	/** The host's id of the omp the last status came from (`TabStatusArg.omp`); undefined until one said. */
	#omp: string | undefined;
	/** The current `starting` is a re-open after a lost link (`reconnecting`): the host's next status decides. */
	#reattaching = false;
	/**
	 * The host's reading of the turn on this re-attach, held until its status: that status may start the page over for
	 * another omp, and the reading is the new omp's, so it goes to the pool after that start, not before it.
	 */
	#reattachRun: TabRunArg | null = null;
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
	readonly #unansweredMessage: () => string;
	readonly #log: RemoteSidecarOptions["log"];
	readonly #imageBlobs: ImageBlobCache | undefined;
	readonly #transcripts: TranscriptCache | undefined;
	readonly #signInRelayOptions: RemoteSidecarOptions["signInRelay"];
	/** The provider sign-ins the host reports running on this tab (`signIn`). */
	#hostSignIns: readonly string[] = [];
	/** This computer's stand-in for the running sign-in's loopback callback, if one is up. */
	#signInRelay: SignInRelay | null = null;
	/** The bring-up in progress and the step it waits on; null once the host reported the tab running. */
	#pending: { step: BringUpStep; at: number } | null = null;
	/**
	 * No deadline of this side's own (the owner's rule, 9 Nov 2026): the tab shows what the host says of its start
	 * (queued, starting, slow), and an unanswered request or a link down is a wait, never an error.
	 */
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
		this.#keepOnHost = options.keepOnHost ?? (() => false);
		this.#unansweredMessage = options.unansweredMessage;
		this.#log = options.log;
		this.#imageBlobs = options.imageBlobs;
		this.#transcripts = options.transcripts;
		this.#signInRelayOptions = options.signInRelay;
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

	/** The host gave this tab a view of a tab one of its windows owns (`TabOpenResult.viewing`): one omp, shared. */
	get shared(): boolean {
		return this.#viewing;
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

	/** The host holds this tab's connection wait and its scheduled retry: the user's Cancel on either goes there. */
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

	/** The host's own default browser applies to the omp it runs; this machine's is not sent. */
	syncDefaultBrowser(): void {}

	/** The host's own profile setting applies to the omp it runs; this machine's is not sent. */
	syncUserProfile(): void {}

	/** The host's own prompt-suggestion switches apply to the omp it runs; this machine's are not sent. */
	syncNextPrompt(): void {}

	/** The host's own automatic-title switches apply to the omp it runs; this machine's are not sent. */
	syncAutoTitle(): void {}

	/** The host's own judge-assist switch applies to the omp it runs; this machine's is not sent. */
	syncJudgeAssist(): void {}

	/** The control tools run in the app that owns the omp; a host's tab gets them from the host. */
	syncHostTools(): void {}

	/** The host's own account-rotation setting applies to the omp it runs; this machine's is not sent. */
	syncAccountRotation(): void {}

	dispose(): void {
		if (this.#disposed) return;
		if (this.#openedOnce && !this.#keepOnHost()) this.#closeOnHost();
		this.#endSignInRelay();
		this.#disposed = true;
		this.#settle(null);
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
				// The host re-attached another omp than the one the page shows (it restarted while the link was
				// down; an older host does not say): the page starts over, as for any new omp.
				if (this.#reattaching && (parsed.data.omp === undefined || parsed.data.omp !== this.#omp))
					this.#setStatus("starting", {});
				this.#omp = parsed.data.omp;
				const run = this.#reattachRun;
				this.#reattachRun = null;
				if (run) this.emit("hostRun", run);
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
			// The host's retry of the failed turn of the window's tab this one views: put on this computer's clock.
			case "scheduledRetry": {
				const parsed = TabScheduledRetryArg.safeParse(message.arg);
				if (!parsed.success) return;
				const retry = parsed.data;
				this.emit(
					"scheduledRetry",
					retry === null
						? undefined
						: ({
								at: Date.now() + retry.remainingMs,
								attempt: retry.attempt,
							} satisfies IpcScheduledRetry),
				);
				return;
			}
			case "openAsks": {
				const parsed = TabOpenAsksArg.safeParse(message.arg);
				if (parsed.success) this.emit("openAsks", parsed.data);
				return;
			}
			// The host's reading of the turn on a re-attach: the pool keeps its own through the lost link and takes this.
			case "run": {
				const parsed = TabRunArg.safeParse(message.arg);
				if (!parsed.success) return;
				if (this.#reattaching) this.#reattachRun = parsed.data;
				else this.emit("hostRun", parsed.data);
				return;
			}
			case "signIn": {
				const parsed = TabSignInArg.safeParse(message.arg);
				if (!parsed.success) return;
				this.#hostSignIns = parsed.data.active;
				if (parsed.data.active.length === 0) this.#endSignInRelay();
				this.emit("signIn", parsed.data);
				return;
			}
			case "extensionUi":
				this.#relaySignIn(message.arg);
				this.emit(message.name, message.arg);
				return;
			// The host's person deleted the session this tab shows: the pool drops the tab and remembers the delete.
			case "sessionDeleted":
				if (typeof message.arg === "string") this.emit("sessionDeleted", message.arg);
				return;
			// A host that sent them slim (the hello asked): back to what a local sidecar delivers; whole ones pass through.
			case "events":
				this.emit(message.name, Array.isArray(message.arg) ? this.#linkEvents.events(message.arg) : message.arg);
				return;
			// One frame, or an array of them: what a host that batches (`slimProgress`) sends for each flush.
			case "subagentFrame":
				for (const frame of Array.isArray(message.arg) ? message.arg : [message.arg]) {
					const decoded = frame ? this.#linkEvents.subagentFrame(frame as WireSubagentFrame) : frame;
					if (decoded !== null) this.emit(message.name, decoded);
				}
				return;
			default:
				this.emit(message.name, message.arg);
		}
	}

	/**
	 * The browser page of a sign-in the host runs: the provider will send this computer's browser to the host's
	 * loopback callback, which is this computer's loopback here, so stand in on it (sign-in-relay.ts). A newer page
	 * replaces the stand-in.
	 */
	#relaySignIn(request: unknown): void {
		const options = this.#signInRelayOptions;
		if (!options || this.#hostSignIns.length === 0) return;
		const page = OpenUrlRequest.safeParse(request);
		if (!page.success || page.data.launchUrl === undefined) return;
		this.#endSignInRelay();
		const relay = startSignInRelay({
			...options,
			authorizationUrl: page.data.url,
			forward: (path, query) => this.#forwardSignInCallback(path, query),
			onState: state => {
				if (this.#signInRelay === relay) this.emit("signInRelay", state);
			},
		});
		this.#signInRelay = relay;
	}

	#endSignInRelay(): void {
		if (!this.#signInRelay) return;
		this.#signInRelay.close();
		this.#signInRelay = null;
		this.emit("signInRelay", null);
	}

	async #forwardSignInCallback(path: string, query: string): Promise<SignInCallbackPage> {
		if (this.#link.state !== "online") throw codedError("remote_offline", OFFLINE_TEXT);
		await this.#open();
		const reply = await this.#link.request(SIGN_IN_CALLBACK_METHOD, { rtab: this.#rtab, path, query });
		return SignInCallbackReply.parse(reply);
	}

	/**
	 * The host's link was made again (Connect pressed for a host already paired: a new client, the old one closed):
	 * the tab goes on over the new one, as after a dropped link, instead of staying on the closed one for good.
	 */
	relink(link: RemoteLink): void {
		if (this.#disposed) return;
		this.#link = link;
		this.#opened = null;
		this.linkStateChanged(link.state);
	}

	/** The link to the host changed state. */
	linkStateChanged(state: RemoteLinkState): void {
		if (this.#disposed) return;
		if (state === "online") {
			if (this.#wanted && !this.#opened) {
				// The host may still run the omp this tab showed: the page keeps it until the host's status says.
				this.#setStatus("starting", this.#omp === undefined ? {} : { reconnecting: true });
				void this.#bringUp(null);
			}
			return;
		}
		// This link session is over: the next one must re-open (re-attach)
		// before anything else reaches the tab on the host.
		this.#opened = null;
		this.#reattachRun = null;
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
			// The host took the result: it never re-sends that call (agent-control/call-journal.ts acknowledges it).
			const { type, id } = frame as { type?: unknown; id?: unknown };
			if (type === "host_tool_result" && typeof id === "string") this.emit("hostReplyDelivered", id);
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
		this.#begin();
		if (this.#link.state !== "online") {
			// "connecting" settles into online (bringUp again) or offline (shown then); one that never does stalls.
			this.#advance("link");
			if (this.#link.state === "offline") this.#markOffline();
			return;
		}
		try {
			if (!this.#opened) {
				const opened = await this.#open();
				if (this.#disposed) return;
				this.#note("open", { attached: opened.attached, viewing: opened.viewing === true });
				if (!opened.attached) {
					// The host no longer held the tab: a new omp, so a re-attaching page starts over.
					if (this.#reattaching) this.#setStatus("starting", {});
					this.#advance("start");
					await this.#link.request("tab.start", { rtab: this.#rtab });
					this.#note("start", {});
					this.#advance("ready");
					return;
				}
				// Re-attached: the host re-sent the live status; a restart still applies.
				if (!restart) {
					this.#advance("ready");
					return;
				}
			}
			this.#advance("start");
			if (restart) {
				await this.#link.request("tab.restart", {
					rtab: this.#rtab,
					...(restart.cwd ? { cwd: restart.cwd } : {}),
					...(restart.sessionPath ? { sessionPath: restart.sessionPath } : {}),
				});
			} else await this.#link.request("tab.start", { rtab: this.#rtab });
			this.#note("start", {});
			this.#advance("ready");
		} catch (error) {
			if (this.#disposed) return;
			const message = error instanceof Error ? error.message : String(error);
			// A request the host never answered (the link's own `timeout`, the link still up): a host too busy to answer
			// yet, never a failed start. The tab says it waits for the host and asks again (`tab.start` is idempotent).
			const unanswered =
				this.#link.state === "online" && error instanceof Error && "code" in error && error.code === "timeout";
			this.#note(unanswered ? "unanswered" : "failed", { step: this.#pending?.step ?? "open", error: message });
			if (unanswered) {
				this.#setStatus("starting", { slow: true, message: this.#unansweredMessage() });
				void this.#bringUp(null);
				return;
			}
			if (this.#link.state !== "online") {
				if (this.#link.state === "offline") this.#markOffline();
				return;
			}
			// The host deleted this session while the tab was away: the pool closes the tab instead of an error tab.
			if (ipcErrorCode(error) === "session_deleted") {
				this.#settle(null);
				this.emit("sessionDeleted", this.#resume);
				return;
			}
			// Another tab on the host already shows this session (one of this device's, or another device's): the pool
			// shows that tab, or says where the session is open, instead of an error tab (`TabHolder`; null from an older
			// host, which names none).
			if (ipcErrorCode(error) === "session_open_in_tab") {
				this.#settle(null);
				this.emit("shownElsewhere", tabHolderOf(error));
				return;
			}
			// The session's folder on the host is an OMPdesk worktree that is gone (disk care removed it once its work
			// landed): the session is finished, and a tab that comes back for it (a relaunch restored it, shown) closes
			// as a deleted session's does, never an error tab that keeps its row listed. No tombstone: a saved worktree
			// can still be restored on the host and the session opened again.
			if (ipcErrorCode(error) === "session_folder_missing" && isOmpdeskWorktreeFolder(this.#cwd)) {
				this.#settle(null);
				this.emit("folderGone");
				return;
			}
			this.#processAlive = false;
			// The link is up, so this is the host's answer (`no_workspace`, an unknown tab): the omp the tab's asks
			// came from is gone, and the pool drops their routes. A request the link dropped stays a link status.
			this.#setStatus("error", { message }, isOfflineError(error));
		}
	}

	/** A bring-up begins: its steps go to the runtime log until the host reports the tab running. */
	#begin(): void {
		this.#settle(null);
		this.#pending = { step: "open", at: Date.now() };
	}

	#advance(step: BringUpStep): void {
		if (this.#pending) this.#pending.step = step;
	}

	#note(step: RemoteTabLogStep, details: Record<string, string | number | boolean>): void {
		const at = this.#pending?.at;
		this.#log?.(step, {
			device: this.#link.deviceId,
			rtab: this.#rtab,
			...(at === undefined ? {} : { ms: Date.now() - at }),
			...details,
		});
	}

	/** The bring-up ended with `status` (null: abandoned); a running tab logs how long it took. */
	#settle(status: SidecarStatus | null): void {
		if (this.#pending && status === "ready") this.#note("ready", { step: this.#pending.step });
		this.#pending = null;
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
				const viewing = result.viewing === true;
				if (viewing !== this.#viewing) {
					this.#viewing = viewing;
					this.emit("shared");
				}
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

	async #command(command: RpcCommand, wanted?: number): Promise<RpcResponse> {
		// A caller's "no deadline" (`RpcClient.command`) becomes the longest window the host takes: a request over the
		// link always has a bound, so a host that went silent never holds a caller for good.
		const timeoutMs = wanted !== undefined && !Number.isFinite(wanted) ? MAX_RPC_COMMAND_TIMEOUT_MS : wanted;
		if (this.#link.state !== "online") throw codedError("remote_offline", OFFLINE_TEXT);
		try {
			await this.#open();
			const ask = (sent: RpcCommand, fresh: boolean) =>
				this.#link.request<RpcResponse>(
					"tab.command",
					{
						rtab: this.#rtab,
						command: sent,
						...(timeoutMs !== undefined ? { timeoutMs } : {}),
						...(fresh ? { fresh } : {}),
					},
					(timeoutMs ?? HOST_COMMAND_TIMEOUT_MS) + LINK_SLACK_MS,
				);
			if (command.type === "get_subagent_messages" || command.type === "get_subagent_transcript")
				return await this.#journalRead(command, sent => ask(sent, false));
			const page = this.#tailKey(command);
			// The page's pictures come as references this device reads once (`ImageBlobCache`), as a journal's do: a
			// session's pictures inline were 92 % of an 18.4 MB tail page the link's 16 MiB frame could not carry
			// (4 Nov 2026). An older host ignores `imageRefs` and sends the bytes.
			const pictured = this.#imageBlobs !== undefined && command.type === "get_transcript_page";
			const kept =
				page && command.type === "get_transcript_page" && command.ifVersion === undefined
					? await page.cache.page(page.key)
					: null;
			// A fresh reader (a relaunch, a reload) asks for the page this device kept, if the transcript is unchanged.
			const sent: RpcCommand =
				command.type === "get_transcript_page"
					? {
							...command,
							...(kept ? { ifVersion: kept.version } : {}),
							...(pictured ? { imageRefs: true } : {}),
						}
					: command;
			const response = await ask(sent, false);
			const read = encodedReadKey(command);
			if (!response.success) return response;
			if (!read) return pictured ? await this.#withPictures(response) : response;
			// The answer may be a delta of an earlier one (`slimAutopilotReads`, `slimListReads`); one this side lacks is
			// asked again whole.
			let decode = this.#reads.get(read.key);
			if (!decode) {
				decode = createReadDecoder();
				this.#reads.set(read.key, decode);
			}
			let data = decode(response.data);
			if (data === null) {
				const whole = await ask(sent, true);
				if (!whole.success) return whole;
				data = decode(whole.data);
			}
			if (page) {
				const tail = data as { unchanged?: unknown; version?: unknown } | null;
				if (kept && tail?.unchanged === true) {
					const answer = { ...response, data: kept.page };
					return pictured ? await this.#withPictures(answer) : answer;
				}
				if (typeof tail?.version === "string" && tail.unchanged !== true && typeof data === "object" && data)
					void page.cache.keepPage(page.key, tail.version, data);
			}
			const answer = { ...response, data };
			return pictured ? await this.#withPictures(answer) : answer;
		} catch (error) {
			// The link dropped mid-request: same refusal as a command sent while offline.
			if (isOfflineError(error)) throw codedError("remote_offline", OFFLINE_TEXT);
			throw error;
		}
	}

	/** Where this device keeps the tab's tail page read at `limit`: by host, the tab's session file and the limit. */
	#tailKey(command: RpcCommand): { cache: TranscriptCache; key: string } | null {
		if (!this.#transcripts || !this.#resume || command.type !== "get_transcript_page") return null;
		if (command.fromEnd !== true || command.cursor !== undefined) return null;
		return {
			cache: this.#transcripts,
			key: `${this.#link.deviceId}\0${this.#resume}\0tail\0${String(command.limit)}`,
		};
	}

	/**
	 * A page's pictures in place of their references, on a copy: the answer as it came is the delta base the decoder
	 * holds and the page the transcript cache keeps, both with references, as the host's next answer expects.
	 */
	async #withPictures(response: RpcResponse): Promise<RpcResponse> {
		const data = response.data;
		if (!this.#imageBlobs || typeof data !== "object" || data === null || !("messages" in data)) return response;
		const shown = structuredClone(data);
		await this.#imageBlobs.resolve(shown.messages, ref => this.#imageBlob(ref));
		return { ...response, data: shown };
	}

	/**
	 * A subagent's journal: the host leaves its pictures as references this device reads once (`ImageBlobCache`), and
	 * the journal crosses once per change (`TranscriptCache`, by host, the tab's session file and the agent). An older
	 * host ignores `imageRefs` and `tails`: it sends the bytes, and nothing it sends is kept.
	 */
	async #journalRead(
		command: Extract<RpcCommand, { type: "get_subagent_messages" | "get_subagent_transcript" }>,
		ask: (sent: RpcCommand) => Promise<RpcResponse>,
	): Promise<RpcResponse> {
		const sent = this.#imageBlobs ? { ...command, imageRefs: true } : command;
		const id = command.subagentId;
		const response =
			this.#transcripts && this.#resume && id && command.firstPrompt !== true
				? await this.#transcripts.readJournal(
						`${this.#link.deviceId}\0${this.#resume}\0subagent\0${id}`,
						command.fromByte ?? 0,
						(fromByte, knownTail) => ask({ ...sent, fromByte, tails: true, ...(knownTail ? { knownTail } : {}) }),
					)
				: await ask(sent);
		const answer = response.success ? response.data : undefined;
		if (this.#imageBlobs && typeof answer === "object" && answer !== null && "messages" in answer)
			await this.#imageBlobs.resolve(answer.messages, ref => this.#imageBlob(ref));
		return response;
	}

	/** One picture's bytes from the host (`read_image_blob`); null when it has none or does not know the command. */
	async #imageBlob(ref: string): Promise<string | null> {
		const response = await this.#command({ type: "read_image_blob", ref });
		const data = response.success ? response.data : undefined;
		return typeof data === "object" && data !== null && "data" in data && typeof data.data === "string"
			? data.data
			: null;
	}

	/**
	 * The host is out of reach: a link status, never an error (the owner's rule, 9 Nov 2026). The tab reads `starting`
	 * with `reconnecting`, so every page keeps what it shows (the host may still run that omp), and it comes back by
	 * itself once the link does (`linkStateChanged`).
	 */
	#markOffline(): void {
		if (this.#offlineShown) return;
		this.#offlineShown = true;
		this.#processAlive = false;
		this.#setStatus("starting", { reconnecting: true, message: this.#offlineMessage() });
	}

	/** `fromLink`: this side derived the status (start, link down, reconnecting) instead of the host's omp. */
	#setStatus(status: SidecarStatus, detail: StatusDetail, fromLink = true): void {
		// Only `starting` keeps a bring-up waiting; every other status ends it (and its watchdog).
		if (status !== "starting") this.#settle(status);
		this.#status = status;
		this.#detail = detail;
		this.#reattaching = status === "starting" && detail.reconnecting === true;
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
