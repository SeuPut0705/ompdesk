/**
 * Sidecar lifecycle manager: spawns the system `omp --mode rpc-ui` with the
 * gui-bridge extension, handles restart, routes frames to RpcClient and
 * EventBatcher, and answers GUI-side commands (src/main/local) in-process.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import Store from "electron-store";
import { parseLaunchProfile, profileToFlags, stripDenylistedFlags } from "../shared/launch-profile";
import { DEFAULT_ROLE_MODEL_SELECTOR, parseModelRestoreFailure } from "../shared/model-restore";
import type {
	AgentMessage,
	AgentSessionEvent,
	CommandOutputFrame,
	ConfigUpdateFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	HostToolCallRequest,
	HostUriRequest,
	ModelCatalogUpdateFrame,
	OutboundFrame,
	PromptResultFrame,
	RpcBtwFrame,
	RpcCommand,
	RpcLiveFrame,
	RpcReadyFrame,
	RpcResponse,
	SessionInfoUpdateFrame,
	SessionSettledFrame,
	SidecarRestartProgress,
	SidecarStatus,
	SidecarStatusPayload,
	SubagentFrame,
} from "../shared/rpc-types";
import { BTW_FRAME_TYPES, LIVE_FRAME_TYPES } from "../shared/rpc-types";
import { isNoModelBootFailure } from "./boot-model";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import type { BridgeConnectResult } from "./bridge-health";
import { EventBatcher } from "./event-batcher";
import { localHandlerFor, runLocalCommand } from "./local";
import { projectQueueUpdate } from "./local/queue";
import { attachEntryIds, fetchEntries } from "./local/sessions";
import type { LocalCommandContext, OmpRuntime } from "./local/types";
import { type OmpResolution, ompNeedsShell, ompPathEnv, ompSpawnArgs, ompSpawnCommand } from "./omp-runtime";
import { attachNdjsonParser, supportsRpcProtocolV2 } from "./rpc-bridge";
import { RpcClient } from "./rpc-client";

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS = [1000, 2000, 4000];

/** stderr lines kept per spawn for the crash report. */
const STDERR_TAIL_LINES = 20;
/** Cap on the stderr excerpt appended to the user-visible restart reason. */
const STDERR_REASON_CHARS = 240;
/** `ctx.send` from GUI-side handlers: stock commands such as `get_entries` on a long session. */
const LOCAL_SEND_TIMEOUT_MS = 120_000;
/** How long `agent_end` (and every frame behind it) may wait for its entry ids. */
const ENTRY_ID_TIMEOUT_MS = 5_000;
/** Longest wait after `exit` for the child's stderr to finish draining (a shim's grandchild may hold it open). */
const STDERR_DRAIN_MS = 1_000;

/** Files inside the gui-bridge directory (resources/gui-bridge). */
const BRIDGE_ENTRY = "index.ts";
/** `--config` overlay pinning `autoResume: false` so a fresh tab never reopens the last session. */
const FRESH_LAUNCH_CONFIG = "fresh-launch.yml";

/** Stock commands after which the sidecar's session identity is unknown until the next `get_state`. */
const SESSION_CHANGING_COMMANDS: Record<string, true> = {
	new_session: true,
	switch_session: true,
	fork: true,
	branch: true,
	handoff: true,
};

/**
 * Leading stderr line of the crashed spawn: a fatal message comes first
 * (`dyld: Library not loaded …`, `error: ENOENT …`) and whatever follows is
 * stack or warning noise. The full tail rides on the runtime-log report.
 */
function stderrExcerpt(lines: string[]): string {
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.length > STDERR_REASON_CHARS ? `${trimmed.slice(0, STDERR_REASON_CHARS - 1)}…` : trimmed;
	}
	return "";
}

/** Resolves once `child`'s stderr has closed, or after STDERR_DRAIN_MS. */
function stderrDrained(child: ChildProcess): Promise<void> {
	const stream = child.stderr;
	if (!stream || stream.closed) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, STDERR_DRAIN_MS);
	stream.once("close", () => {
		clearTimeout(timer);
		resolve();
	});
	return promise;
}

/** `ctx.send` over the stock path: resolves with `response.data`, rejects with `response.error`. */
function stockSender(client: RpcClient, timeoutMs: number): LocalCommandContext["send"] {
	return async <T>(command: { type: string; [k: string]: unknown }): Promise<T> => {
		// GUI-side handlers speak stock command names; RpcCommand only types the renderer's set.
		const stockCommand = command as RpcCommand;
		const response = await client.stock(stockCommand, timeoutMs);
		if (!response.success) throw new Error(response.error);
		// The caller names the stock response shape it asked for.
		return response.data as T;
	};
}

/** Event types routed to the EventBatcher. Hoisted: one lookup table for the
 * process, not one allocation per frame. */
const AGENT_EVENT_TYPES: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	model_changed: true,
	ttsr_triggered: true,
	todo_reminder: true,
	todo_auto_clear: true,
	irc_message: true,
	notice: true,
	thinking_level_changed: true,
	goal_updated: true,
	loop_mode_update: true,
	plan_proposal: true,
	queue_update: true,
};

type Frame = Record<string, unknown>;

/** The live session's identity as last reported by `get_state`. */
export interface SidecarSessionIdentity {
	sessionId?: string;
	sessionFile?: string;
}

export interface SidecarOptions {
	/** Resolves the system omp (path + version gate); consulted on every start(). */
	omp: () => Promise<OmpResolution>;
	/** The gui-bridge extension directory. Absent: no `-e`, no bridge (tests). */
	bridgeDir?: string;
	cwd: string;
	extraFlags?: string[];
	/** Fresh GUI tabs must not inherit the CLI's persistent autoResume setting. */
	fresh?: boolean;
	/**
	 * Session kind: "agent" (default) or "chat" (tool-free conversation, spawned
	 * with `--no-tools`). Immutable per sidecar; omp itself has no notion of it,
	 * so the GUI records chat sessions in its own metadata (session-kinds.ts).
	 */
	kind?: "agent" | "chat";
	/**
	 * Resolves proxy env vars (PI_PROXY / HTTPS_PROXY / …) injected at spawn —
	 * the GUI proxy pref or the macOS system proxy. Finder-launched apps have
	 * no shell env, so without this a proxy-only network (e.g. codex's
	 * chatgpt.com backend behind a firewall) hangs every provider request.
	 * Called on every start()/restart(); crash-loop respawns reuse the last
	 * result. Resolution failure degrades to no proxy env, never a spawn block.
	 */
	proxyEnv?: () => Promise<Record<string, string>>;
	/**
	 * Resolves the login-shell PATH overlay injected at spawn. Finder-launched
	 * apps inherit launchd's bare PATH, so agent-spawned tools configured by
	 * bare name (MCP servers, CLI helpers) die with ENOENT while the terminal
	 * TUI works. Same point-of-use pattern as proxyEnv: called on every
	 * start()/restart(), failure degrades to the inherited PATH.
	 */
	shellEnv?: () => Promise<Record<string, string>>;
	/**
	 * Persists a crash report (reason + stderr tail) for post-mortem diagnosis.
	 * Same point-of-use injection as `proxyEnv`/`shellEnv`: the real
	 * implementation is `writeRuntimeLog`, which resolves its path through
	 * Electron's `app`, so the manager must keep working without it.
	 */
	reportFailure?: (report: SidecarFailureReport) => void;
	/**
	 * A catalog `provider/model` selector for `runtime` (src/main/boot-model.ts).
	 * Absent: a spawn that exits with "No models available" just crash-loops.
	 */
	bootModel?: (runtime: OmpRuntime) => Promise<string>;
}

/** One crash-loop step, as handed to `reportFailure`. */
export interface SidecarFailureReport {
	/** Exit/signal reason with the leading stderr line appended. */
	reason: string;
	/** Respawn about to be scheduled, or the exhausted count on the final error. */
	attempt: number;
	maxAttempts: number;
	/** stderr tail captured from this spawn (up to STDERR_TAIL_LINES). */
	stderr: string[];
	cwd: string;
}

/**
 * Load the workspace's launch profile from GUI prefs (`launchProfiles.<cwd>`)
 * and map it to agent CLI flags. Prefs access mirrors the 0.3.1 proxy-env
 * pattern (point-of-use electron-store read); any failure — prefs unreadable,
 * non-electron test env, malformed JSON — degrades to no flags, never a
 * spawn block. Profile changes require a sidecar restart: flags are
 * spawn-time argv, there is no live apply.
 */
function loadLaunchProfileFlags(cwd: string): string[] {
	try {
		// projectName is only a fallback for electron-less environments (tests):
		// with the app present, electron-store's own userData cwd wins and the
		// store matches index.ts/ipc.ts exactly. A pre-typed variable sidesteps
		// the excess-property check — electron-store's Options type hides
		// projectName, but its constructor passes it through to conf.
		const storeOptions = { name: "prefs", projectName: "omp-gui" };
		const profiles = new Store<{ launchProfiles?: Record<string, unknown> }>(storeOptions).get("launchProfiles");
		if (typeof profiles !== "object" || profiles === null) return [];
		return profileToFlags(parseLaunchProfile(profiles[cwd]));
	} catch {
		return [];
	}
}

export interface SidecarEvents {
	status: (payload: SidecarStatusPayload) => void;
	events: (events: AgentSessionEvent[]) => void;
	extensionUi: (request: ExtensionUIRequest) => void;
	hostToolCall: (request: HostToolCallRequest) => void;
	hostUriRequest: (request: HostUriRequest) => void;
	subagentFrame: (frame: SubagentFrame) => void;
	liveFrame: (frame: RpcLiveFrame) => void;
	btwFrame: (frame: RpcBtwFrame) => void;
	modelCatalogUpdate: (frame: ModelCatalogUpdateFrame) => void;
	commandsUpdate: (commands: unknown[]) => void;
	sessionSettled: (frame: SessionSettledFrame) => void;
	frame: (frame: OutboundFrame) => void;
	/** The live session's id/file changed (observed through `get_state`). */
	session: (identity: SidecarSessionIdentity) => void;
	/** The gui-bridge connect settled for this spawn (bridge-health.ts checks it). */
	bridge: (result: BridgeConnectResult) => void;
}

export class SidecarManager extends EventEmitter {
	#child: ChildProcess | null = null;
	#rpcClient: RpcClient | null = null;
	#bridge: GuiBridgeClient | null = null;
	#bridgeAddress: string | null = null;
	#batcher: EventBatcher | null = null;
	#detachParser: (() => void) | null = null;
	#restartCount = 0;
	#restartTimer: NodeJS.Timeout | null = null;
	/**
	 * Spawn-cycle counter, bumped whenever a cycle is torn down or started.
	 * Every continuation that outlives the synchronous spawn (protocol
	 * negotiation, env resolution) captures it and drops itself when it no
	 * longer matches, so a dead child can never report `ready` or reset the
	 * crash-loop counter.
	 */
	#generation = 0;
	/** `start()` calls in flight; a superseded env resolution must not spawn. */
	#startSeq = 0;
	#lastStderr: string[] = [];
	/**
	 * `asleep` until something calls start(): a restored background tab costs
	 * nothing until it is shown. start() flips to `starting` synchronously, so
	 * "is a spawn already under way?" is answerable from this field alone.
	 */
	#status: SidecarStatus = "asleep";
	/**
	 * The last `status` event's detail. An early failure (e.g. omp not found)
	 * fires before the window subscribes; the renderer's boot snapshot
	 * (SIDECAR_STATUS_GET) reads this so the reason is not lost.
	 */
	#statusDetail: Pick<SidecarStatusPayload, "message" | "restart" | "modelFallback"> = {};
	#options: SidecarOptions;
	#runtime: OmpRuntime | null = null;
	#proxyEnvVars: Record<string, string> = {};
	#shellEnvVars: Record<string, string> = {};
	#resumeSessionPath: string | null = null;
	#freshLaunchPending: boolean;
	/** Whether the current spawn cycle reached `ready`. */
	#bootedThisSpawn = false;
	/**
	 * Saved session model that failed to restore at boot. The next spawn adds
	 * `--model @default` so the session opens on the configured default model
	 * instead of exiting (upstream resumes fail closed), and the ready status
	 * carries it so the renderer can say so.
	 */
	#bootModelFallback: string | null = null;
	/**
	 * Catalog model the next spawns pass as `--model` after one exited with "No
	 * models available" (no credentials yet): booting is what lets the renderer
	 * open onboarding to connect a provider. Cleared on `ready` and restart().
	 */
	#noModelBoot: string | null = null;
	/** Last session identity `get_state` reported; null when a session change made it unknown. */
	#session: SidecarSessionIdentity | null = null;
	/** Newest session entry seen by the `agent_end` entry-id fetch (its `get_entries` cursor). */
	#lastEntryId: string | null = null;
	/**
	 * An `agent_end` waiting for its entry ids, and every non-response frame that
	 * arrived behind it. Holding the tail keeps the renderer's frame order
	 * (`agent_end` before `prompt_result`/`session_settled`) intact.
	 */
	#held: { event: Frame; frames: Frame[] } | null = null;
	#disposed = false;

	constructor(options: SidecarOptions) {
		super();
		this.#options = options;
		this.#freshLaunchPending = options.fresh === true;
	}

	get status(): SidecarStatus {
		return this.#status;
	}

	/** Last status with its message/restart detail, for late subscribers. */
	get statusPayload(): SidecarStatusPayload {
		return { status: this.#status, cwd: this.#options.cwd, ...this.#statusDetail };
	}

	get cwd(): string {
		return this.#options.cwd;
	}

	get kind(): "agent" | "chat" {
		return this.#options.kind ?? "agent";
	}

	get rpcClient(): RpcClient | null {
		return this.#rpcClient;
	}

	start(): void {
		if (this.#disposed) return;
		this.#setStatus("starting");
		const { omp, proxyEnv, shellEnv } = this.#options;
		const fallback = () => ({}) as Record<string, string>;
		// omp + env resolution takes up to a few seconds. A restart()/start()
		// landing inside that window supersedes this pending spawn — it already
		// killed whatever child existed (nothing yet) — so spawning here would
		// orphan the newer child and tear it down with the session it just opened.
		const seq = ++this.#startSeq;
		void Promise.all([
			omp().catch(
				(err: unknown): OmpResolution => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
			),
			proxyEnv ? proxyEnv().catch(fallback) : Promise.resolve({}),
			shellEnv ? shellEnv().catch(fallback) : Promise.resolve({}),
		]).then(([resolution, proxyVars, shellVars]) => {
			if (this.#disposed || seq !== this.#startSeq) return;
			if (!resolution.ok) {
				this.#setStatus("error", resolution.error);
				return;
			}
			this.#runtime = resolution.runtime;
			this.#proxyEnvVars = proxyVars;
			this.#shellEnvVars = shellVars;
			this.#spawn();
		});
	}

	#spawn(): void {
		// One live child per manager. `#child` is only ever set here, so anything
		// still attached means a previous spawn was never retired — kill it through
		// the normal teardown instead of letting it run parser-less and unkillable.
		const superseded = this.#child;
		if (superseded) {
			this.#cleanup();
			superseded.kill("SIGTERM");
		}
		const runtime = this.#runtime;
		if (!runtime) return;
		this.#generation++;
		this.#lastStderr = [];
		this.#bootedThisSpawn = false;
		this.#session = null;
		this.#lastEntryId = null;
		const { bridgeDir, cwd, extraFlags } = this.#options;

		const args = ["--mode", "rpc-ui"];
		if (this.#resumeSessionPath) args.push("--session", this.#resumeSessionPath);
		else if (this.#freshLaunchPending && bridgeDir) args.push("--config", join(bridgeDir, FRESH_LAUNCH_CONFIG));
		if (this.#noModelBoot) args.push("--model", this.#noModelBoot);
		else if (this.#bootModelFallback) args.push("--model", DEFAULT_ROLE_MODEL_SELECTOR);
		if (this.#options.kind === "chat") args.push("--no-tools");
		const bridgeAddress = bridgeDir ? newBridgeAddress() : null;
		if (bridgeDir) args.push("-e", join(bridgeDir, BRIDGE_ENTRY));
		// User-controllable flags ride the extraFlags seam + the launch profile.
		// Strip the code-controlled-flag denylist (pair-aware) over BOTH, then
		// append: neither can override the code-controlled argv above, while a
		// profile value that merely looks like a protected flag survives intact.
		const userFlags = [...(extraFlags ?? []), ...loadLaunchProfileFlags(cwd)];
		args.push(...stripDenylistedFlags(userFlags));

		const bin = runtime.bin;
		console.log(`[sidecar] spawning omp ${runtime.version} (${args.length} args, cwd: ${cwd})`);

		let child: ChildProcess;
		try {
			child = spawn(ompSpawnCommand(bin), ompSpawnArgs(bin, args), {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					// Login-shell PATH first so the GUI proxy pref (and inherited
					// proxy env) keeps precedence over rc-file proxy exports.
					...this.#shellEnvVars,
					...this.#proxyEnvVars,
					PATH: ompPathEnv(bin, this.#shellEnvVars.PATH ?? process.env.PATH ?? ""),
					...(bridgeAddress ? { OMP_GUI_BRIDGE: bridgeAddress } : {}),
					PI_RPC_EMIT_TITLE: "1",
					PI_NO_PTY: "1",
					PI_NOTIFICATIONS: "off",
				},
				cwd,
				shell: ompNeedsShell(bin),
				windowsHide: true,
			});
		} catch (err) {
			// spawn() throws synchronously (EBADF/ENOENT) — surface it as a
			// sidecar failure + retry, never an uncaught main-process exception.
			this.#attemptRestart(err instanceof Error ? err.message : String(err));
			return;
		}

		this.#child = child;
		this.#bridgeAddress = bridgeAddress;
		const bridge = new GuiBridgeClient(bridgeAddress ?? "");
		bridge.onEvent(event => this.#routeFrame(event));
		this.#bridge = bridge;

		// Set up RPC client with stdin writer
		const send = (frame: object) => {
			if (child.stdin?.writable) {
				child.stdin.write(`${JSON.stringify(frame)}\n`);
			}
		};
		const rpcClient: RpcClient = new RpcClient(send, {
			local: command => {
				const handler = localHandlerFor(command.type);
				if (!handler) return undefined;
				return this.#localContext(rpcClient, runtime, bridge).then(ctx => runLocalCommand(handler, command, ctx));
			},
			observe: (command, response) => this.#observeResponse(command, response),
		});
		this.#rpcClient = rpcClient;

		// Set up event batcher
		this.#batcher = new EventBatcher(events => {
			this.emit("events", events);
		});

		// Parse stdout NDJSON
		if (child.stdout) {
			this.#detachParser = attachNdjsonParser(child.stdout, frame => this.#routeFrame(frame));
		}

		// Log stderr to main process console for diagnostics, and keep a per-spawn
		// tail: a sidecar that dies before it can log anywhere only speaks through
		// this pipe, so without the ring the crash report is just an exit code.
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8").trim();
			if (text) {
				console.error(`[sidecar stderr] ${text}`);
				for (const line of text.split("\n")) {
					this.#lastStderr.push(line);
					if (this.#lastStderr.length > STDERR_TAIL_LINES) this.#lastStderr.shift();
				}
				this.emit("stderr", text);
			}
		});

		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#cleanup();
			if (this.#disposed) return;
			if (code === 0) {
				this.#setStatus("exited", "Normal shutdown");
				return;
			}
			// `exit` can fire before stderr has drained, and the boot-failure
			// parsers below read it; a restart() meanwhile advances the generation.
			const generation = this.#generation;
			void stderrDrained(child).then(() => {
				if (!this.#isLive(generation)) return;
				if (this.#recoverBootModelRestore()) {
					this.#spawn();
				} else if (!this.#recoverNoModelBoot()) {
					this.#attemptRestart(`Exit code ${code}${signal ? ` (signal: ${signal})` : ""}`);
				}
			});
		});

		child.on("error", err => {
			if (this.#child !== child) return;
			this.#cleanup();
			if (this.#disposed) return;
			this.#attemptRestart(err.message);
		});
	}

	/** Context for one GUI-side command; learns the session identity first when a session change left it unknown. */
	async #localContext(client: RpcClient, runtime: OmpRuntime, bridge: GuiBridgeClient): Promise<LocalCommandContext> {
		const send = stockSender(client, LOCAL_SEND_TIMEOUT_MS);
		if (!this.#session) await client.stock({ type: "get_state" }).catch(() => undefined);
		return {
			cwd: this.#options.cwd,
			sessionId: this.#session?.sessionId,
			sessionFile: this.#session?.sessionFile,
			omp: runtime,
			send,
			bridge,
			emit: frame => this.#routeFrame(frame),
		};
	}

	/** Track the session identity through the responses every hydrate already requests. */
	#observeResponse(command: RpcCommand, response: RpcResponse): void {
		if (!response.success) return;
		if (command.type === "get_state") {
			const data = response.data;
			if (typeof data !== "object" || data === null) return;
			const next: SidecarSessionIdentity = {
				sessionId: "sessionId" in data && typeof data.sessionId === "string" ? data.sessionId : undefined,
				sessionFile: "sessionFile" in data && typeof data.sessionFile === "string" ? data.sessionFile : undefined,
			};
			const previous = this.#session;
			this.#session = next;
			if (previous?.sessionId !== next.sessionId || previous?.sessionFile !== next.sessionFile) {
				this.emit("session", next);
			}
		} else if (SESSION_CHANGING_COMMANDS[command.type] === true) {
			this.#session = null;
		}
	}

	#routeFrame(frame: unknown): void {
		if (typeof frame !== "object" || frame === null) return;
		let obj = frame as Frame;
		// Responses never wait: the held `agent_end` is itself awaiting one.
		if (obj.type !== "response") {
			// Stock queue lanes are bare text; ids are assigned on arrival, in stream order.
			if (obj.type === "queue_update" && this.#bridge) obj = projectQueueUpdate(this.#bridge, obj);
			if (this.#held) {
				this.#held.frames.push(obj);
				return;
			}
			if (obj.type === "agent_end" && Array.isArray(obj.messages) && this.#rpcClient) {
				this.#holdForEntryIds(obj, this.#rpcClient);
				return;
			}
			if (obj.type === "session_info_update") this.#session = null;
		}
		this.#dispatchFrame(obj);
	}

	/**
	 * Stock `agent_end` messages carry no `entryId`, which the renderer needs to
	 * reconcile committed messages. Fetch the entries appended since the last
	 * look, stamp the ids, then release the event and everything behind it.
	 */
	#holdForEntryIds(event: Frame, client: RpcClient): void {
		const held = { event, frames: [] as Frame[] };
		this.#held = held;
		const generation = this.#generation;
		const send = stockSender(client, ENTRY_ID_TIMEOUT_MS);
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(() => timeout.reject(new Error("entry id fetch timed out")), ENTRY_ID_TIMEOUT_MS);
		void Promise.race([fetchEntries(send, this.#lastEntryId), timeout.promise])
			.then(
				snapshot => {
					const last = snapshot.entries.at(-1);
					if (last) this.#lastEntryId = last.id;
					// Array-checked in #routeFrame; the elements are omp's wire messages.
					const messages = event.messages as AgentMessage[];
					return { ...event, messages: attachEntryIds(messages, snapshot.entries) };
				},
				() => event,
			)
			.then(enriched => {
				clearTimeout(timer);
				if (!this.#isLive(generation) || this.#held !== held) return;
				this.#held = null;
				this.#dispatchFrame(enriched);
				for (const frame of held.frames) this.#routeFrame(frame);
			});
	}

	/** Release a held `agent_end` and its tail unchanged (the spawn is going away). */
	#releaseHeld(): void {
		const held = this.#held;
		if (!held) return;
		this.#held = null;
		this.#dispatchFrame(held.event);
		for (const frame of held.frames) this.#dispatchFrame(frame);
	}

	#dispatchFrame(obj: Frame): void {
		// Ready frame
		if (obj.type === "ready") {
			this.#handleReady(obj as unknown as RpcReadyFrame);
			return;
		}

		// Response frame → route to RPC client
		if (obj.type === "response") {
			const handled = this.#rpcClient?.onResponse(obj as unknown as RpcResponse);
			if (handled) return;
		}

		// Extension UI request
		if (obj.type === "extension_ui_request") {
			this.emit("extensionUi", obj as ExtensionUIRequest);
			this.emit("frame", obj);
			return;
		}

		// Host tool/URI requests
		if (obj.type === "host_tool_call") {
			this.emit("hostToolCall", obj as unknown as HostToolCallRequest);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "host_uri_request") {
			this.emit("hostUriRequest", obj as unknown as HostUriRequest);
			this.emit("frame", obj);
			return;
		}

		// Subagent frames
		if (obj.type === "subagent_lifecycle" || obj.type === "subagent_progress" || obj.type === "subagent_event") {
			this.emit("subagentFrame", obj as unknown as SubagentFrame);
			this.emit("frame", obj);
			return;
		}

		// Available commands update
		if (obj.type === "available_commands_update") {
			this.emit("commandsUpdate", (obj as { commands: unknown[] }).commands);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "model_catalog_update") {
			this.emit("modelCatalogUpdate", obj as unknown as ModelCatalogUpdateFrame);
			this.emit("frame", obj);
			return;
		}

		// Config update (set_setting, slash-command config edits)
		if (obj.type === "config_update") {
			this.emit("configUpdate", obj as unknown as ConfigUpdateFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "prompt_result") {
			this.emit("promptResult", obj as unknown as PromptResultFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "session_settled") {
			this.emit("sessionSettled", obj as unknown as SessionSettledFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "command_output") {
			this.emit("commandOutput", obj as unknown as CommandOutputFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "session_info_update") {
			this.emit("sessionInfoUpdate", obj as unknown as SessionInfoUpdateFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "extension_error") {
			this.emit("extensionError", obj as unknown as ExtensionErrorFrame);
			this.emit("frame", obj);
			return;
		}
		if (LIVE_FRAME_TYPES.has(obj.type as string)) {
			this.emit("liveFrame", obj as unknown as RpcLiveFrame);
			this.emit("frame", obj);
			return;
		}
		if (BTW_FRAME_TYPES[obj.type as string] === true) {
			this.emit("btwFrame", obj as unknown as RpcBtwFrame);
			this.emit("frame", obj);
			return;
		}

		// Agent session events → batcher
		if (AGENT_EVENT_TYPES[obj.type as string] === true) {
			this.#batcher?.push(obj as AgentSessionEvent);
			this.emit("frame", obj);
			return;
		}

		// Other extension/host frames not consumed directly by the renderer.
		this.emit("frame", obj);
	}

	#handleReady(ready: RpcReadyFrame): void {
		this.#resumeSessionPath = null;
		this.#bootedThisSpawn = true;
		const modelFallback = this.#bootModelFallback ?? undefined;
		this.#bootModelFallback = null;
		this.#noModelBoot = null;
		// Freshness is a creation contract, not a restart policy. Once the new
		// tab has booted successfully, later crash/manual restarts may auto-resume
		// the session it has since created or opened.
		this.#freshLaunchPending = false;
		// Negotiation settles after this frame — and when the sidecar dies on boot,
		// `#cleanup()` rejects the pending command on a generation that is already
		// gone. Unguarded, that rejection announced "ready" and zeroed the restart
		// counter, so a broken binary respawned forever behind a healthy UI.
		// Stay on v1 when an older/malformed sidecar omits the negotiation fields
		// or advertises limits this decoder cannot safely honor.
		const generation = this.#generation;
		// The extension listens before omp prints `ready`; connecting first means
		// GUI-side commands can use the bridge from the first renderer request.
		const bridge = this.#bridge;
		const ompVersion = this.#runtime?.version ?? "unknown";
		const bridgeReady =
			this.#options.bridgeDir && bridge
				? bridge.connect().then(
						() => {
							if (this.#isLive(generation)) this.emit("bridge", { connected: true, ompVersion, bridge });
						},
						(err: unknown) => {
							const error = err instanceof Error ? err.message : String(err);
							console.warn(`[sidecar] gui-bridge unavailable: ${error}`);
							if (this.#isLive(generation)) this.emit("bridge", { connected: false, ompVersion, error });
						},
					)
				: Promise.resolve();
		const announceReady = (): void => {
			void bridgeReady.then(() => {
				if (!this.#isLive(generation)) return;
				this.#setStatus("ready", undefined, undefined, modelFallback);
				this.#restartCount = 0;
			});
		};
		const announceReadyWithEventFilter = (): void => {
			if (this.#isLive(generation) && this.#rpcClient) {
				void this.#rpcClient
					.command({ type: "set_event_filter", events: Object.keys(AGENT_EVENT_TYPES) })
					.catch(() => {});
				// Opt into upstream's `ask` protocol — the GUI renders ask dialogs.
				void this.#rpcClient.command({ type: "set_ask_dialog", enabled: true }).catch(() => {});
			}
			announceReady();
		};
		if (supportsRpcProtocolV2(ready)) {
			this.#rpcClient
				?.command({ type: "negotiate_protocol", protocolVersion: 2 })
				.then(announceReadyWithEventFilter, announceReady);
		} else {
			announceReady();
		}
	}

	/** Continuation guard: false once the spawn cycle that captured `generation`
	 *  has been torn down or replaced. */
	#isLive(generation: number): boolean {
		return !this.#disposed && generation === this.#generation;
	}

	#attemptRestart(reason: string): void {
		// The exit code alone is never the diagnosis; the spawn's stderr carries it.
		const excerpt = stderrExcerpt(this.#lastStderr);
		const detail = excerpt ? `${reason} — ${excerpt}` : reason;
		const exhausted = this.#restartCount >= MAX_RESTART_ATTEMPTS;
		const attempt = exhausted ? MAX_RESTART_ATTEMPTS : this.#restartCount + 1;
		this.#options.reportFailure?.({
			reason: detail,
			attempt,
			maxAttempts: MAX_RESTART_ATTEMPTS,
			stderr: [...this.#lastStderr],
			cwd: this.#options.cwd,
		});
		if (exhausted) {
			this.#setStatus("error", detail, { attempt, maxAttempts: MAX_RESTART_ATTEMPTS });
			return;
		}

		const delay = RESTART_DELAYS[attempt - 1] ?? 4000;
		this.#restartCount = attempt;
		this.#setStatus("restarting", detail, { attempt, maxAttempts: MAX_RESTART_ATTEMPTS });

		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			if (!this.#disposed) {
				this.#spawn();
			}
		}, delay);
	}

	/**
	 * A spawn that died before `ready` because its saved session model could not
	 * be restored would fail identically on every retry. Arm one `--model @default`
	 * respawn instead (outside the crash budget); true when armed.
	 */
	#recoverBootModelRestore(): boolean {
		if (this.#bootedThisSpawn || this.#bootModelFallback) return false;
		const missing = parseModelRestoreFailure(this.#lastStderr.join("\n"));
		if (!missing) return false;
		console.warn(`[sidecar] session model ${missing} unavailable at boot — resuming on the default model`);
		this.#bootModelFallback = missing;
		return true;
	}

	/**
	 * Stock omp exits before `ready` when no model has credentials, and would on
	 * every retry. Arm one respawn with an explicit catalog model instead
	 * (outside the crash budget); true when armed. A spawn that already carried
	 * it falls through to the crash-loop path.
	 */
	#recoverNoModelBoot(): boolean {
		const resolve = this.#options.bootModel;
		const runtime = this.#runtime;
		if (!resolve || !runtime || this.#bootedThisSpawn || this.#noModelBoot) return false;
		if (!isNoModelBootFailure(this.#lastStderr.join("\n"))) return false;
		// kill()/restart() while the selector resolves advance the generation.
		const generation = this.#generation;
		void resolve(runtime).then(selector => {
			if (!this.#isLive(generation) || this.#child) return;
			console.warn(`[sidecar] omp has no usable model — booting on ${selector} so onboarding can connect one`);
			this.#noModelBoot = selector;
			this.#spawn();
		});
		return true;
	}

	#setStatus(status: SidecarStatus, message?: string, restart?: SidecarRestartProgress, modelFallback?: string): void {
		this.#status = status;
		this.#statusDetail = { message, restart, modelFallback };
		this.emit("status", { status, message, cwd: this.#options.cwd, restart, modelFallback });
	}

	#cleanup(): void {
		// Any async continuation of the current cycle (pending negotiation) is
		// stale from here on, even before the replacement spawns.
		this.#generation++;
		this.#detachParser?.();
		this.#detachParser = null;
		this.#releaseHeld();
		this.#batcher?.flushNow();
		this.#batcher?.dispose();
		this.#batcher = null;
		this.#rpcClient?.rejectAll("Sidecar disconnected");
		this.#rpcClient = null;
		this.#bridge?.close();
		this.#bridge = null;
		if (this.#bridgeAddress) removeBridgeAddress(this.#bridgeAddress);
		this.#bridgeAddress = null;
		this.#child = null;
	}

	/** Send a side-channel frame (bypasses command queue). */
	sendSideChannel(frame: object): void {
		if (this.#child?.stdin?.writable) {
			this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		}
	}

	/** Mark the sidecar as unhealthy (e.g. health check failed after ready). */
	markUnhealthy(reason: string): void {
		this.#setStatus("error", reason);
	}

	/**
	 * Adopt a new logical cwd WITHOUT a respawn. `switch_session` onto a file
	 * rooted in another workspace re-roots the agent with no main-observable
	 * event, leaving `get cwd()` (and the tab chip reading it) frozen at the
	 * spawn cwd. The RPC passthrough reports the post-switch cwd here so every
	 * consumer — status payloads, future plain `restart()` spawns,
	 * launch-profile lookup — follows the live session. Project switch goes
	 * through `restart(cwd)` instead (explicit re-root). Returns true when the
	 * cwd actually changed.
	 */
	adoptCwd(cwd: string): boolean {
		if (cwd === this.#options.cwd) return false;
		this.#options = { ...this.#options, cwd };
		return true;
	}

	restart(cwd?: string, resumeSessionPath?: string): void {
		this.kill();
		if (cwd) this.#options = { ...this.#options, cwd };
		this.#resumeSessionPath = resumeSessionPath ?? null;
		this.#bootModelFallback = null;
		this.#noModelBoot = null;
		this.#restartCount = 0;
		this.start();
	}

	kill(): void {
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		const child = this.#child;
		this.#cleanup();
		child?.kill("SIGTERM");
	}

	dispose(): void {
		this.#disposed = true;
		this.kill();
		this.removeAllListeners();
	}
}
