/**
 * The host role's application services (B side): what a paired device may do
 * on this computer once its connection is authenticated.
 *
 * Tabs: each `(peer.deviceId, rtab)` gets a real SidecarManager from the same
 * factory local tabs use, so the session runs with this machine's omp, files,
 * git and credentials. Every lookup is scoped by the CALLING peer, so one
 * device can never address another device's tabs. The allowlisted sidecar
 * events go back as `tab.event`; host tool calls (gui_open_url, notify,
 * clipboard) are among them and are answered by the client device — nothing
 * here executes them. When a connection drops, its tabs keep running for a
 * grace period; a reconnect re-attaches by rtab and gets the status again.
 * Whether each tab is running a turn is tracked here too (the same rules as
 * the local pool's "running"), so the host can keep this computer awake, and
 * the tabs are this computer's resume coordinator's (turn-resume.ts): their
 * markers, the continuation after a crash or quit, and the wait for this
 * computer's connection are the host's; the device only shows that wait.
 * A relaunched device reopens its tabs under new rtabs: the open takes over
 * the tab its previous connection left on that session instead of a second omp.
 *
 * Host-level calls: session listing/search/kind/delete/rename against this
 * machine's session index, the workspace fs reads (same confinement and caps
 * as the local handlers; the file viewer's `host.fs.readBinary` is capped to
 * fit one link frame), the folder picker listing, the default workspace and
 * launch profiles. Session index changes are pushed as `sessions.changed`.
 * The other `host.*` calls are what a device's Settings, Usage and Stats show for a
 * tab here: this machine's models.yml providers, stats server, `omp bench`, model
 * setup research and account-rotation pref (machine-services.ts), one benchmark and
 * one research run per device, aborted when it drops.
 */
import { promises as fsp } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { PromptOriginEnv } from "../../../resources/gui-bridge/prompt-origin-contracts";
import { ACCOUNT_ROTATION_MODES } from "../../shared/account-rotation";
import { codedError } from "../../shared/ipc-error-codes";
import { ModelSetupRequestSchema } from "../../shared/model-setup";
import type { OmpUpdateState } from "../../shared/omp-update";
import { MAX_RPC_COMMAND_TIMEOUT_MS } from "../../shared/rpc-client";
import {
	type AgentSessionEvent,
	BLOCKING_UI_METHODS,
	type ExtensionUIRequest,
	type PromptResultFrame,
	type RpcCommand,
	type RpcResponse,
	type SidecarStatusPayload,
} from "../../shared/rpc-types";
import type { TerminalOperation } from "../../shared/terminal-types";
import type { BridgeConnectResult } from "../bridge-health";
import { canonicalCwd } from "../canonical-cwd";
import { type LaunchProfilePrefs, readLaunchProfile, updateLaunchProfile } from "../launch-profile-store";
import type { MachineServices } from "../machine-services";
import { ompRestartDecision } from "../omp-restart";
import type { SessionIndex } from "../session-index";
import { deleteSession, moveSession, renameSession } from "../session-mutations";
import type { SidecarSessionIdentity } from "../sidecar";
import type { SidecarLike, SidecarPool } from "../sidecar-pool";
import { idleRun, type RunState, type RunTracking, runBusy, settleRun, trackRunEvent } from "../sidecar-run-state";
import { stockHelperRequest } from "../stock-helper";
import { disposeTerminals, terminalRequest } from "../terminal/requests";
import { detectShells } from "../terminal/shells";
import { type ResumeFact, type ResumeMarker, STOP_COMMANDS, type TurnResume } from "../turn-resume";
import {
	FS_BINARY_REMOTE_MAX_BYTES,
	listDirectories,
	listWorkspace,
	mutateWorkspace,
	readPlanFile,
	readWorkspaceBinary,
	readWorkspaceFile,
	readWorkspaceImage,
	statWorkspacePath,
} from "../workspace-fs";
import { searchWorkspace } from "../workspace-search";
import {
	BenchmarkOptionsSchema,
	CustomProviderInputSchema,
	encodeBinaryRead,
	ModelOverrideInputSchema,
	OMP_UPDATE_EVENT,
	SESSIONS_CHANGED_EVENT,
	TAB_EVENT,
	TAB_EVENT_NAMES,
	type TabBridgeArg,
	type TabEventMessage,
	type TabEventName,
	type TabOpenResult,
	type TabSignInArg,
	type TabStatusArg,
} from "./app-protocol";
import type { HostConnection, HostServices } from "./host-server";
import type { PeerQuota } from "./peer-quota";
import type { PeerInfo } from "./peers-store";
import { commandUsesModel } from "./quota-commands";

/** How long a disconnected device's tabs keep running, waiting for it to come back. */
export const HOST_TAB_GRACE_MS = 10 * 60_000;
/** Session-index changes come in bursts while an agent writes; one push per burst. */
const SESSIONS_CHANGED_DEBOUNCE_MS = 300;

export interface HostServicesDeps {
	/**
	 * This machine's sidecar factory — the one the local pool uses. `origin`
	 * names the device the tab runs for, so its prompts are journalled as that
	 * device's (A85, resources/gui-bridge/prompt-origin.ts).
	 */
	createSidecar: (cwd: string, kind: "agent" | "chat", fresh: boolean, origin: PromptOriginEnv) => SidecarLike;
	/** This computer's device name (Settings › Devices), for prompts typed on it. */
	hostName: () => string;
	sessionIndex: Pick<
		SessionIndex,
		"list" | "searchContent" | "kindFor" | "deleteSession" | "moveSession" | "sessionsDir"
	>;
	/** Stored-file rename for a session no live tab holds (`omp` on this machine). */
	renameStoredSession: (sessionPath: string, name: string) => Promise<void>;
	/** The GUI-owned Work workspace, created on demand. */
	defaultWorkspace: () => string;
	launchProfiles: LaunchProfilePrefs;
	/** This machine's models.yml, stats server and `omp bench`. */
	machine: MachineServices;
	/**
	 * This machine's own tabs (the local pool): a session file one of them
	 * holds is changed through that tab, and a credential change reaches them.
	 */
	localTabs: Pick<
		SidecarPool,
		| "sessionOwner"
		| "sessionOwnerIsLive"
		| "commandForSession"
		| "commandForIdleSession"
		| "noteSessionFile"
		| "allSidecars"
	>;
	/** Moves a path to this machine's trash (Electron `shell.trashItem`). */
	trashItem: (abs: string) => Promise<void>;
	graceMs?: number;
}

/** `run`, `lastRun`, `stopped` and `retry` follow the sidecar's events (`trackRunEvent`), like a local tab's. */
interface HostTab extends RunTracking {
	peerId: string;
	rtab: string;
	/** The tab's id for this computer's resume coordinator; kept when a relaunched device re-keys the tab. */
	resumeId: string;
	sidecar: SidecarLike;
	/** The connection events go to; null while the device is away (grace period). */
	conn: HostConnection | null;
	/** Resumed by the first `tab.start`. */
	resumeSessionPath: string | undefined;
	/** Session file the sidecar last reported (live-owner checks for delete/rename). */
	sessionFile: string | undefined;
	graceTimer: NodeJS.Timeout | undefined;
	run: RunState;
	/**
	 * Open asks and approvals the device has not answered, by request id, as the omp raised them:
	 * every `tab.open` re-sends them (`openAsks`), since the device missed whatever changed while away.
	 */
	asks: Map<string, ExtensionUIRequest>;
	/** The turn waits for this computer's internet connection (turn-resume.ts). */
	awaitingConnection?: boolean;
	/** Provider ids of the `login` commands running on this tab (a device's sign-in, even if its link dropped). */
	signIns?: string[];
	/** `omp update` landed during a turn: the tab restarts on the new omp when it ends. */
	ompRestartPending?: boolean;
}

const Rtab = z.string().min(1).max(128);
const AbsolutePath = z.string().min(1).refine(isAbsolute, "absolute path required");
const SessionPath = z.string().endsWith(".jsonl");
const Scope = z.enum(["local", "global"]);

const RtabParams = z.object({ rtab: Rtab });
const OpenParams = z.object({
	rtab: Rtab,
	cwd: AbsolutePath.optional(),
	kind: z.enum(["agent", "chat"]).optional(),
	fresh: z.boolean().optional(),
	sessionPath: SessionPath.optional(),
});
const RestartParams = z.object({ rtab: Rtab, cwd: AbsolutePath.optional(), sessionPath: SessionPath.optional() });
const AdoptCwdParams = z.object({ rtab: Rtab, cwd: AbsolutePath });
const CommandParams = z.object({
	rtab: Rtab,
	command: z.object({ type: z.string().min(1) }).passthrough(),
	// Up to the longest window the GUI itself gives a command (a login waits on
	// the browser, a bash or a PR checkout runs long): every command a device sends fits.
	timeoutMs: z.number().int().positive().max(MAX_RPC_COMMAND_TIMEOUT_MS).optional(),
});
const SideChannelParams = z.object({ rtab: Rtab, frame: z.object({}).passthrough() });
const SessionsListParams = z.object({ scope: Scope, cwd: AbsolutePath.optional() });
const SessionsSearchParams = z.object({ query: z.string(), scope: Scope, cwd: AbsolutePath.optional() });
const SessionPathParams = z.object({ sessionPath: SessionPath });
const RenameParams = z.object({ sessionPath: SessionPath, name: z.string() });
const MoveParams = z.object({ sessionPath: SessionPath, cwd: AbsolutePath });
/** fs reads root at the tab's cwd; `cwd` covers a tab the host has not opened yet. */
const FsRoot = { rtab: Rtab.optional(), cwd: AbsolutePath.optional() };
const FsListParams = z.object({
	...FsRoot,
	path: z.string().optional(),
	maxDepth: z.number().optional(),
	maxEntries: z.number().optional(),
});
const FsReadParams = z.object({ ...FsRoot, path: z.string(), maxBytes: z.number().optional() });
const FsReadImageParams = z.object({ ...FsRoot, path: z.string() });
const FsMutateParams = z.object({ ...FsRoot, mutation: z.unknown() });
const FsSearchParams = z.object({ ...FsRoot, request: z.unknown() });
const FsReadPlanParams = z.object({ ...FsRoot, fsPath: z.string(), localRoot: z.string().nullable() });
const ListDirsParams = z.object({ path: z.string().optional(), query: z.string().max(255).optional() });
const LaunchProfileGetParams = z.object({ cwd: AbsolutePath });
const LaunchProfileUpdateParams = z.object({ cwd: AbsolutePath, patch: z.record(z.unknown()) });
const ModelsUpsertParams = z.object({ input: CustomProviderInputSchema });
const ModelsDeleteParams = z.object({ id: z.string().min(1) });
const ModelsOverrideParams = z.object({
	provider: z.string().min(1).max(200),
	modelId: z.string().min(1).max(400),
	override: ModelOverrideInputSchema.nullable(),
});
const StatsFetchParams = z.object({ path: z.string().min(1).max(512), params: z.record(z.string()).optional() });
const BenchRunParams = z.object({ ...FsRoot, options: BenchmarkOptionsSchema });
const ModelSetupRunParams = z.object({ request: ModelSetupRequestSchema });
const AccountRotationSetParams = z.object({ mode: z.enum(ACCOUNT_ROTATION_MODES) });
const BuiltinReaSetParams = z.object({ enabled: z.boolean() });
const TerminalParams = z.object({ rtab: Rtab, operation: z.object({ action: z.string() }).passthrough() });
const DesktopUpdateParams = z.object({ action: z.enum(["check", "download", "install"]) });

function parse<T extends z.ZodTypeAny>(schema: T, method: string, params: unknown): z.infer<T> {
	const parsed = schema.safeParse(params ?? {});
	if (!parsed.success) throw new Error(`Invalid ${method} parameters: ${parsed.error.issues[0]?.message ?? ""}`);
	return parsed.data;
}

async function directory(cwd: string): Promise<string> {
	try {
		if ((await fsp.stat(cwd)).isDirectory()) return canonicalCwd(cwd);
	} catch {
		throw codedError("file_not_found", `Directory not found: ${cwd}`);
	}
	throw codedError("not_a_directory", `Not a directory: ${cwd}`);
}

/** Tokens one assistant reply used (its `message_end` usage), for the device's daily count. */
function assistantTokens(event: AgentSessionEvent): number {
	if (event.type !== "message_end") return 0;
	const { message } = event;
	if (message.role !== "assistant" || !("usage" in message)) return 0;
	const usage: unknown = message.usage;
	if (typeof usage !== "object" || usage === null || !("totalTokens" in usage)) return 0;
	const total = usage.totalTokens;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

export class LocalHostServices implements HostServices {
	readonly #deps: HostServicesDeps;
	readonly #graceMs: number;
	readonly #tabs = new Map<string, HostTab>();
	/** Live connections that have talked to us; `sessions.changed` goes to each. */
	readonly #conns = new Set<HostConnection>();
	#sessionsTimer: NodeJS.Timeout | undefined;
	readonly #runningListeners = new Set<() => void>();
	#quota: PeerQuota | null = null;
	#resume: Pick<TurnResume, "sync" | "cancelWait"> | null = null;

	constructor(deps: HostServicesDeps) {
		this.#deps = deps;
		this.#graceMs = deps.graceMs ?? HOST_TAB_GRACE_MS;
	}

	/** Paired devices with a host tab running a turn here (connected or in their grace period). */
	runningPeers(): string[] {
		const peers = new Set<string>();
		for (const tab of this.#tabs.values()) if (runBusy(tab.run)) peers.add(tab.peerId);
		return [...peers];
	}

	/** Called whenever a host tab starts or stops running a turn; returns the unsubscribe. */
	onRunningChange(listener: () => void): () => void {
		this.#runningListeners.add(listener);
		return () => {
			this.#runningListeners.delete(listener);
		};
	}

	/** Per-device daily model limits (RemoteDevices owns the peer store they live in). */
	attachQuota(quota: PeerQuota): void {
		this.#quota = quota;
	}

	/**
	 * This computer's resume coordinator (turn-resume.ts), which takes the tabs here as its own:
	 * it keeps their markers, continues them after a crash or quit, and holds a network failure
	 * until this computer's connection is back. Its hosted-tab ids are {@link resumeId}s.
	 */
	attachResume(resume: Pick<TurnResume, "sync" | "cancelWait">): void {
		this.#resume = resume;
	}

	/** The resume rules' inputs for the tabs this computer runs for paired devices. */
	resumeFacts(): ResumeFact[] {
		return [...this.#tabs.values()].map(tab => {
			const fact: ResumeFact = {
				tabId: tab.resumeId,
				winId: 0,
				peer: tab.peerId,
				cwd: tab.sidecar.cwd,
				kind: tab.sidecar.kind,
				running: tab.run.running,
				stopped: tab.stopped === true,
				awaitingUi: tab.asks.size > 0,
				awaitingConnection: tab.awaitingConnection === true,
			};
			if (tab.sessionFile) fact.sessionFile = tab.sessionFile;
			if (tab.lastRun) fact.lastRun = tab.lastRun;
			if (tab.retry) fact.retry = tab.retry;
			return fact;
		});
	}

	/** Hold or release the tab's turn for this computer's connection; the device shows the wait. */
	setAwaitingConnection(id: string, awaiting: boolean): void {
		const tab = this.#byResumeId(id);
		if (!tab || (tab.awaitingConnection === true) === awaiting) return;
		tab.awaitingConnection = awaiting;
		this.#emit(tab, "awaitingConnection", awaiting);
	}

	/** Spawn a hosted tab's omp if it has not run yet (a revived tab); its sidecar, or null when it is gone. */
	startTab(id: string): SidecarLike | null {
		const tab = this.#byResumeId(id);
		if (!tab) return null;
		this.#start(tab);
		return tab.sidecar;
	}

	noteStopped(id: string): void {
		const tab = this.#byResumeId(id);
		if (!tab) return;
		tab.stopped = true;
		this.#resume?.sync();
	}

	/** The tab this computer runs for `peerId` on `sessionPath`, if any. */
	tabForSession(sessionPath: string, peerId: string): string | null {
		for (const tab of this.#tabs.values())
			if (tab.peerId === peerId && tab.sessionFile === sessionPath) return tab.resumeId;
		return null;
	}

	/**
	 * After a crash or quit: the tab a marker names, again, not yet started and waiting for its
	 * device like a dropped connection's (grace period). The device's `tab.open` re-attaches it.
	 * Null when the marker's id is not a tab of `peer`'s.
	 */
	reviveTab(peer: PeerInfo, marker: Pick<ResumeMarker, "tab" | "cwd" | "kind" | "sessionPath">): string | null {
		const prefix = resumeId(peer.deviceId, "");
		const rtab = marker.tab.startsWith(prefix) ? marker.tab.slice(prefix.length) : "";
		if (!Rtab.safeParse(rtab).success) return null;
		const existing = this.#tabs.get(this.#key(peer.deviceId, rtab));
		if (existing) return existing.resumeId;
		const tab = this.#createTab(peer, rtab, marker.cwd, marker.kind, false, marker.sessionPath, null);
		this.#startGrace(tab);
		return tab.resumeId;
	}

	async call(peer: PeerInfo, method: string, params: unknown, conn: HostConnection): Promise<unknown> {
		this.#conns.add(conn);
		switch (method) {
			case "tab.open":
				return this.#open(peer, parse(OpenParams, method, params), conn);
			case "tab.start":
				this.#start(this.#tab(peer, parse(RtabParams, method, params).rtab));
				return null;
			case "tab.restart": {
				const { rtab, cwd, sessionPath } = parse(RestartParams, method, params);
				const tab = this.#tab(peer, rtab);
				const target = cwd ? await directory(cwd) : undefined;
				tab.resumeSessionPath = undefined;
				tab.sidecar.restart(target, sessionPath);
				return null;
			}
			case "tab.adoptCwd": {
				const { rtab, cwd } = parse(AdoptCwdParams, method, params);
				return this.#tab(peer, rtab).sidecar.adoptCwd(cwd);
			}
			case "tab.close":
				this.#closeTab(this.#key(peer.deviceId, parse(RtabParams, method, params).rtab));
				return null;
			case "tab.command":
				return this.#command(peer, parse(CommandParams, method, params));
			case "tab.sideChannel": {
				const { rtab, frame } = parse(SideChannelParams, method, params);
				const tab = this.#tab(peer, rtab);
				tab.sidecar.sendSideChannel(frame);
				// The device answered an ask or approval: the turn no longer waits on a person.
				if (frame.type === "extension_ui_response" && typeof frame.id === "string" && tab.asks.delete(frame.id))
					this.#resume?.sync();
				return null;
			}
			case "tab.cancelWait":
				this.#resume?.cancelWait(this.#tab(peer, parse(RtabParams, method, params).rtab).resumeId);
				return null;
			case "tab.syncImageGeneration":
				this.#tab(peer, parse(RtabParams, method, params).rtab).sidecar.syncImageGeneration();
				return null;
			case "sessions.list": {
				const { scope, cwd } = parse(SessionsListParams, method, params);
				return this.#deps.sessionIndex.list(scope, cwd);
			}
			case "sessions.search": {
				const { query, scope, cwd } = parse(SessionsSearchParams, method, params);
				const candidates = await this.#deps.sessionIndex.list(scope, cwd);
				return this.#deps.sessionIndex.searchContent(
					query,
					candidates.map(info => info.path),
				);
			}
			case "sessions.kindFor":
				return this.#deps.sessionIndex.kindFor(parse(SessionPathParams, method, params).sessionPath);
			case "sessions.delete":
				return this.#deleteSession(parse(SessionPathParams, method, params).sessionPath);
			case "sessions.rename": {
				const { sessionPath, name } = parse(RenameParams, method, params);
				return this.#renameSession(sessionPath, name);
			}
			case "sessions.move": {
				const { sessionPath, cwd } = parse(MoveParams, method, params);
				if (this.#liveOwner(sessionPath)) throw codedError("session_open_in_tab", "Session is open on the host");
				return moveSession(this.#deps.localTabs, sessionPath, undefined, () =>
					this.#deps.sessionIndex.moveSession(sessionPath, cwd),
				);
			}
			// C114: the tab's terminals run here, in the tab's folder, with this machine's shells.
			case "terminal.shells":
				return detectShells();
			case "terminal.request": {
				const { rtab, operation } = parse(TerminalParams, method, params);
				const tab = this.#tab(peer, rtab);
				return terminalRequest(terminalOwner(peer.deviceId, rtab), tab.sidecar.cwd, operation as TerminalOperation);
			}
			case "fs.list": {
				const { rtab, cwd, ...payload } = parse(FsListParams, method, params);
				return listWorkspace(this.#fsRoot(peer, rtab, cwd), payload);
			}
			case "fs.read": {
				const { rtab, cwd, ...payload } = parse(FsReadParams, method, params);
				return readWorkspaceFile(this.#fsRoot(peer, rtab, cwd), payload);
			}
			case "fs.stat": {
				const { rtab, cwd, path } = parse(FsReadImageParams, method, params);
				return statWorkspacePath(this.#fsRoot(peer, rtab, cwd), path);
			}
			case "fs.mutate": {
				const { rtab, cwd, mutation } = parse(FsMutateParams, method, params);
				return mutateWorkspace(this.#fsRoot(peer, rtab, cwd), mutation, this.#deps.trashItem);
			}
			case "fs.search": {
				const { rtab, cwd, request } = parse(FsSearchParams, method, params);
				return searchWorkspace(this.#fsRoot(peer, rtab, cwd), request, stockHelperRequest);
			}
			case "fs.readImage": {
				const { rtab, cwd, ...payload } = parse(FsReadImageParams, method, params);
				return readWorkspaceImage(this.#fsRoot(peer, rtab, cwd), payload);
			}
			case "host.fs.readBinary": {
				const { rtab, cwd, ...payload } = parse(FsReadParams, method, params);
				const result = await readWorkspaceBinary(
					this.#fsRoot(peer, rtab, cwd),
					payload,
					FS_BINARY_REMOTE_MAX_BYTES,
				);
				return encodeBinaryRead(result);
			}
			case "fs.readPlan": {
				const { rtab, cwd, ...payload } = parse(FsReadPlanParams, method, params);
				return readPlanFile(this.#fsRoot(peer, rtab, cwd), this.#deps.sessionIndex.sessionsDir, payload);
			}
			case "fs.listDirs": {
				const listing = parse(ListDirsParams, method, params);
				return listDirectories(listing.path, listing.query);
			}
			case "workspace.default":
				return this.#deps.defaultWorkspace();
			case "launchProfile.get":
				return readLaunchProfile(this.#deps.launchProfiles, parse(LaunchProfileGetParams, method, params).cwd);
			case "launchProfile.update": {
				const { cwd, patch } = parse(LaunchProfileUpdateParams, method, params);
				return updateLaunchProfile(this.#deps.launchProfiles, cwd, patch);
			}
			case "host.models.list":
				return this.#deps.machine.listProviders();
			case "host.models.upsert":
				await this.#deps.machine.upsertProvider(parse(ModelsUpsertParams, method, params).input);
				return null;
			case "host.models.delete":
				await this.#deps.machine.deleteProvider(parse(ModelsDeleteParams, method, params).id);
				return null;
			case "host.models.override": {
				const { provider, modelId, override } = parse(ModelsOverrideParams, method, params);
				await this.#deps.machine.setModelOverride(provider, modelId, override);
				return null;
			}
			case "host.stats.fetch": {
				const { path, params: query } = parse(StatsFetchParams, method, params);
				return this.#deps.machine.fetchStats(path, query);
			}
			case "host.bench.run": {
				const { rtab, cwd, options } = parse(BenchRunParams, method, params);
				const root = this.#fsRoot(peer, rtab, cwd) ?? this.#deps.defaultWorkspace();
				// Every model runs `runs` times: that many requests on this computer's credentials.
				return this.#metered(
					peer.deviceId,
					Math.max(1, options.models.length * options.runs),
					() => this.#deps.machine.runBenchmark(benchCaller(peer.deviceId), options, root),
					result => result.success,
				);
			}
			case "host.bench.abort":
				return this.#deps.machine.abortBenchmark(benchCaller(peer.deviceId));
			case "host.modelSetup.run": {
				const { request } = parse(ModelSetupRunParams, method, params);
				return this.#metered(
					peer.deviceId,
					1,
					() => this.#deps.machine.runModelSetup(benchCaller(peer.deviceId), request),
					result => result.success,
				);
			}
			case "host.modelSetup.status":
				return this.#deps.machine.modelSetupStatus(benchCaller(peer.deviceId));
			case "host.modelSetup.abort":
				return this.#deps.machine.abortModelSetup(benchCaller(peer.deviceId));
			case "host.accountRotation.get":
				return this.#deps.machine.accountRotation();
			case "host.accountRotation.set":
				return this.#deps.machine.setAccountRotation(parse(AccountRotationSetParams, method, params).mode);
			case "host.builtinRea.get":
				return this.#deps.machine.builtinRea();
			case "host.builtinRea.set":
				return this.#deps.machine.setBuiltinRea(parse(BuiltinReaSetParams, method, params).enabled);
			case "host.desktop.get":
				return this.#deps.machine.desktop();
			case "host.desktop.update":
				return this.#deps.machine.desktopUpdate(parse(DesktopUpdateParams, method, params).action);
			case "host.ompUpdate.get":
				return this.#deps.machine.ompUpdate();
			case "host.ompUpdate.now":
				return this.#deps.machine.startOmpUpdate();
			default:
				throw codedError("unsupported", `Unknown method ${method}`);
		}
	}

	disconnected(peer: PeerInfo, conn: HostConnection): void {
		this.#conns.delete(conn);
		// Nobody is left to read the result.
		void this.#deps.machine.abortBenchmark(benchCaller(peer.deviceId));
		void this.#deps.machine.abortModelSetup(benchCaller(peer.deviceId));
		for (const tab of this.#tabs.values())
			if (tab.peerId === peer.deviceId && tab.conn === conn) this.#startGrace(tab);
	}

	/** This machine's session index changed: tell every connected device (debounced). */
	sessionsChanged(): void {
		if (this.#sessionsTimer) return;
		this.#sessionsTimer = setTimeout(() => {
			this.#sessionsTimer = undefined;
			for (const conn of this.#conns) emitSafely(conn, SESSIONS_CHANGED_EVENT, null);
		}, SESSIONS_CHANGED_DEBOUNCE_MS);
		this.#sessionsTimer.unref?.();
	}

	/** This machine's own OmpUpdater changed state: every connected device shows it like the computer's own row. */
	ompUpdateChanged(state: OmpUpdateState): void {
		for (const conn of this.#conns) emitSafely(conn, OMP_UPDATE_EVENT, state);
	}

	/** This machine's reply-language setting changed: the tabs it runs for paired devices follow it. */
	syncReplyLanguage(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncReplyLanguage();
	}

	/** This machine's profile setting changed: the tabs it runs for paired devices follow it. */
	syncUserProfile(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncUserProfile();
	}

	/** This machine's account-rotation setting changed: the tabs it runs for paired devices follow it. */
	syncAccountRotation(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncAccountRotation();
	}

	/** A revoked device's tabs, benchmark and research stop now, grace or not. */
	dropPeer(deviceId: string): void {
		void this.#deps.machine.abortBenchmark(benchCaller(deviceId));
		void this.#deps.machine.abortModelSetup(benchCaller(deviceId));
		for (const [key, tab] of this.#tabs) if (tab.peerId === deviceId) this.#closeTab(key);
	}

	disposeAll(): void {
		for (const key of [...this.#tabs.keys()]) this.#closeTab(key);
		clearTimeout(this.#sessionsTimer);
		this.#sessionsTimer = undefined;
		this.#conns.clear();
	}

	#key(peerId: string, rtab: string): string {
		return `${peerId}\u0000${rtab}`;
	}

	#tab(peer: PeerInfo, rtab: string): HostTab {
		const tab = this.#tabs.get(this.#key(peer.deviceId, rtab));
		if (!tab) throw codedError("unknown_tab", "Unknown tab");
		return tab;
	}

	#byResumeId(id: string): HostTab | undefined {
		for (const tab of this.#tabs.values()) if (tab.resumeId === id) return tab;
		return undefined;
	}

	/** Spawn the tab's omp unless it already runs: on the session it was opened or revived with, else a new one. */
	#start(tab: HostTab): void {
		if (tab.sidecar.status !== "asleep") return;
		const resume = tab.resumeSessionPath;
		tab.resumeSessionPath = undefined;
		if (resume) tab.sidecar.restart(undefined, resume);
		else tab.sidecar.start();
	}

	/**
	 * The device is away: a grace period that runs out on an idle tab closes it. One that runs out during a
	 * turn (a revived one, continued after this computer's crash or quit, included) or a hold for this
	 * computer's connection starts another, so neither loses its work or its resume marker to the timer.
	 */
	#startGrace(tab: HostTab): void {
		tab.conn = null;
		clearTimeout(tab.graceTimer);
		tab.graceTimer = setTimeout(() => {
			if (runBusy(tab.run) || tab.awaitingConnection) this.#startGrace(tab);
			else this.#closeTab(this.#key(tab.peerId, tab.rtab));
		}, this.#graceMs);
		tab.graceTimer.unref?.();
	}

	async #open(peer: PeerInfo, params: z.infer<typeof OpenParams>, conn: HostConnection): Promise<TabOpenResult> {
		const key = this.#key(peer.deviceId, params.rtab);
		const existing = this.#tabs.get(key) ?? this.#adopt(peer, params, conn);
		if (existing) {
			clearTimeout(existing.graceTimer);
			existing.graceTimer = undefined;
			existing.conn = conn;
			// Re-attach: the device missed every event while it was away, so it
			// gets the live status first. A never-started tab is not attached:
			// the device still has to `tab.start` it.
			const attached = existing.sidecar.status !== "asleep";
			if (attached)
				this.#emit(existing, "status", this.#statusArg(existing.sidecar, existing.sidecar.statusPayload));
			// Which sign-ins still run decides whether a re-sent code paste is the login panel's or a leftover,
			// so it goes first.
			this.#emit(existing, "signIn", { active: [...(existing.signIns ?? [])] } satisfies TabSignInArg);
			// The asks the device still shows may be gone (the omp restarted or withdrew them meanwhile),
			// and the omp may have raised others: the whole open list replaces the device's.
			this.#emit(existing, "openAsks", [...existing.asks.values()]);
			// The device's waiting row may date from before it lost this computer.
			this.#emit(existing, "awaitingConnection", existing.awaitingConnection === true);
			return { cwd: existing.sidecar.cwd, kind: existing.sidecar.kind, attached };
		}
		if (!params.cwd) throw codedError("no_workspace", "No workspace");
		const cwd = await directory(params.cwd);
		const kind =
			params.kind ?? (params.sessionPath ? await this.#deps.sessionIndex.kindFor(params.sessionPath) : "agent");
		// A concurrent open for the same rtab may have finished while this one awaited.
		const raced = this.#tabs.get(key);
		if (raced) return this.#open(peer, params, conn);
		const tab = this.#createTab(peer, params.rtab, cwd, kind, params.fresh === true, params.sessionPath, conn);
		// The device's sign-in state may come from a tab of this rtab that is gone (closed after its grace, or
		// this computer restarted mid-login): a new omp runs none.
		this.#emit(tab, "signIn", { active: [] } satisfies TabSignInArg);
		this.#emit(tab, "awaitingConnection", false);
		return { cwd: tab.sidecar.cwd, kind, attached: false };
	}

	/**
	 * A relaunched device reopens its tabs under new rtabs, each with the session it showed. The
	 * tab an earlier connection of that device left on the session (running out its grace period,
	 * or revived after this computer restarted) is that tab: it is taken over under the new rtab,
	 * so no second omp starts on the same session file.
	 */
	#adopt(peer: PeerInfo, params: z.infer<typeof OpenParams>, conn: HostConnection): HostTab | undefined {
		if (!params.sessionPath) return undefined;
		for (const [key, tab] of this.#tabs) {
			if (tab.peerId !== peer.deviceId || tab.conn === conn || tab.sessionFile !== params.sessionPath) continue;
			this.#tabs.delete(key);
			// Terminals are owned by rtab; the device lost the old one with its previous launch.
			disposeTerminals(terminalOwner(tab.peerId, tab.rtab));
			tab.rtab = params.rtab;
			this.#tabs.set(this.#key(peer.deviceId, params.rtab), tab);
			return tab;
		}
		return undefined;
	}

	#createTab(
		peer: PeerInfo,
		rtab: string,
		cwd: string,
		kind: "agent" | "chat",
		fresh: boolean,
		sessionPath: string | undefined,
		conn: HostConnection | null,
	): HostTab {
		const sidecar = this.#deps.createSidecar(cwd, kind, fresh, {
			deviceId: peer.deviceId,
			name: peer.name,
			hostName: this.#deps.hostName(),
		});
		const tab: HostTab = {
			peerId: peer.deviceId,
			rtab,
			resumeId: resumeId(peer.deviceId, rtab),
			sidecar,
			conn,
			resumeSessionPath: sessionPath,
			sessionFile: sessionPath,
			graceTimer: undefined,
			run: idleRun(),
			asks: new Map(),
		};
		this.#tabs.set(this.#key(peer.deviceId, rtab), tab);
		// The resume rules first: a failure they turn into a connection wait reaches the device
		// already waiting, so it never shows there as a failure first.
		this.#trackRun(tab);
		this.#wire(tab);
		return tab;
	}

	#wire(tab: HostTab): void {
		const { sidecar } = tab;
		for (const name of TAB_EVENT_NAMES) {
			switch (name) {
				case "status":
					sidecar.on(name, (payload: SidecarStatusPayload) =>
						this.#emit(tab, name, this.#statusArg(sidecar, payload)),
					);
					break;
				case "session":
					sidecar.on(name, (identity: SidecarSessionIdentity) => {
						const changed = tab.sessionFile !== identity.sessionFile;
						tab.sessionFile = identity.sessionFile;
						if (changed && tab.run.running) this.#resume?.sync();
						this.#emit(tab, name, identity);
					});
					break;
				case "bridge":
					sidecar.on(name, (result: BridgeConnectResult) => {
						void serializeBridge(result).then(arg => this.#emit(tab, name, arg));
					});
					break;
				case "awaitingConnection":
				case "openAsks":
					// Not the sidecar's: this computer's resume coordinator sets the wait, and `tab.open` sends the asks.
					break;
				default:
					sidecar.on(name, (arg: unknown) => this.#emit(tab, name, arg));
			}
		}
	}

	/**
	 * Keep `tab.run` and the resume facts current from the sidecar's own events: a busy flip
	 * notifies the listeners, and every change the resume rules read reaches the coordinator.
	 */
	#trackRun(tab: HostTab): void {
		const { sidecar } = tab;
		/** `apply` says whether it changed a resume fact beyond busy (a run's end, a retry, an ask). */
		const change = (apply: () => boolean): void => {
			const was = runBusy(tab.run);
			const news = apply();
			const busyChanged = runBusy(tab.run) !== was;
			if (busyChanged) {
				this.#runningChanged();
				this.#scheduleOmpRestart(tab);
			}
			if (busyChanged || news) this.#resume?.sync();
		};
		// "Running" only means something on a live connection: a restart or crash ends the run,
		// and the asks it had open: the next process never heard of them.
		sidecar.on("status", (payload: SidecarStatusPayload) => {
			if (payload.status !== "ready")
				change(() => {
					tab.run = idleRun();
					const asked = tab.asks.size > 0;
					tab.asks.clear();
					return asked;
				});
		});
		sidecar.on("promptResult", (frame: PromptResultFrame) => {
			const settled = frame.sessionSettled;
			if (typeof settled === "boolean")
				change(() => {
					settleRun(tab.run, settled);
					return false;
				});
		});
		sidecar.on("sessionSettled", () =>
			change(() => {
				settleRun(tab.run, true);
				return false;
			}),
		);
		sidecar.on("events", (events: AgentSessionEvent[]) => {
			change(() => {
				// A fast turn can start and end inside one batch: busy never changes, yet its outcome is news.
				let news = false;
				for (const event of events) if (trackRunEvent(tab, event) || event.type === "auto_retry_start") news = true;
				return news;
			});
			let tokens = 0;
			for (const event of events) tokens += assistantTokens(event);
			if (tokens > 0) this.#quota?.record(tab.peerId, { tokens });
		});
		sidecar.on("extensionUi", (request: ExtensionUIRequest) => {
			const asks = BLOCKING_UI_METHODS[request.method] === true;
			if (asks) tab.asks.set(request.id, request);
			// omp withdrew the request (timeout, abort): no answer will follow.
			if (asks || (request.method === "cancel" && tab.asks.delete(request.targetId))) this.#resume?.sync();
		});
	}

	#runningChanged(): void {
		for (const listener of this.#runningListeners) listener();
	}

	/**
	 * omp on this computer was updated: tabs it hosts for paired devices move to it like the
	 * computer's own (omp-restart.ts). The device's composer draft lives on the device.
	 */
	restartOnNewOmp(): void {
		for (const tab of this.#tabs.values()) {
			const decision = ompRestartDecision({ status: tab.sidecar.status, busy: runBusy(tab.run) });
			if (decision === "skip") continue;
			if (decision === "wait") tab.ompRestartPending = true;
			else tab.sidecar.restart(undefined, tab.sessionFile);
		}
	}

	/** A hosted turn ended on a tab that waits for the new omp (a tick later: see SidecarPool). */
	#scheduleOmpRestart(tab: HostTab): void {
		if (!tab.ompRestartPending || runBusy(tab.run)) return;
		setImmediate(() => {
			if (!tab.ompRestartPending || runBusy(tab.run) || tab.sidecar.status !== "ready") return;
			if (![...this.#tabs.values()].includes(tab)) return;
			tab.ompRestartPending = false;
			tab.sidecar.restart(undefined, tab.sessionFile);
		});
	}

	#statusArg(sidecar: SidecarLike, payload: SidecarStatusPayload): TabStatusArg {
		const { status, cwd: _cwd, ...detail } = payload;
		return {
			status,
			statusPayload: detail,
			processAlive: sidecar.processAlive,
			cwd: sidecar.cwd,
			kind: sidecar.kind,
		};
	}

	#emit(tab: HostTab, name: TabEventName, arg: unknown): void {
		const message: TabEventMessage = { rtab: tab.rtab, name, arg };
		if (tab.conn) emitSafely(tab.conn, TAB_EVENT, message);
	}

	async #command(peer: PeerInfo, params: z.infer<typeof CommandParams>): Promise<RpcResponse> {
		const tab = this.#tab(peer, params.rtab);
		const client = tab.sidecar.rpcClient;
		if (!client) throw codedError("sidecar_not_connected", "Sidecar not connected");
		// The client device forwards its renderer's RpcCommand verbatim; omp and
		// the local handlers validate the command itself.
		const command = params.command as unknown as RpcCommand;
		// The user's Stop: nothing continues this turn after a crash (ipc.ts does the same for a local tab).
		if (STOP_COMMANDS[command.type]) this.noteStopped(tab.resumeId);
		// A provider sign-in runs here whether or not the device keeps its link: the device is told what is
		// in flight (`signIn`), so its re-sent code paste is the login panel's while it runs.
		const login = command.type === "login" ? command.providerId : null;
		if (login !== null) this.#noteSignIn(tab, login);
		let signInError: string | null = null;
		try {
			const response = commandUsesModel(command)
				? await this.#metered(
						peer.deviceId,
						1,
						() => client.command(command, params.timeoutMs),
						result => result.success,
					)
				: await client.command(command, params.timeoutMs);
			if (!response.success) signInError = response.error ?? "";
			// A login or logout rewrote this machine's credential store: every tab
			// running here re-reads it — this machine's own and every device's.
			if (response.success && (command.type === "login" || command.type === "logout")) {
				for (const other of this.#tabs.values()) other.sidecar.syncImageGeneration();
				for (const local of this.#deps.localTabs.allSidecars()) if (!local.device) local.syncImageGeneration();
			}
			return response;
		} catch (error) {
			signInError = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			if (login !== null) this.#noteSignIn(tab, login, signInError);
		}
	}

	/** A `login` started (`ended` undefined) or answered on the tab: the device learns what still runs. */
	#noteSignIn(tab: HostTab, providerId: string, ended?: string | null): void {
		const signIns = tab.signIns ?? [];
		if (ended === undefined) signIns.push(providerId);
		else {
			const at = signIns.indexOf(providerId);
			if (at >= 0) signIns.splice(at, 1);
		}
		tab.signIns = signIns;
		this.#emit(tab, "signIn", {
			active: signIns,
			...(ended === undefined ? {} : { ended: { providerId, error: ended } }),
		} satisfies TabSignInArg);
	}

	/**
	 * Run work that spends `requests` of the device's daily model requests. The request is
	 * reserved before the first await and given back when the work throws or reports failure,
	 * so parallel callers at limit - 1 cannot all pass the check.
	 */
	async #metered<T>(
		deviceId: string,
		requests: number,
		work: () => Promise<T>,
		succeeded: (result: T) => boolean,
	): Promise<T> {
		const reservation = this.#quota?.reserve(deviceId, requests);
		if (reservation && !reservation.ok) {
			throw codedError(
				"remote_limit_reached",
				reservation.refusal === "requests" && requests > 1
					? `This needs ${requests} of this device's daily requests on this computer's models, more than are left today.`
					: `This device's ${reservation.refusal === "requests" ? "request" : "token"} limit for today on this computer's models is used up.`,
			);
		}
		try {
			const result = await work();
			if (!succeeded(result)) reservation?.refund();
			return result;
		} catch (error) {
			reservation?.refund();
			throw error;
		}
	}

	/** The host tab holding `sessionPath` with a process that has it in memory. */
	#liveOwner(sessionPath: string): HostTab | undefined {
		for (const tab of this.#tabs.values()) {
			if (tab.sessionFile === sessionPath && tab.sidecar.processAlive) return tab;
		}
		return undefined;
	}

	/** This machine's sidebar policy (session-mutations.ts); a device tab holding the session refuses. */
	async #deleteSession(sessionPath: string): Promise<null> {
		if (this.#liveOwner(sessionPath)) throw codedError("session_running", "Session is open on the host");
		await deleteSession(this.#deps.localTabs, sessionPath, undefined, () =>
			this.#deps.sessionIndex.deleteSession(sessionPath),
		);
		return null;
	}

	/** This machine's sidebar policy, with a device tab holding the session as the first live owner. */
	async #renameSession(sessionPath: string, name: string): Promise<null> {
		await renameSession(this.#deps.localTabs, sessionPath, name, {
			renameStored: name => this.#deps.renameStoredSession(sessionPath, name),
			otherOwner: () => {
				const owner = this.#liveOwner(sessionPath);
				if (!owner) return undefined;
				return owner.sidecar.status === "ready" ? owner.sidecar.rpcClient : null;
			},
		});
		return null;
	}

	#fsRoot(peer: PeerInfo, rtab: string | undefined, cwd: string | undefined): string | null {
		const tab = rtab ? this.#tabs.get(this.#key(peer.deviceId, rtab)) : undefined;
		return tab?.sidecar.cwd ?? cwd ?? null;
	}

	#closeTab(key: string): void {
		const tab = this.#tabs.get(key);
		if (!tab) return;
		this.#tabs.delete(key);
		clearTimeout(tab.graceTimer);
		tab.conn = null;
		tab.sidecar.removeAllListeners();
		tab.sidecar.dispose();
		disposeTerminals(terminalOwner(tab.peerId, tab.rtab));
		if (runBusy(tab.run)) this.#runningChanged();
		this.#resume?.sync();
	}
}

/** Terminal owner of a paired device's tab here; local windows use `<webContentsId>:<tabId>`. */
function terminalOwner(deviceId: string, rtab: string): string {
	return `peer:${deviceId}:${rtab}`;
}

/** A hosted tab's id for this computer's resume coordinator, beside the local tabs' ids (its first rtab). */
function resumeId(deviceId: string, rtab: string): string {
	return `peer:${deviceId}:${rtab}`;
}

/** The benchmark and research slot of a paired device on this machine (windows here use `window:<id>`). */
function benchCaller(deviceId: string): string {
	return `peer:${deviceId}`;
}

/**
 * Push one event. The emit runs inside the sidecar's own listener chain, so
 * an event over the frame cap must not throw into it: drop it and say so.
 */
function emitSafely(conn: HostConnection, event: string, data: unknown): void {
	try {
		conn.emit(event, data);
	} catch (error) {
		console.warn(`[remote-host] dropped ${event}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The bridge result without the live client: the capabilities probe runs here. */
async function serializeBridge(result: BridgeConnectResult): Promise<TabBridgeArg> {
	if (!result.connected) return result;
	try {
		const capabilities = await result.bridge.request<{ unavailable?: unknown }>("capabilities");
		return { connected: true, ompVersion: result.ompVersion, unavailable: capabilities?.unavailable };
	} catch {
		return { connected: true, ompVersion: result.ompVersion };
	}
}
