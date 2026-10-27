/**
 * A window of this computer showing a tab this computer runs for a paired device (the person at the
 * host works in every session running on it, including one a paired device started, e.g. through
 * `ompdesk_session_open {device}`). The omp stays the device's tab in LocalHostServices; this view is
 * the `SidecarLike` the window's pool entry holds (`SidecarPool.acquireHostedView`), so the window
 * gets the multi-viewer rules over one omp:
 *
 * - the omp's stream reaches the window, except its host tool calls and URI reads, which the device
 *   answers (a second answer from here would race it);
 * - the window's commands go to the same omp; a prompt, steer or follow-up typed here is journaled as
 *   the viewer's (`prompt_origin_set` with `promptOrigin`) unless a paired web page that views this
 *   window's tab named its own device first, and a transcript page is relabelled for the viewer
 *   (`labelTranscript`).
 *
 * The same view serves the other direction: a paired device viewing a tab a window of this computer
 * owns (`SidecarPool.viewForDevice`), with the device as `promptOrigin` and the pool deciding the
 * first answer;
 * - an answer to an ask goes through LocalHostServices, where the first of the device and this
 *   computer's windows wins and the other's card closes as answered elsewhere (`answered:<id>`);
 * - a window that joins gets the asks open now and the session's identity (next microtask, once the
 *   pool's listeners are on), and the connection wait or scheduled retry that holds;
 * - the pool emits the window's tab's connection wait (`awaitingConnection`) and scheduled retry
 *   (`scheduledRetry`) on the view as they change, and the device's Cancel on either
 *   (`cancelHostWait`) reaches this computer's resume rules for the window's tab;
 * - leaving (`dispose`) takes only the window's listeners; the device's close, delete or revoke ends
 *   the view (`VIEW_ENDED_EVENT`) before its omp goes.
 */
import { EventEmitter } from "node:events";
import type { PromptOrigin, PromptOriginEnv } from "../../../resources/gui-bridge/prompt-origin-contracts";
import { codedError } from "../../shared/ipc-error-codes";
import type { IpcScheduledRetry } from "../../shared/ipc-types";
import type {
	ExtensionUIRequest,
	RpcCommand,
	RpcResponse,
	SessionInfoUpdateFrame,
	SidecarStatus,
	SidecarStatusPayload,
	SubagentSubscriptionLevel,
} from "../../shared/rpc-types";
import type { RpcClient } from "../rpc-client";
import type { RunReading } from "../sidecar-run-state";
import { type SidecarLike, VIEW_ENDED_EVENT } from "../sidecar-types";
import { STOP_COMMANDS } from "../turn-stop-log";

/** The hosted omp's events a window shows. `hostToolCall` and `hostUriRequest` stay the device's to answer. */
const VIEW_EVENTS = [
	"status",
	"events",
	"extensionUi",
	"subagentFrame",
	"liveFrame",
	"btwFrame",
	"modelCatalogUpdate",
	"commandsUpdate",
	"configUpdate",
	"promptResult",
	"sessionSettled",
	"commandOutput",
	"sessionInfoUpdate",
	"extensionError",
	"session",
	"beforeResponse",
] as const;

/** What a view needs from its hosted tab; LocalHostServices keeps the rules behind it. */
export interface HostedTabPort {
	readonly sidecar: SidecarLike;
	/** Who types through this view: its prompts are journaled as theirs. */
	readonly promptOrigin: PromptOrigin;
	/** A transcript page as the omp labelled it, relabelled for the viewer. */
	labelTranscript(data: unknown): unknown;
	/** Spawn the tab's omp if it has not run yet (a revived tab). */
	start(): void;
	/** Deliver the window's side-channel frame; an answer the device gave first throws `already_answered`. */
	answer(frame: object): void;
	/** The user pressed Stop here: nothing continues this turn after a crash. */
	stopped(): void;
	/** The user's Cancel on the tab's "waiting for the connection" row, or on its scheduled retry. */
	cancelWait(): void;
	/** The asks open now, the session's identity, the connection wait, a scheduled retry and its run, for a party that just joined. */
	snapshot(): {
		asks: ExtensionUIRequest[];
		sessionId?: string;
		title?: string;
		awaitingConnection?: boolean;
		scheduledRetry?: IpcScheduledRetry;
		run: RunReading;
	};
	/** The device asks for this subagent stream level; answers the level the tab's omp must hold for every viewer. */
	subagentLevel(level: SubagentSubscriptionLevel): SubagentSubscriptionLevel;
	/** The window left the tab. */
	leave(view: HostedTabView): void;
}

export class HostedTabView extends EventEmitter implements SidecarLike {
	readonly #port: HostedTabPort;
	readonly #forwarders: Array<[name: string, forward: (...args: unknown[]) => void]> = [];
	readonly #client: Pick<RpcClient, "command">;
	/** The text a `prompt_origin_set` from the window just named: its prompt carries that origin, not this computer's. */
	#namedOrigin: string | undefined;
	#left = false;
	/** Another party works in this omp too: the host decides steer/follow-up. */
	readonly shared = true;

	constructor(port: HostedTabPort) {
		super();
		this.#port = port;
		for (const name of VIEW_EVENTS) {
			const forward = (...args: unknown[]): void => {
				this.emit(name, ...args);
			};
			port.sidecar.on(name, forward);
			this.#forwarders.push([name, forward]);
		}
		this.#client = { command: (command, timeoutMs) => this.#command(command, timeoutMs) };
		queueMicrotask(() => {
			if (this.#left) return;
			const { asks, sessionId, title, awaitingConnection, scheduledRetry } = port.snapshot();
			if (sessionId !== undefined || title !== undefined) {
				const frame: SessionInfoUpdateFrame = { type: "session_info_update" };
				if (sessionId !== undefined) frame.sessionId = sessionId;
				if (title !== undefined) frame.title = title;
				this.emit("sessionInfoUpdate", frame);
			}
			this.emit("openAsks", asks);
			if (awaitingConnection) this.emit("awaitingConnection", true);
			if (scheduledRetry) this.emit("scheduledRetry", scheduledRetry);
		});
	}

	get status(): SidecarStatus {
		return this.#port.sidecar.status;
	}

	get statusPayload(): SidecarStatusPayload {
		return this.#port.sidecar.statusPayload;
	}

	get cwd(): string {
		return this.#port.sidecar.cwd;
	}

	get kind(): "agent" | "chat" {
		return this.#port.sidecar.kind;
	}

	get processAlive(): boolean {
		return this.#port.sidecar.processAlive;
	}

	/** How the tab's run stands now: a party joining mid-turn saw none of its start. */
	runReading(): RunReading {
		return this.#port.snapshot().run;
	}

	/** Null while the hosted omp is not connected, like the sidecar's own. */
	get rpcClient(): Pick<RpcClient, "command"> | null {
		return this.#port.sidecar.rpcClient ? this.#client : null;
	}

	start(): void {
		this.#port.start();
	}

	/** One omp: a restart here restarts the device's tab, as the device's own would. */
	restart(cwd?: string, resumeSessionPath?: string): void {
		if (this.status === "asleep") this.#port.start();
		else this.#port.sidecar.restart(cwd, resumeSessionPath);
	}

	adoptCwd(cwd: string): boolean {
		return this.#port.sidecar.adoptCwd(cwd);
	}

	sendSideChannel(frame: object): void {
		this.#port.answer(frame);
	}

	async cancelHostWait(): Promise<void> {
		this.#port.cancelWait();
	}

	// This computer's settings reach the hosted omp through LocalHostServices, once.
	syncImageGeneration(): void {}
	syncReplyLanguage(): void {}
	syncDefaultBrowser(): void {}
	syncUserProfile(): void {}
	syncNextPrompt(): void {}
	syncAutoTitle(): void {}
	syncJudgeAssist(): void {}
	syncHostTools(): void {}
	syncAccountRotation(): void {}

	/** The window left: its listeners come off the hosted omp; the device's tab runs on. */
	dispose(): void {
		if (this.#left) return;
		this.#left = true;
		for (const [name, forward] of this.#forwarders) this.#port.sidecar.off(name, forward);
		this.#forwarders.length = 0;
		this.#port.leave(this);
	}

	/** The device's tab ends: the window's tab closes quietly (the pool releases it), then the view lets go. */
	end(): void {
		if (this.#left) return;
		this.emit(VIEW_ENDED_EVENT);
		this.dispose();
	}

	async #command(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		const client = this.#port.sidecar.rpcClient;
		if (!client) throw codedError("sidecar_not_connected", "Sidecar not connected");
		if (command.type === "prompt_origin_set") this.#namedOrigin = command.text;
		else if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
			const named = this.#namedOrigin === command.message;
			this.#namedOrigin = undefined;
			if (!named) {
				const origin = this.#port.promptOrigin;
				await client.command({ type: "prompt_origin_set", origin, text: command.message }).catch(() => undefined);
			}
		}
		if (STOP_COMMANDS[command.type]) this.#port.stopped();
		// The tab's omp holds one level for every viewer: the device's counts with the windows' (the highest wins).
		const sent =
			command.type === "set_subagent_subscription"
				? { ...command, level: this.#port.subagentLevel(command.level) }
				: command;
		const response = await client.command(sent, timeoutMs);
		if (command.type !== "get_transcript_page" || !response.success) return response;
		return { ...response, data: this.#port.labelTranscript(response.data) };
	}
}

/**
 * A transcript page the hosted omp labelled for the device it serves (`labelPromptOrigins`: that device's
 * prompts plain, the others named), relabelled for a window of this computer: its own prompts plain (named
 * with this computer's name there), the device's named after it. Untouched while no prompt is labelled
 * (one device typed them all).
 */
export function labelForHost(data: unknown, origin: PromptOriginEnv): unknown {
	const page = data as { messages?: Array<{ role?: unknown; promptFrom?: string }> } | undefined;
	if (!Array.isArray(page?.messages) || !page.messages.some(message => message.promptFrom !== undefined)) return data;
	return {
		...page,
		messages: page.messages.map(message => {
			if (message.role !== "user") return message;
			if (message.promptFrom === undefined) return { ...message, promptFrom: origin.name };
			if (message.promptFrom !== origin.hostName) return message;
			const { promptFrom: _own, ...plain } = message;
			return plain;
		}),
	};
}
