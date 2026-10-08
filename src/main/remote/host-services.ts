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
 * the local pool's "running"), so the host can keep this computer awake.
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
import { ACCOUNT_ROTATION_MODES } from "../../shared/account-rotation";
import { codedError } from "../../shared/ipc-error-codes";
import { ModelSetupRequestSchema } from "../../shared/model-setup";
import { MAX_RPC_COMMAND_TIMEOUT_MS } from "../../shared/rpc-client";
import type {
	AgentSessionEvent,
	PromptResultFrame,
	RpcCommand,
	RpcResponse,
	SidecarStatusPayload,
} from "../../shared/rpc-types";
import type { BridgeConnectResult } from "../bridge-health";
import { canonicalCwd } from "../canonical-cwd";
import { type LaunchProfilePrefs, readLaunchProfile, updateLaunchProfile } from "../launch-profile-store";
import type { MachineServices } from "../machine-services";
import type { SessionIndex } from "../session-index";
import type { SidecarSessionIdentity } from "../sidecar";
import type { SidecarLike, SidecarPool } from "../sidecar-pool";
import {
	FS_BINARY_REMOTE_MAX_BYTES,
	listDirectories,
	listWorkspace,
	readPlanFile,
	readWorkspaceBinary,
	readWorkspaceFile,
	readWorkspaceImage,
} from "../workspace-fs";
import {
	BenchmarkOptionsSchema,
	CustomProviderInputSchema,
	encodeBinaryRead,
	SESSIONS_CHANGED_EVENT,
	TAB_EVENT,
	TAB_EVENT_NAMES,
	type TabBridgeArg,
	type TabEventMessage,
	type TabEventName,
	type TabOpenResult,
	type TabStatusArg,
} from "./app-protocol";
import type { HostConnection, HostServices } from "./host-server";
import type { PeerInfo } from "./peers-store";

/** How long a disconnected device's tabs keep running, waiting for it to come back. */
export const HOST_TAB_GRACE_MS = 10 * 60_000;
/** Session-index changes come in bursts while an agent writes; one push per burst. */
const SESSIONS_CHANGED_DEBOUNCE_MS = 300;

export interface HostServicesDeps {
	/** This machine's sidecar factory — the one the local pool uses. */
	createSidecar: (cwd: string, kind: "agent" | "chat", fresh: boolean) => SidecarLike;
	sessionIndex: Pick<SessionIndex, "list" | "searchContent" | "kindFor" | "deleteSession" | "sessionsDir">;
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
	graceMs?: number;
}

interface HostTab {
	peerId: string;
	rtab: string;
	sidecar: SidecarLike;
	/** The connection events go to; null while the device is away (grace period). */
	conn: HostConnection | null;
	/** Resumed by the first `tab.start`. */
	resumeSessionPath: string | undefined;
	/** Session file the sidecar last reported (live-owner checks for delete/rename). */
	sessionFile: string | undefined;
	graceTimer: NodeJS.Timeout | undefined;
	run: HostTabRun;
}

/** A host tab's turn state, read from its sidecar's events like the local pool's `running`. */
interface HostTabRun {
	/** agent_start seen, its run not yet over. */
	running: boolean;
	/** The prompt yielded while background work can still wake the session. */
	awaitingSettled: boolean;
	/** Inside an auto-retry saga: its coalesced agent_end is not the end of the run. */
	retrying: boolean;
	endedWhileRetrying: boolean;
	compacting: boolean;
}

const IDLE_RUN: Readonly<HostTabRun> = {
	running: false,
	awaitingSettled: false,
	retrying: false,
	endedWhileRetrying: false,
	compacting: false,
};

function runEvent(run: HostTabRun, event: AgentSessionEvent): void {
	switch (event.type) {
		case "agent_start":
			run.running = true;
			break;
		case "agent_end":
			if (run.retrying) run.endedWhileRetrying = true;
			else if (!run.awaitingSettled) run.running = false;
			break;
		case "auto_retry_start":
			run.retrying = true;
			break;
		case "auto_retry_end":
			run.retrying = false;
			if (!event.success && run.endedWhileRetrying && !run.awaitingSettled) run.running = false;
			run.endedWhileRetrying = false;
			break;
		case "auto_compaction_start":
			run.compacting = true;
			break;
		case "auto_compaction_end":
			run.compacting = false;
			break;
	}
}

const Rtab = z.string().min(1).max(128);
const AbsolutePath = z.string().min(1).refine(isAbsolute, "absolute path required");
const SessionPath = z.string().endsWith(".jsonl");
const Scope = z.enum(["local", "global"]);

const RtabParams = z.object({ rtab: Rtab });
const OpenParams = z.object({
	rtab: Rtab,
	cwd: AbsolutePath.optional(),
	defaultWorkspace: z.boolean().optional(),
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
const FsReadPlanParams = z.object({ ...FsRoot, fsPath: z.string(), localRoot: z.string().nullable() });
const ListDirsParams = z.object({ path: z.string().optional() });
const LaunchProfileGetParams = z.object({ cwd: AbsolutePath });
const LaunchProfileUpdateParams = z.object({ cwd: AbsolutePath, patch: z.record(z.unknown()) });
const ModelsUpsertParams = z.object({ input: CustomProviderInputSchema });
const ModelsDeleteParams = z.object({ id: z.string().min(1) });
const StatsFetchParams = z.object({ path: z.string().min(1).max(512), params: z.record(z.string()).optional() });
const BenchRunParams = z.object({ ...FsRoot, options: BenchmarkOptionsSchema });
const ModelSetupRunParams = z.object({ request: ModelSetupRequestSchema });
const AccountRotationSetParams = z.object({ mode: z.enum(ACCOUNT_ROTATION_MODES) });

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

export class LocalHostServices implements HostServices {
	readonly #deps: HostServicesDeps;
	readonly #graceMs: number;
	readonly #tabs = new Map<string, HostTab>();
	/** Live connections that have talked to us; `sessions.changed` goes to each. */
	readonly #conns = new Set<HostConnection>();
	#sessionsTimer: NodeJS.Timeout | undefined;
	readonly #runningListeners = new Set<() => void>();

	constructor(deps: HostServicesDeps) {
		this.#deps = deps;
		this.#graceMs = deps.graceMs ?? HOST_TAB_GRACE_MS;
	}

	/** Paired devices with a host tab running a turn here (connected or in their grace period). */
	runningPeers(): string[] {
		const peers = new Set<string>();
		for (const tab of this.#tabs.values()) if (isBusy(tab.run)) peers.add(tab.peerId);
		return [...peers];
	}

	/** Called whenever a host tab starts or stops running a turn; returns the unsubscribe. */
	onRunningChange(listener: () => void): () => void {
		this.#runningListeners.add(listener);
		return () => {
			this.#runningListeners.delete(listener);
		};
	}

	async call(peer: PeerInfo, method: string, params: unknown, conn: HostConnection): Promise<unknown> {
		this.#conns.add(conn);
		switch (method) {
			case "tab.open":
				return this.#open(peer, parse(OpenParams, method, params), conn);
			case "tab.start": {
				const tab = this.#tab(peer, parse(RtabParams, method, params).rtab);
				if (tab.sidecar.status !== "asleep") return null;
				const resume = tab.resumeSessionPath;
				tab.resumeSessionPath = undefined;
				if (resume) tab.sidecar.restart(undefined, resume);
				else tab.sidecar.start();
				return null;
			}
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
				this.#tab(peer, rtab).sidecar.sendSideChannel(frame);
				return null;
			}
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
			case "fs.list": {
				const { rtab, cwd, ...payload } = parse(FsListParams, method, params);
				return listWorkspace(this.#fsRoot(peer, rtab, cwd), payload);
			}
			case "fs.read": {
				const { rtab, cwd, ...payload } = parse(FsReadParams, method, params);
				return readWorkspaceFile(this.#fsRoot(peer, rtab, cwd), payload);
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
			case "fs.listDirs":
				return listDirectories(parse(ListDirsParams, method, params).path);
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
			case "host.stats.fetch": {
				const { path, params: query } = parse(StatsFetchParams, method, params);
				return this.#deps.machine.fetchStats(path, query);
			}
			case "host.bench.run": {
				const { rtab, cwd, options } = parse(BenchRunParams, method, params);
				const root = this.#fsRoot(peer, rtab, cwd) ?? this.#deps.defaultWorkspace();
				return this.#deps.machine.runBenchmark(benchCaller(peer.deviceId), options, root);
			}
			case "host.bench.abort":
				return this.#deps.machine.abortBenchmark(benchCaller(peer.deviceId));
			case "host.modelSetup.run":
				return this.#deps.machine.runModelSetup(
					benchCaller(peer.deviceId),
					parse(ModelSetupRunParams, method, params).request,
				);
			case "host.modelSetup.status":
				return this.#deps.machine.modelSetupStatus(benchCaller(peer.deviceId));
			case "host.modelSetup.abort":
				return this.#deps.machine.abortModelSetup(benchCaller(peer.deviceId));
			case "host.accountRotation.get":
				return this.#deps.machine.accountRotation();
			case "host.accountRotation.set":
				return this.#deps.machine.setAccountRotation(parse(AccountRotationSetParams, method, params).mode);
			default:
				throw codedError("unsupported", `Unknown method ${method}`);
		}
	}

	disconnected(peer: PeerInfo, conn: HostConnection): void {
		this.#conns.delete(conn);
		// Nobody is left to read the result.
		void this.#deps.machine.abortBenchmark(benchCaller(peer.deviceId));
		void this.#deps.machine.abortModelSetup(benchCaller(peer.deviceId));
		for (const [key, tab] of this.#tabs) {
			if (tab.peerId !== peer.deviceId || tab.conn !== conn) continue;
			tab.conn = null;
			tab.graceTimer = setTimeout(() => this.#closeTab(key), this.#graceMs);
			tab.graceTimer.unref?.();
		}
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

	/** This machine's reply-language setting changed: the tabs it runs for paired devices follow it. */
	syncReplyLanguage(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncReplyLanguage();
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

	async #open(peer: PeerInfo, params: z.infer<typeof OpenParams>, conn: HostConnection): Promise<TabOpenResult> {
		const key = this.#key(peer.deviceId, params.rtab);
		const existing = this.#tabs.get(key);
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
			return { cwd: existing.sidecar.cwd, kind: existing.sidecar.kind, attached };
		}
		let cwd: string;
		if (params.defaultWorkspace) cwd = canonicalCwd(this.#deps.defaultWorkspace());
		else if (params.cwd) cwd = await directory(params.cwd);
		else throw codedError("no_workspace", "No workspace");
		const kind =
			params.defaultWorkspace === true
				? "agent"
				: (params.kind ??
					(params.sessionPath ? await this.#deps.sessionIndex.kindFor(params.sessionPath) : "agent"));
		// A concurrent open for the same rtab may have finished while this one awaited.
		const raced = this.#tabs.get(key);
		if (raced) return this.#open(peer, params, conn);
		const sidecar = this.#deps.createSidecar(cwd, kind, params.fresh === true);
		const tab: HostTab = {
			peerId: peer.deviceId,
			rtab: params.rtab,
			sidecar,
			conn,
			resumeSessionPath: params.sessionPath,
			sessionFile: params.sessionPath,
			graceTimer: undefined,
			run: { ...IDLE_RUN },
		};
		this.#tabs.set(key, tab);
		this.#wire(tab);
		this.#trackRun(tab);
		return { cwd: sidecar.cwd, kind, attached: false };
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
						tab.sessionFile = identity.sessionFile;
						this.#emit(tab, name, identity);
					});
					break;
				case "bridge":
					sidecar.on(name, (result: BridgeConnectResult) => {
						void serializeBridge(result).then(arg => this.#emit(tab, name, arg));
					});
					break;
				default:
					sidecar.on(name, (arg: unknown) => this.#emit(tab, name, arg));
			}
		}
	}

	/** Keep `tab.run` current from the sidecar's own events; a busy flip notifies the listeners. */
	#trackRun(tab: HostTab): void {
		const { sidecar } = tab;
		const change = (apply: (run: HostTabRun) => void): void => {
			const was = isBusy(tab.run);
			apply(tab.run);
			if (isBusy(tab.run) !== was) this.#runningChanged();
		};
		// "Running" only means something on a live connection: a restart or crash ends the run.
		sidecar.on("status", (payload: SidecarStatusPayload) => {
			if (payload.status !== "ready") change(run => Object.assign(run, IDLE_RUN));
		});
		sidecar.on("promptResult", (frame: PromptResultFrame) => {
			if (typeof frame.sessionSettled !== "boolean") return;
			const settled = frame.sessionSettled;
			change(run => {
				run.awaitingSettled = !settled;
				run.running = !settled;
			});
		});
		sidecar.on("sessionSettled", () =>
			change(run => {
				run.awaitingSettled = false;
				run.running = false;
			}),
		);
		sidecar.on("events", (events: AgentSessionEvent[]) =>
			change(run => {
				for (const event of events) runEvent(run, event);
			}),
		);
	}

	#runningChanged(): void {
		for (const listener of this.#runningListeners) listener();
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
		const response = await client.command(command, params.timeoutMs);
		// A login or logout rewrote this machine's credential store: every tab
		// running here re-reads it — this machine's own and every device's.
		if (response.success && (command.type === "login" || command.type === "logout")) {
			for (const other of this.#tabs.values()) other.sidecar.syncImageGeneration();
			for (const local of this.#deps.localTabs.allSidecars()) if (!local.device) local.syncImageGeneration();
		}
		return response;
	}

	/** The host tab holding `sessionPath` with a process that has it in memory. */
	#liveOwner(sessionPath: string): HostTab | undefined {
		for (const tab of this.#tabs.values()) {
			if (tab.sessionFile === sessionPath && tab.sidecar.processAlive) return tab;
		}
		return undefined;
	}

	/**
	 * Delete a stored session the way this machine's own sidebar does: a live
	 * owner gives it up through `drop_session`, otherwise the file goes.
	 */
	async #deleteSession(sessionPath: string): Promise<null> {
		if (this.#liveOwner(sessionPath)) throw codedError("session_running", "Session is open on the host");
		const { localTabs } = this.#deps;
		const local = localTabs.sessionOwner(sessionPath);
		if (local && localTabs.sessionOwnerIsLive(sessionPath)) {
			const response = await localTabs.commandForIdleSession(sessionPath, { type: "drop_session" });
			if (!response) throw codedError("session_running", "Session is currently running");
			if (!response.success) throw new Error(response.error);
			const cancelled = (response.data as { cancelled?: boolean } | undefined)?.cancelled ?? false;
			if (cancelled) throw codedError("session_delete_cancelled", "Session deletion was cancelled");
			localTabs.noteSessionFile(local.tabId, null);
			return null;
		}
		// A local tab claiming the file without a process must not wake into a deleted path.
		if (local) localTabs.noteSessionFile(local.tabId, null);
		await this.#deps.sessionIndex.deleteSession(sessionPath);
		return null;
	}

	/** Rename through the live owner (its in-memory title must follow), else the stored file. */
	async #renameSession(sessionPath: string, rawName: string): Promise<null> {
		const name = rawName.trim();
		if (!name) throw codedError("session_name_empty", "Session name cannot be empty");
		const command: RpcCommand = { type: "set_session_name", name, sessionPath };
		const owner = this.#liveOwner(sessionPath);
		const { localTabs } = this.#deps;
		let response: RpcResponse | null | undefined;
		if (owner) {
			const client = owner.sidecar.status === "ready" ? owner.sidecar.rpcClient : null;
			response = client ? await client.command(command) : null;
		} else if (localTabs.sessionOwner(sessionPath) && localTabs.sessionOwnerIsLive(sessionPath)) {
			response = await localTabs.commandForSession(sessionPath, command);
		}
		if (response === null) throw codedError("session_starting", "Session is still starting");
		if (response) {
			if (!response.success) throw new Error(response.error);
			return null;
		}
		await this.#deps.renameStoredSession(sessionPath, name);
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
		if (isBusy(tab.run)) this.#runningChanged();
	}
}

function isBusy(run: HostTabRun): boolean {
	return run.running || run.compacting;
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
