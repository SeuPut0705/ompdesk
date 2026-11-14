/**
 * Pool of per-tab sidecar processes, with no limit on their number.
 *
 * Each TAB owns one sidecar (a local SidecarManager, or a RemoteSidecar for a tab on a paired host); a window holds N
 * tabs. The pool wires each sidecar's events to its owning window, and releases the sidecar (listeners first, then
 * dispose) when its tab closes or its window closes.
 *
 * Event routing: the full event channels (events batch, status, subagent, live, commands, config, prompt result,
 * command output, session info, extension error, host tool/uri) forward from at most four VISIBLE tabs. One of them is
 * focused for untargeted commands. Every tab (visible or background) additionally pushes the light TAB_STATUS channel,
 * so background tabs report status flips, run outcomes, and session title/id changes, and forwards its extension UI
 * requests (a background ask still needs an answer). A hidden tab also forwards the two frames its sidebar row reads
 * from its own runtime: plan proposals and subagent lifecycle, so the row is current without a visit.
 *
 * Multi-viewer: besides its owner, a tab can be shown by viewer windows (a paired web device's; `attachViewer`). Each
 * window keeps its own view (active, visible, split), the tab's sidecar listeners exist once and fan out to every
 * window that shows it, and everything the light channel carries goes to the owner and every viewer. The first window
 * to answer an ask or approval wins: the others' cards close through a synthetic `cancel`, and a late answer from one
 * of them is refused (`already_answered`).
 *
 * F-OWN (double-attach guard): which tab/window is attached to a session file, kept by device plus path (a paired
 * host's `~/.omp` layout mirrors this one, so the same path on two machines names two different files).
 *
 * F-UI-ORIGIN (response routing): extension_ui requests raised by a tab are recorded by request id → owning tab, so a
 * renderer response routes back to the sidecar that RAISED the request even after the user switched to another tab.
 *
 * WHERE THE RULES ARE. Every rule above, and the state they keep, live in the core's hub (`native/ompdesk/crates/core/
 * src/pool/`, kind `pool`): it is the one writer, and this class is its client with the methods callers always had.
 * What stays here is what only this process can hold or do:
 * - the handles: each tab's sidecar, the windows (the core names them by `webContents.id`), the paired devices' hosted
 *   views, the full-channel forwarders with their message-update slimmers and the subagent frame batcher, the
 *   promises of released omps (`#exiting`), the moves in flight, the activity observers, the model-wait tracker;
 * - the collaborators, which the core asks (`ask`): the sidecar factory and its lifecycle calls, the hooks
 *   (`onRunningChange`, `onSessionFilesChanged`, `onWindowTabsChanged`, `worktreeStartGate`, `onAcquire`,
 *   `onTabReleased`), the deleted-session list and the removal holds, the clock of the timers and ticks;
 * - the sidecar's listeners: each event is fed to the core at the moment the sidecar emits it, in the order it came.
 * `hub.ts` explains how a call, an item and a question travel; `pool/mod.rs` lists this protocol.
 */

import {
	localizePromptOrigins,
	type PromptOrigin,
	type PromptOriginLabel,
} from "../../resources/gui-bridge/prompt-origin-contracts";
import {
	AGENT_CONTROL_REVIEW,
	type AgentReviewEvent,
	type AgentReviewResult,
	reviewFromDevice,
} from "../shared/agent-control";
import { codedError } from "../shared/ipc-error-codes";
import {
	IPC_EVENTS,
	type IpcOpenExtensionRequest,
	type IpcScheduledRetry,
	type IpcSessionOwner,
	type IpcSetTabViewPayload,
	type IpcTabInfo,
	type IpcTabRunOutcome,
	type IpcTabWorktree,
	type RemoteOpenedTab,
} from "../shared/ipc-types";
import {
	type AgentMessage,
	type AgentSessionEvent,
	BLOCKING_UI_METHODS,
	type ExtensionUIRequest,
	type HostToolCallRequest,
	type HostUriRequest,
	isSignInRequest,
	type PromptResultFrame,
	type RpcCommand,
	type RpcResponse,
	type SessionInfoUpdateFrame,
	type SidecarStatusPayload,
	type SubagentFrame,
	type SubagentSubscriptionLevel,
} from "../shared/rpc-types";
import { failureOf, unsavedSessionKey } from "../shared/session-summary";
import { isApprovalSelect } from "../shared/tool-approval";
import { TargetAnswer } from "./agent-control/target-answer";
import type { BackgroundWorkMember } from "./background-work";
import { canonicalCwd } from "./canonical-cwd";
import { type Hub, type HubItem, hub } from "./core/hub";
import { CoreError } from "./core/process";
import { deletedSessions } from "./deleted-sessions";
import { type ExtensionApplyPlan, extensionApplyDecision, mergeApplyPlans } from "./extension-reload";
import { createMessageUpdateSlimmer } from "./message-update-slim";
import { ModelWaitTracker } from "./model-wait-count";
import { noteOmpExit } from "./omp-exits";
import { ompRestartDecision } from "./omp-restart";
import type { WindowTabFact } from "./quit-guard";
import { AGENT_REVIEW_EVENT } from "./remote/app-protocol";
import { HostedTabView } from "./remote/hosted-view";
import type { TabHolder } from "./remote/protocol";
import { RemoteSidecar } from "./remote/remote-sidecar";
import type { SessionSummaries, SummaryFacts, SummarySource } from "./session-summaries";
import type { SettleWatch } from "./settle-watch";
import type { SidecarSessionIdentity, SidecarStartGate } from "./sidecar";
import type { RunReading } from "./sidecar-run-state";
import { type SidecarLike, VIEW_ENDED_EVENT } from "./sidecar-types";
import { nextSnowflake } from "./snowflake";
import { createSubagentFrameBatcher } from "./subagent-frames";
import { MAX_FORMER_TAB_IDS, type PersistedTabLayout, TAB_LAYOUT_VERSION } from "./tab-layout";
import { MovesInFlight, type ResumeFact, type ResumeMarker } from "./turn-resume";
import { recordTurnStop, type TurnStopBy } from "./turn-stop-log";
import { type ClientWindow, isWebWindow } from "./web/client-window";
import type { TabSpawnFacts } from "./worktree-lifecycle";
import { removalHolds } from "./worktree-removals";

/** `device` = paired host deviceId (absent = this machine); `tabId` names the tab on that host. */
export type SidecarFactory = (
	cwd: string,
	kind: "agent" | "chat",
	fresh: boolean,
	device: string | undefined,
	tabId: string,
	/** The tab is the phone page's (a paired web window owns it), not a desktop window's. */
	web: boolean,
) => SidecarLike;

function forwardToWindow(win: ClientWindow, channel: string, data: unknown): void {
	if (!win.isDestroyed()) win.webContents.send(channel, data);
}

/** The renderer's composer-draft reports (`noteDraft`): each window says whether its own draft is empty. */
export const DRAFT_COMMANDS = ["set_idle_compaction_draft", "set_next_prompt_draft"] as const;
export type DraftCommand = (typeof DRAFT_COMMANDS)[number];

/** An extension UI response (`ExtensionUIResponse`) in words, for the logs that keep what was chosen. */
export function describeAnswer(frame: object): string {
	if ("cancelled" in frame && frame.cancelled === true) return "dismissed";
	if ("value" in frame && typeof frame.value === "string") return frame.value;
	if ("confirmed" in frame && typeof frame.confirmed === "boolean") return frame.confirmed ? "yes" : "no";
	if ("answers" in frame && Array.isArray(frame.answers))
		return frame.answers
			.flatMap((answer: unknown) => {
				if (!answer || typeof answer !== "object") return [];
				const picked =
					"selectedOptions" in answer && Array.isArray(answer.selectedOptions) ? answer.selectedOptions : [];
				const custom =
					"customInput" in answer && typeof answer.customInput === "string" ? [answer.customInput] : [];
				return [...picked.map(String), ...custom];
			})
			.join(", ");
	return "";
}

/**
 * What a tab did, for observers that are not windows (Web Push, web/web-push-notifier.ts): its turn started
 * or settled (`idle` carries how the last run ended, after the resume rules ran), a blocking ask or approval
 * was raised or went away (answered by any window, withdrawn by omp, or its tab ended), the tab was released.
 * A provider sign-in's own requests are never asks.
 */
export type TabActivity =
	| { type: "busy"; tabId: string }
	| { type: "idle"; tabId: string; outcome: IpcTabRunOutcome | undefined }
	| { type: "ask"; tabId: string; requestId: string; text: string }
	/**
	 * A question or approval closed. `answered` is set when a window, a page or an agent answered it here: the card's
	 * title and the choice in its words (an option, yes/no, the answers, or "dismissed").
	 */
	| { type: "askClosed"; tabId: string; requestId: string; answered?: { title: string; choice: string } }
	/**
	 * The tab left the pool (closed by the person, an agent, its window or main). `session`: the saved session it held,
	 * so an id handed out for the tab keeps naming it (agent-control/session-fates.ts).
	 */
	| {
			type: "released";
			tabId: string;
			session?: { path: string; device?: string; title: string; cwd: string; formerIds: readonly string[] };
	  }
	/**
	 * A running turn moved on: a tool call started or ended, or a reply was written (its step and cost changed). Once
	 * per event batch; what the work board re-reads a running child for (agent-control/host.ts `liveReview`).
	 */
	| { type: "step"; tabId: string };

/** A tab's facts an observer reads when its debounce ends. */
export interface TabFacts {
	title: string;
	busy: boolean;
	/** When the busy run's turn started (this computer's clock), when known. */
	runningSince?: number;
	awaitingConnection: boolean;
	/** Stock's auto-retry is waiting for its next attempt: the failure is not final. */
	retrying: boolean;
	/** TurnResume armed a retry of the failed turn (`scheduledRetry` pref): the failure is not final either. */
	scheduledRetry?: boolean;
	/** The tab whose agent opened this one, while it is open here. */
	openedBy?: string;
	/** The tab compacts its context now. */
	compacting?: boolean;
}

/** A plan proposal awaiting approval: its title and plan file. */
export interface PendingPlan {
	title: string;
	planFilePath: string;
	/** Which proposal of the tab it is: stock rewrites one plan file for a revised proposal, so the path is no identity. */
	generation: number;
}

/** How long "Stop and delete" waits for a stopped turn to end before it gives up (`stopSession`). */
export const STOP_SESSION_WAIT_MS = 60_000;

/** Sidecar events a visible tab forwards to its window unchanged, as `{ tabId, payload }`. */
const FORWARDED_TAB_EVENTS: ReadonlyArray<readonly [event: string, channel: string]> = [
	["liveFrame", IPC_EVENTS.LIVE_FRAME],
	["btwFrame", IPC_EVENTS.BTW_FRAME],
	["modelCatalogUpdate", IPC_EVENTS.MODEL_CATALOG_UPDATE],
	["commandsUpdate", IPC_EVENTS.COMMANDS_UPDATE],
	["configUpdate", IPC_EVENTS.CONFIG_UPDATE],
	["promptResult", IPC_EVENTS.PROMPT_RESULT],
	["commandOutput", IPC_EVENTS.COMMAND_OUTPUT],
	["sessionInfoUpdate", IPC_EVENTS.SESSION_INFO_UPDATE],
	["extensionError", IPC_EVENTS.EXTENSION_ERROR],
];

/**
 * A tab's full-channel forwarders: one set of sidecar listeners for every window that shows it. Which windows are in
 * it is the core's (`wireFull` / `unwireFull` items); the forwarders and their slimmers are handles only main holds.
 */
interface FullWiring {
	/** Window id → that window and its own message-update slimmer (its first update of a message stays whole). */
	windows: Map<number, { win: ClientWindow; slim: (events: AgentSessionEvent[]) => AgentSessionEvent[] }>;
	/** Delivers the subagent frames still batched. */
	flush: () => void;
	/**
	 * Sends an agent-event batch to every window showing the tab. Called by the tab's one `events` listener before it
	 * feeds the core, whose TAB_STATUS for that batch must come after: a window reads the run's end from that status.
	 */
	forwardEvents: (events: AgentSessionEvent[]) => void;
	/** Takes the listeners off the sidecar. */
	remove: () => void;
}

/** What main holds of a tab: the handles. Everything the pool knows about the tab is in the core. */
interface TabHandle {
	sidecar: SidecarLike;
	winId: number;
	ownerDetached: boolean;
	hostCalls: Map<string, { request: HostToolCallRequest; view: number | null; delivered: boolean }>;
	disconnectedViews: Set<number>;
	/** Paired host deviceId the tab runs on (immutable, set at acquire). */
	device: string | undefined;
	/** The core released the tab: it is not in the pool any more, its sidecar is still being let go of. */
	gone: boolean;
	/**
	 * The session file the core holds for the tab (F-OWN), kept only to seed a new core after a loss. Written from the
	 * core's `sessionFile` item alone, never read for a rule.
	 */
	sessionFile: string | null;
	full: FullWiring | null;
	/** Paired devices that view this tab through their own tab on this host, by the id the core knows them by. */
	views: Map<number, HostedTabView>;
}

/** The facts the core asks of a sidecar (`facts`): what only the live object can say. */
interface SidecarFacts {
	cwd: string;
	status: string;
	processAlive: boolean;
	shared: boolean;
	pid?: number;
	sleep: boolean;
	rpc: boolean;
	bridge: boolean;
}

/** What `projectEvents` leaves of one agent event: only what the core's run rules read. */
type ProjectedEvent = Record<string, unknown>;

/** A tab's summary facts as the core answers them: no session file yet is null (the caller names the unsaved key). */
type CoreSummaryFacts = Omit<SummaryFacts, "sessionPath"> & { sessionPath: string | null };

/** The text a user message carries (a string, or its text blocks; attachments are not text). */
function messageText(message: AgentMessage): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/**
 * The agent events the core's rules read, and of each only what they read. A streaming reply makes a `message_update`
 * per delta, each carrying the whole message so far: none of that crosses (the windows' forwarders have it), nor the
 * events no rule reads; only a batch that holds one the rules read is fed.
 */
function projectEvents(events: AgentSessionEvent[]): ProjectedEvent[] {
	const kept: ProjectedEvent[] = [];
	for (const event of events) {
		switch (event.type) {
			case "agent_start":
			case "tool_execution_start":
			case "tool_execution_end":
			case "auto_compaction_start":
			case "auto_compaction_end":
				kept.push({ type: event.type });
				break;
			case "agent_end": {
				// The outcome reads the last assistant reply only: its stop reason, error and text.
				const last = event.messages?.findLast(message => message.role === "assistant");
				const content = last?.content;
				kept.push({
					type: event.type,
					isTerminal: event.isTerminal,
					messages: last
						? [
								{
									role: "assistant",
									stopReason: last.stopReason,
									errorMessage: last.errorMessage,
									content:
										typeof content === "string"
											? content
											: Array.isArray(content)
												? content.flatMap(part =>
														part.type === "text" ? [{ type: "text", text: part.text }] : [],
													)
												: undefined,
								},
							]
						: [],
				});
				break;
			}
			case "auto_retry_start":
				kept.push({
					type: event.type,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				});
				break;
			case "auto_retry_end":
				kept.push({
					type: event.type,
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
				});
				break;
			case "plan_proposal":
			case "plan_proposal_resolved":
				// Small, and a hidden tab's row is sent them whole.
				kept.push(event);
				break;
			case "message_end":
				kept.push({
					type: event.type,
					message: {
						role: event.message.role,
						...(event.message.role === "user" ? { text: messageText(event.message) } : {}),
					},
				});
				break;
			default:
		}
	}
	return kept;
}

/** The facts main works out of a request with the helpers it shares with the page. */
function kindsOf(request: ExtensionUIRequest): { blocking: boolean; signIn: boolean; approval: boolean } {
	return {
		blocking: BLOCKING_UI_METHODS[request.method] === true,
		signIn: isSignInRequest(request),
		approval: isApprovalSelect(request),
	};
}

/** What a failed call of the core is to its caller: the error the TypeScript threw. */
function poolError(error: unknown): unknown {
	if (!(error instanceof CoreError)) return error;
	// A collaborator's own failure comes back as the message it threw.
	if (error.code === "main_error") return new Error(error.message);
	if (error.code === "already_answered" || error.code === "being_answered")
		return codedError(error.code, error.message);
	return error;
}

export class SidecarPool {
	readonly #hub: Hub = hub();
	readonly #id: number;
	#open = false;
	readonly #factory: SidecarFactory;
	/** Tab id → what main holds of it. */
	readonly #handles = new Map<string, TabHandle>();
	/** Window id (`webContents.id`) → the window: the core names windows by id; a send finds the object here. */
	readonly #windows = new Map<number, ClientWindow>();
	readonly #windowIds = new WeakMap<ClientWindow, number>();
	/** Moves whose command is on its way, per tab (`beginMove`). */
	readonly #moves = new MovesInFlight();
	/** Session file (F-OWN key) → the exit of the omp a released tab ran it in: a delete waits for it. */
	readonly #exiting = new Map<string, Promise<void>>();
	/** Tab id → the exit of its omp once the tab is released: what a folder the tab worked in waits for. */
	readonly #exitingTabs = new Map<string, Promise<void>>();
	/** The methods that were `async` wait here for the core's `settle` item (by token). */
	readonly #settling = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void; timer?: NodeJS.Timeout }
	>();
	#token = 0;
	/** The summary facts read last (`#summaryFacts`), while nothing has changed since. */
	#summaryRead: object | null = null;
	/** The paired devices' views by the id the core knows them by. */
	readonly #viewIds = new WeakMap<HostedTabView, number>();
	#nextView = 0;
	readonly #viewSources = new WeakMap<HostedTabView, string>();
	readonly #viewLeaveGuards = new Map<number, () => boolean>();
	#viewEpoch = 0;
	/** The one retry object per `auto_retry_start` the resume rules compare by identity: tab → the object handed out. */
	readonly #retries = new Map<string, { id: number; retry: { errorMessage: string } }>();
	readonly #activityObservers = new Set<(activity: TabActivity) => void>();
	/**
	 * GUI host tools run against Electron in ipc.ts, which the pool cannot import without a cycle. Set once at startup;
	 * it answers every hostToolCall (shown or hidden tab), unknown tools with an explicit error.
	 */
	hostToolExecutor:
		| ((sidecar: SidecarLike, request: HostToolCallRequest, tab: { tabId: string; win: ClientWindow }) => void)
		| null = null;
	/** A paired host took a host tool result this computer sent (`RemoteSidecar`'s `hostReplyDelivered`), by call id. */
	hostReplyDelivered: ((id: string) => void) | null = null;
	/** This computer's own device id: a host's review list names a child that runs here by it. */
	selfDeviceId: (() => string) | null = null;
	/** Main-process persistence hook. The primary window installs this at startup. */
	onWindowTabsChanged: ((win: ClientWindow, layout: PersistedTabLayout | null) => void) | null = null;
	/** Some tab may have started or finished running a turn (keep-awake while working). */
	onRunningChange: (() => void) | null = null;
	/**
	 * A tab took or let go of a session file, on any path (acquire, the `session` identity, a session-id change, a
	 * release): paired devices list which sessions a tab here holds (index.ts hands it to
	 * `LocalHostServices.listingChanged`). Only an actual change calls it, never a repeated report.
	 */
	onSessionFilesChanged: (() => void) | null = null;
	/**
	 * A paired device's Cancel on the connection wait or scheduled retry of a window's tab it views (`viewForDevice`):
	 * this computer's resume rules hold both (index.ts hands it to `TurnResume.cancelWait`).
	 */
	onCancelWait: ((tabId: string) => void) | null = null;
	/** `worktree.onStart` (worktree-lifecycle.ts): the gate for a new tab, or null when the tab is not a candidate. */
	worktreeStartGate: ((tabId: string, winId: number, facts: TabSpawnFacts) => SidecarStartGate | null) | null = null;
	/** A tab was released (closed, or its window closed); `exited` settles once its omp is gone. */
	onTabReleased: ((tabId: string, exited: Promise<void>) => void) | null = null;
	/** A tab's sidecar was created (Autopilot attaches its approval and readiness listeners). */
	onAcquire: ((tabId: string, sidecar: SidecarLike) => void) | null = null;
	/** Diagnostic only: a turn that ended but stays settling past a minute leaves one runtime-log line (settle-watch.ts). */
	settleWatch: SettleWatch | null = null;
	/** The one builder of what every view's row shows of this computer's sessions (session-summaries.ts); set at startup. */
	summaries: Pick<SessionSummaries, "track" | "changed"> | null = null;

	/** Which tabs wait on one provider together (model-wait-count.ts); fed by every tab's events, here and by host-services. */
	readonly modelWait = new ModelWaitTracker();

	constructor(factory: SidecarFactory) {
		this.#factory = factory;
		this.#id = this.#hub.nextId();
		this.modelWait.onChange(snapshot => {
			this.#call("modelWaitTogether", { together: [...snapshot.together] });
		});
	}

	// ---- the core ------------------------------------------------------------------------------------------------

	/**
	 * A call of the pool's instance in the core. The first opens it; a core that was lost (it ended, or stopped
	 * answering) is opened again here, and the pool is seeded with the tabs main still holds (`#reseed`).
	 */
	#call<T>(method: string, params: object = {}): T {
		// Whatever this call changes, the facts read for the summaries before it no longer stand.
		this.#summaryRead = null;
		const instance = () => {
			this.#ensureOpen();
			return this.#id;
		};
		try {
			return this.#hub.callOnce<T>(instance, method, {
				...params,
				// Main's clock goes with every call: the rules read none, so a fake clock in a test is theirs too.
				now: Date.now(),
				wt: this.onWindowTabsChanged !== null,
			});
		} catch (error) {
			throw poolError(error);
		}
	}

	#ensureOpen(): void {
		if (!this.#open) this.#openInstance();
	}

	#openInstance(): void {
		this.#open = true;
		this.#viewEpoch++;
		try {
			this.#hub.open(
				this.#id,
				"pool",
				{
					layoutVersion: TAB_LAYOUT_VERSION,
					maxFormerTabIds: MAX_FORMER_TAB_IDS,
					stopSessionWaitMs: STOP_SESSION_WAIT_MS,
				},
				{
					item: item => this.#item(item),
					ask: (q, item) => this.#ask(q, item),
					lost: () => this.#lost(),
				},
			);
		} catch (error) {
			this.#open = false;
			throw error;
		}
		if (this.#handles.size > 0) this.#reseed();
	}

	/**
	 * The core ended or stopped answering: its pool is gone with everything it knew. The next call opens a new one
	 * (`#reseed`); what the calls in between find is an empty pool, as a new core is.
	 */
	#lost(): void {
		this.#open = false;
		// Promises waiting for the core's word can never get it: they end as a failed call does.
		for (const [token, waiting] of this.#settling) {
			this.#settling.delete(token);
			clearTimeout(waiting.timer);
			waiting.reject(new CoreError("hub_lost", "The pool was lost with the core"));
		}
	}

	/**
	 * A new core's pool is seeded with the tabs main holds a sidecar for. What the new pool has of each is what the
	 * handles can say: the tab id, its owner window, its device, its kind and status, the session file the core
	 * last held for it (F-OWN: the double-attach guard and the resume facts survive a loss). What a lost core loses: each tab's run (a turn on reads as
	 * idle until its next event), the last outcome, titles and the cached session id, the open asks and sign-ins,
	 * extension state, drafts, subagent levels, counters (`touched`, `prompted`, `exits`), each window's view (the
	 * first tab of a window is active and visible again; splits are gone) and every observer's debounce. The windows
	 * re-read their tab lists at their next resync.
	 */
	#reseed(): void {
		const tabs = [...this.#handles]
			.filter(([, handle]) => !handle.gone)
			.map(([tab, handle]) => ({
				tab,
				win: handle.winId,
				ownerDetached: handle.ownerDetached,
				device: handle.device ?? null,
				hosted: handle.sidecar instanceof HostedTabView,
				kind: handle.sidecar.kind,
				status: handle.sidecar.status,
				sessionFile: handle.sessionFile,
				full: [...(handle.full?.windows.keys() ?? [])],
				views: [...handle.views.keys()],
			}));
		this.#call("seed", { tabs });
	}

	/** One window's id, remembered: a destroyed window's `webContents` can no longer be read. */
	#windowId(win: ClientWindow): number {
		let id = this.#windowIds.get(win);
		if (id === undefined) {
			id = win.webContents.id;
			this.#windowIds.set(win, id);
		}
		this.#windows.set(id, win);
		return id;
	}

	#live(tab: string): TabHandle | undefined {
		const handle = this.#handles.get(tab);
		return handle && !handle.gone ? handle : undefined;
	}

	/** A method that was `async`: its synchronous part ran in the call, its promise settles by the core's `settle` item. */
	#later<T>(method: string, params: object): Promise<T> {
		const token = ++this.#token;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.#settling.set(token, { resolve: resolve as (value: unknown) => void, reject });
		try {
			this.#call(method, { ...params, token });
		} catch (error) {
			this.#settling.delete(token);
			return Promise.reject(error);
		}
		return promise;
	}

	// ---- what the core tells main -------------------------------------------------------------------------------

	#item(item: HubItem): void {
		this.#summaryRead = null;
		switch (item.k) {
			case "send": {
				const channel = IPC_EVENTS[item.channel as keyof typeof IPC_EVENTS];
				for (const id of item.wins as number[]) {
					const win = this.#windows.get(id);
					if (win) forwardToWindow(win, channel, item.data);
				}
				return;
			}
			case "wireFull":
				this.#wireFull(item.tab as string, item.win as number);
				return;
			case "unwireFull":
				this.#unwireFull(item.tab as string, item.win as number, item.last === true);
				return;
			case "sessionFile": {
				const handle = this.#handles.get(item.tab as string);
				if (handle) handle.sessionFile = (item.file as string | null) ?? null;
				return;
			}
			case "gone": {
				const handle = this.#handles.get(item.tab as string);
				if (handle) handle.gone = true;
				return;
			}
			case "ownerDetached": {
				const handle = this.#handles.get(item.tab as string);
				if (handle) handle.ownerDetached = true;
				return;
			}
			case "viewTargetChanged":
				this.#rerouteHostCalls(item.tab as string);
				return;
			case "listenClosed": {
				const id = item.win as number;
				this.#windows.get(id)?.once("closed", () => this.#windowClosed(id));
				return;
			}
			case "command":
				// A command nobody reads the answer of.
				void this.#handles
					.get(item.tab as string)
					?.sidecar.rpcClient?.command(item.command as RpcCommand)
					.catch(() => {});
				return;
			case "emitView":
				this.#handles
					.get(item.tab as string)
					?.views.get(item.view as number)
					?.emit(item.event as string, item.arg ?? undefined);
				return;
			case "settleWatch": {
				const tab = item.tab as string;
				if (item.op === "frame") {
					this.settleWatch?.noteFrame(
						tab,
						item.frame as "prompt_result" | "session_settled",
						item.settled as boolean,
					);
				} else if (item.op === "track") this.settleWatch?.track(tab, item.settling as boolean);
				else this.settleWatch?.forget(tab);
				return;
			}
			case "modelWaitForget":
				this.modelWait.forget(item.tab as string);
				return;
			case "turnStop":
				recordTurnStop({ command: item.command as string, tab: item.tab as string, by: item.by as TurnStopBy });
				return;
			case "reloadExtensions":
				void this.#handles
					.get(item.tab as string)
					?.sidecar.reloadExtensions?.(item.plan as ExtensionApplyPlan)
					?.catch(() => {});
				return;
			case "immediate":
				// One tick later, so every listener of the turn's last events has seen them before the process goes.
				setImmediate(() => {
					try {
						this.#call("immediate", { tab: item.tab, kind: item.kind });
					} catch {
						// A lost core takes the pending restart with it.
					}
				});
				return;
			case "stopTimer": {
				const token = item.token as number;
				const waiting = this.#settling.get(token);
				if (!waiting) return;
				waiting.timer = setTimeout(() => {
					try {
						this.#call("stopTimeout", { token });
					} catch {
						// A lost core ends the wait with the rest.
					}
				}, item.ms as number);
				return;
			}
			case "settle": {
				const token = item.token as number;
				const waiting = this.#settling.get(token);
				if (!waiting) return;
				this.#settling.delete(token);
				clearTimeout(waiting.timer);
				if (item.ok === true) waiting.resolve(item.value ?? null);
				else if (typeof item.code === "string" && item.code !== "main_error")
					waiting.reject(
						item.code === "already_answered" || item.code === "being_answered" || item.code === "session_running"
							? codedError(item.code, item.message as string)
							: new CoreError(item.code, item.message as string),
					);
				else waiting.reject(new Error(item.message as string));
				return;
			}
			default:
		}
	}

	/** The core asks about something only main can answer (the handles and collaborators), and waits for the value. */
	#ask(q: string, item: HubItem): unknown {
		this.#summaryRead = null;
		const tab = item.tab as string;
		switch (q) {
			case "viewLeaveAllowed":
				return this.#viewLeaveGuards.get(item.guard as number)?.() === true;
			case "leaveSourceView": {
				const handle = this.#live(tab);
				if (!handle || this.#viewLeaveGuards.get(item.guard as number)?.() !== true) return false;
				if (handle.sidecar instanceof RemoteSidecar)
					return handle.sidecar.leaveView(item.sessionPath as string).then(() => true);
				return true;
			}
			case "blocked": {
				const sessionPath = (item.sessionPath as string | null) ?? undefined;
				// A session the user deleted never comes back as a tab, whoever asks (a layout, a marker, a reopen);
				// a worktree being removed is not opened until git is done with it.
				if (item.hosted === true) return deletedSessions().has(sessionPath);
				const device = (item.device as string | null) ?? undefined;
				if (deletedSessions().has(sessionPath, device)) return true;
				return !device && removalHolds(item.cwd as string);
			}
			case "spawn": {
				const win = this.#windows.get(item.win as number);
				if (!win && item.ownerDetached !== true) throw new Error("The window of the new tab is unknown");
				const device = (item.device as string | null) ?? undefined;
				const cwd = item.cwd as string;
				// One spelling per directory: the sidecar reports its realpath'd cwd.
				const sidecar = this.#factory(
					device ? cwd : canonicalCwd(cwd),
					item.kind as "agent" | "chat",
					item.fresh === true,
					device,
					tab,
					isWebWindow(item.win as number),
				);
				const status = sidecar.status;
				// Before anything can start it: the gate must be in place for the first `ready`.
				const gate = this.worktreeStartGate?.(tab, item.win as number, {
					kind: item.kind as "agent" | "chat",
					sessionPath: (item.sessionPath as string | null) ?? undefined,
					device,
					worktree: (item.worktree as IpcTabWorktree | null) ?? undefined,
					fresh: item.fresh === true,
					placeholder: item.placeholder === true,
					deferStart: item.deferStart === true,
				});
				if (gate) sidecar.setStartGate?.(gate);
				this.#handles.set(tab, {
					sidecar,
					winId: item.win as number,
					ownerDetached: item.ownerDetached === true,
					hostCalls: new Map(),
					disconnectedViews: new Set(),
					device,
					gone: false,
					sessionFile: null,
					full: null,
					views: new Map(),
				});
				this.#wireLight(tab, sidecar);
				if (!device) this.summaries?.track(sidecar);
				return { status };
			}
			case "wire": {
				const handle = this.#handles.get(tab);
				if (handle) this.#wireLight(tab, handle.sidecar);
				return null;
			}
			case "acquired": {
				const handle = this.#handles.get(tab);
				if (handle) this.onAcquire?.(tab, handle.sidecar);
				return null;
			}
			case "facts": {
				const facts: Record<string, SidecarFacts> = {};
				for (const id of item.tabs as string[]) {
					const sidecar = this.#handles.get(id)?.sidecar;
					if (!sidecar) continue;
					facts[id] = {
						cwd: sidecar.cwd,
						status: sidecar.status,
						processAlive: sidecar.processAlive === true,
						shared: sidecar.shared === true,
						...(sidecar.pid === undefined ? {} : { pid: sidecar.pid }),
						sleep: typeof sidecar.sleep === "function",
						rpc: Boolean(sidecar.rpcClient),
						bridge: typeof sidecar.bridgeRequest === "function",
					};
				}
				return facts;
			}
			case "window": {
				const id = item.win as number;
				const win = this.#windows.get(id);
				return { destroyed: win ? win.isDestroyed() : true, web: isWebWindow(id) };
			}
			case "start": {
				const sidecar = this.#handles.get(tab)?.sidecar;
				const sessionFile = item.sessionFile as string | null;
				if (!sidecar) return null;
				if (sessionFile) sidecar.restart(undefined, sessionFile);
				else sidecar.start();
				return null;
			}
			case "restart":
				this.#handles.get(tab)?.sidecar.restart(undefined, (item.sessionFile as string | null) ?? undefined);
				return null;
			case "sleep":
				this.#handles.get(tab)?.sidecar.sleep?.();
				return null;
			case "adoptCwd":
				return this.#handles.get(tab)?.sidecar.adoptCwd(item.cwd as string) ?? false;
			case "sideChannel": {
				const frame = item.frame as { type?: string; id?: string };
				if (frame.type === "host_tool_result" && frame.id) this.#handles.get(tab)?.hostCalls.delete(frame.id);
				// The answer is nobody's here: a failure of a paired host's tab surfaces to the caller that asked.
				void this.#handles.get(tab)?.sidecar.sendSideChannel(item.frame as object);
				return null;
			}
			case "sideChannelLater": {
				const frame = item.frame as { type?: string; id?: string };
				if (frame.type === "host_tool_result" && frame.id) this.#handles.get(tab)?.hostCalls.delete(frame.id);
				return this.#handles.get(tab)?.sidecar.sendSideChannel(item.frame as object) ?? null;
			}
			case "rpc":
				return this.#handles.get(tab)?.sidecar.rpcClient?.command(item.command as RpcCommand) ?? null;
			case "endViews": {
				const handle = this.#handles.get(tab);
				for (const id of item.views as number[]) handle?.views.get(id)?.end();
				return null;
			}
			case "dispose": {
				const handle = this.#handles.get(tab);
				if (!handle) return null;
				const { sidecar } = handle;
				sidecar.removeAllListeners();
				// Taken before dispose(), which forgets the child it kills.
				const exited = sidecar.whenExited?.() ?? Promise.resolve();
				sidecar.dispose();
				this.#noteExiting(this.#exitingTabs, tab, exited);
				if (typeof item.ownerKey === "string") this.#noteExiting(this.#exiting, item.ownerKey, exited);
				if (item.device === null && item.hosted !== true) noteOmpExit(sidecar.cwd, exited);
				this.onTabReleased?.(tab, exited);
				this.#handles.delete(tab);
				return null;
			}
			case "disposeSidecars":
				for (const id of item.tabs as string[]) {
					const handle = this.#handles.get(id);
					if (!handle) continue;
					handle.sidecar.removeAllListeners();
					handle.sidecar.dispose();
					this.#handles.delete(id);
				}
				return null;
			case "announce": {
				const activity = item.activity as TabActivity;
				for (const observer of this.#activityObservers) {
					try {
						observer(activity);
					} catch {
						// An observer's failure is its own.
					}
				}
				return null;
			}
			case "decide": {
				const status = this.#handles.get(tab)?.sidecar.status;
				if (status === undefined) return "skip";
				const facts = { status, busy: item.busy === true };
				return item.kind === "omp" ? ompRestartDecision(facts) : extensionApplyDecision(facts);
			}
			case "mergePlans":
				return mergeApplyPlans(item.a as ExtensionApplyPlan, item.b as ExtensionApplyPlan);
			case "deletedAdd":
				deletedSessions().add(item.sessionPath as string, item.device as string);
				return null;
			case "selfDevice":
				return this.selfDeviceId?.() ?? null;
			case "snowflake":
				return nextSnowflake();
			case "onRunningChange":
				this.onRunningChange?.();
				return null;
			case "onSessionFilesChanged":
				this.onSessionFilesChanged?.();
				return null;
			case "onWindowTabsChanged": {
				const win = this.#windows.get(item.win as number);
				if (win) this.onWindowTabsChanged?.(win, item.layout as PersistedTabLayout | null);
				return null;
			}
			case "exiting":
				return this.#exiting.get(item.key as string) ?? null;
			default:
				throw new Error(`The pool's core asked an unknown question: ${q}`);
		}
	}

	#noteExiting(exiting: Map<string, Promise<void>>, key: string, exited: Promise<void>): void {
		exiting.set(key, exited);
		void exited.finally(() => {
			if (exiting.get(key) === exited) exiting.delete(key);
		});
	}

	/** The window's one "closed" listener (registered at the core's word): every tab it owned or viewed goes. */
	#windowClosed(id: number): void {
		this.#call("windowClosed", { win: id });
	}

	// ---- the sidecar's listeners ----------------------------------------------------------------------------------

	#routeHostCall(tab: string, id: string): void {
		const handle = this.#live(tab);
		const call = handle?.hostCalls.get(id);
		if (!handle || !call) return;
		const request = call.delivered ? { ...call.request, resent: true } : call.request;
		for (const win of this.windowsShowingTab(tab)) {
			if (win.isDestroyed()) continue;
			handle.hostCalls.delete(id);
			this.hostToolExecutor?.(handle.sidecar, request, { tabId: tab, win });
			return;
		}
		for (const [viewId, view] of handle.views) {
			if (handle.disconnectedViews.has(viewId)) continue;
			call.view = viewId;
			call.delivered = true;
			view.emit("hostToolCall", request);
			return;
		}
	}

	#rerouteHostCalls(tab: string): void {
		const handle = this.#live(tab);
		if (!handle) return;
		for (const [id, call] of handle.hostCalls) {
			if (call.view !== null && handle.views.has(call.view) && !handle.disconnectedViews.has(call.view)) continue;
			call.view = null;
			this.#routeHostCall(tab, id);
		}
	}

	setDeviceViewAttached(view: HostedTabView, attached: boolean): void {
		const tab = this.#viewSources.get(view);
		const viewId = this.#viewIds.get(view);
		if (!tab || viewId === undefined) return;
		const handle = this.#live(tab);
		if (!handle) return;
		if (attached) handle.disconnectedViews.delete(viewId);
		else handle.disconnectedViews.add(viewId);
		this.#rerouteHostCalls(tab);
	}

	/** Per-tab light wiring, attached for the entry's whole life: each event is fed to the core as the sidecar emits it. */
	#wireLight(tab: string, sidecar: SidecarLike): void {
		const feed = (event: string, payload: unknown = null): void => {
			this.#call("feed", { tab, event, payload: payload ?? null, fromLink: sidecar.statusFromLink === true });
		};
		sidecar.on("status", (payload: SidecarStatusPayload) => {
			feed("status", {
				status: payload.status,
				sessionHeld: payload.sessionHeld,
				slow: payload.slow,
				queued: payload.queued,
				message: payload.message,
				sessionEnded: payload.sessionEnded,
				failure: failureOf(payload) ?? null,
			});
		});
		sidecar.on("status", (payload: SidecarStatusPayload) => {
			if (payload.status !== "ready") this.#handles.get(tab)?.hostCalls.clear();
		});
		// The host's reading of the turn on a re-attach (sent before its status): what the lost link hid of its start or end.
		sidecar.on("hostRun", (reading: RunReading) => feed("hostRun", reading));
		// A paired host deleted this session while the tab was away (`session_deleted`).
		sidecar.on("sessionDeleted", (sessionPath: string | null) => feed("sessionDeleted", sessionPath));
		// The host refused the tab because its session's folder is a finished OMPdesk worktree.
		sidecar.on("folderGone", () => feed("folderGone"));
		// The host refused the tab because another tab there already shows its session.
		sidecar.on("shownElsewhere", (holder: TabHolder | null) => feed("shownElsewhere", holder));
		// A paired host told this tab it views a window of that host: the lists say so.
		sidecar.on("shared", () => feed("shared"));
		// The review list of the host's session this tab views: the sessions its agent opened are tabs of that host's
		// windows, never of this computer, so they come tagged with the device that opens them (agent-control.ts).
		sidecar.on(AGENT_REVIEW_EVENT, (review: AgentReviewResult) => {
			const handle = this.#live(tab);
			if (!handle?.device || !Array.isArray(review?.items)) return;
			const event = {
				tabId: tab,
				...reviewFromDevice(review, handle.device, this.selfDeviceId?.()),
			} satisfies AgentReviewEvent;
			for (const win of this.windowsShowingTab(tab))
				if (!win.isDestroyed()) win.webContents.send(AGENT_CONTROL_REVIEW, event);
		});
		// The paired device's tab a hosted view shows ended (closed, deleted, revoked).
		sidecar.on(VIEW_ENDED_EVENT, () => feed("viewEnded"));
		sidecar.on("sessionInfoUpdate", (frame: SessionInfoUpdateFrame) =>
			feed("sessionInfoUpdate", { title: frame.title, sessionId: frame.sessionId, autoTitle: frame.autoTitle }),
		);
		// Every get_state the sidecar answers reports the live session.
		sidecar.on("session", (identity: SidecarSessionIdentity) =>
			feed("session", {
				sessionId: identity.sessionId,
				sessionFile: identity.sessionFile,
				sessionName: identity.sessionName,
			}),
		);
		sidecar.on("extensionUi", (request: ExtensionUIRequest) =>
			feed("extensionUi", { request, kinds: kindsOf(request) }),
		);
		sidecar.on("openAsks", (requests: ExtensionUIRequest[]) =>
			feed("openAsks", { requests, kinds: requests.map(kindsOf) }),
		);
		sidecar.on("signIn", (arg: { active: string[]; ended?: { providerId: string; error: string | null } }) =>
			feed("signIn", arg),
		);
		// This computer stands in for the host's sign-in callback (sign-in-relay.ts).
		sidecar.on("signInRelay", relay => feed("signInRelay", relay));
		// A tool call blocks the turn until answered, so a hidden tab's calls are answered too.
		sidecar.on("hostToolCall", (request: HostToolCallRequest) => {
			const handle = this.#live(tab);
			if (!handle) return;
			handle.hostCalls.set(request.id, { request, view: null, delivered: false });
			this.#routeHostCall(tab, request.id);
		});
		sidecar.on("frame", (frame: { type?: unknown; targetId?: unknown }) => {
			if (frame.type !== "host_tool_cancel" || typeof frame.targetId !== "string") return;
			const handle = this.#handles.get(tab);
			const call = handle?.hostCalls.get(frame.targetId);
			if (call?.view !== null && call?.view !== undefined) handle?.views.get(call.view)?.emit("frame", frame);
			handle?.hostCalls.delete(frame.targetId);
		});
		sidecar.on("hostReplyDelivered", (id: string) => this.hostReplyDelivered?.(id));
		// OMPdesk registers no host URI schemes: fail the read/write instead of leaving omp waiting, shown tab or hidden.
		sidecar.on("hostUriRequest", (request: HostUriRequest) => {
			sidecar.sendSideChannel({
				type: "host_uri_result",
				id: request.id,
				isError: true,
				error: `OMPdesk serves no host URI for ${request.url}`,
			});
		});
		sidecar.on("promptResult", (frame: PromptResultFrame) => {
			if (typeof frame.sessionSettled === "boolean")
				feed("settle", { settled: frame.sessionSettled, frame: "prompt_result" });
		});
		sidecar.on("sessionSettled", () => feed("settle", { settled: true, frame: "session_settled" }));
		// A paired host holds this tab's connection wait (its own connectivity decides, turn-resume.ts): mirror it.
		sidecar.on("awaitingConnection", (awaiting: boolean) => feed("awaitingConnection", awaiting));
		// And the retry it scheduled for the failed turn of a window's tab this one views.
		sidecar.on("scheduledRetry", (retry: IpcScheduledRetry | undefined) => feed("scheduledRetry", retry ?? null));
		// Agent-end means one run yielded; upstream prompt/session-settled frames keep background async work
		// represented as running until it is quiet.
		sidecar.on("events", (events: AgentSessionEvent[]) => {
			const handle = this.#handles.get(tab);
			handle?.full?.forwardEvents(events);
			this.modelWait.observe(tab, handle?.device ?? "", events);
			const projected = projectEvents(events);
			if (projected.length > 0) feed("events", projected);
		});
	}

	// ---- the full channel ---------------------------------------------------------------------------------------

	/**
	 * Full-channel wiring for window `winId`, at the core's word (`wireFull`): the sidecar listeners exist once per tab
	 * and fan out to every window the tab is visible in; a window already wired is left untouched.
	 */
	#wireFull(tab: string, winId: number): void {
		const handle = this.#handles.get(tab);
		const win = this.#windows.get(winId);
		if (!handle || !win) return;
		// A fresh slimmer per window: the first update of each message after the tab becomes visible there keeps
		// its full snapshot (it missed message_start).
		const shown = { win, slim: createMessageUpdateSlimmer() };
		if (handle.full) {
			handle.full.windows.set(winId, shown);
			return;
		}
		const { sidecar } = handle;
		const windows: FullWiring["windows"] = new Map([[winId, shown]]);
		const removers: (() => void)[] = [];
		// One push object for every window: a web page's frame text is then made once for all the pages showing the tab.
		const forwardActive = <T>(channel: string, payload: T): void => {
			const data = { tabId: tab, payload };
			for (const target of windows.values()) forwardToWindow(target.win, channel, data);
		};
		const wire = <T>(event: string, listener: (payload: T) => void): void => {
			sidecar.on(event, listener);
			removers.push(() => {
				sidecar.off(event, listener);
			});
		};
		const subagentFrames = createSubagentFrameBatcher(frames => forwardActive(IPC_EVENTS.SUBAGENT_FRAMES, frames));
		wire("subagentFrame", (frame: SubagentFrame) => subagentFrames.push(frame));
		const forwardEvents = (events: AgentSessionEvent[]): void => {
			// Subagent frames that arrived first leave first, as when each was sent alone.
			subagentFrames.flush();
			// Windows whose slimmers stand at the same message get the same slimmed batch, and so the same push object.
			const pushes = new Map<AgentSessionEvent[], { tabId: string; payload: AgentSessionEvent[] }>();
			for (const target of windows.values()) {
				const payload = target.slim(events);
				let data = pushes.get(payload);
				if (!data) {
					data = { tabId: tab, payload };
					pushes.set(payload, data);
				}
				forwardToWindow(target.win, IPC_EVENTS.EVENTS_BATCH, data);
			}
		};
		// A response (a subagent's messages, a transcript) can hold frames still batched here.
		wire("beforeResponse", () => subagentFrames.flush());
		wire("status", (payload: SidecarStatusPayload) => {
			forwardActive(IPC_EVENTS.SIDECAR_STATUS, { ...payload, cwd: sidecar.cwd });
		});
		for (const [event, channel] of FORWARDED_TAB_EVENTS) {
			wire(event, (payload: unknown) => forwardActive(channel, payload));
		}
		handle.full = {
			windows,
			flush: () => subagentFrames.flush(),
			forwardEvents,
			remove: () => {
				for (const remove of removers) remove();
			},
		};
	}

	/** Stop forwarding the tab's full channel to window `winId` (`unwireFull`); the last window takes the listeners off. */
	#unwireFull(tab: string, winId: number, last: boolean): void {
		const full = this.#handles.get(tab)?.full;
		if (!full?.windows.has(winId)) return;
		if (last) {
			const handle = this.#handles.get(tab);
			if (handle) handle.full = null;
			full.remove();
			// Already received while shown: deliver them, as when each was sent alone.
			full.flush();
			return;
		}
		full.flush();
		full.windows.delete(winId);
	}

	// ---- the pool's methods ---------------------------------------------------------------------------------------

	/** What the settle diagnostic logs: stock's own settle predicate inputs and main's run flags. */
	settleFacts(tabId: string): Promise<Record<string, unknown>> {
		return this.#later("settleFacts", { tab: tabId });
	}

	get size(): number {
		return this.#call<number>("size");
	}

	/** Be told what tabs do (`TabActivity`); an observer that throws never breaks the pool. Returns the unsubscribe. */
	observeTabs(observer: (activity: TabActivity) => void): () => void {
		this.#activityObservers.add(observer);
		return () => this.#activityObservers.delete(observer);
	}

	/**
	 * App-wide state for every window (the desktop slot): one event, delivered as a batch of each window's active
	 * tab, which is the stream every window already reads. A window without a tab has no use for it.
	 */
	broadcastEvent(event: AgentSessionEvent): void {
		for (const [winId, tabId] of this.#call<Array<[number, string]>>("broadcastTargets")) {
			const win = this.#windows.get(winId);
			if (win) forwardToWindow(win, IPC_EVENTS.EVENTS_BATCH, { tabId, payload: [event] });
		}
	}

	/** App-wide state on a channel of its own, to every window that shows a tab (a window without one has no use for it). */
	broadcastApp(channel: string, payload: unknown): void {
		for (const [winId] of this.#call<Array<[number, string]>>("broadcastTargets")) {
			const win = this.#windows.get(winId);
			if (win) forwardToWindow(win, channel, payload);
		}
	}

	/** The facts of a live tab; null for an unknown (released) one. */
	tabFacts(tabId: string): TabFacts | null {
		return this.#call<TabFacts | null>("tabFacts", { tab: tabId });
	}

	/** The plan proposal `tabId`'s session waits on (approve or reject), if any. */
	pendingPlan(tabId: string): PendingPlan | null {
		return this.#call<PendingPlan | null>("pendingPlan", { tab: tabId });
	}

	/**
	 * What an automatic update restart must wait for on this computer's tabs (app-auto-update.ts): a tab compacting its
	 * context (a cut compaction does not resume), and a plan proposal waiting on the person (an approval card).
	 */
	restartHolds(): { compacting: boolean; planWaiting: boolean } {
		return this.#call("restartHolds");
	}

	/**
	 * The omps of this computer's own tabs whose run is on (a turn, or background work keeping it), with their bridge
	 * requests: the update restart's background-work probe (background-work.ts). A view of a device's tab here and a
	 * paired host's tab are left out: the first is the device tab's (`LocalHostServices.runningBridges`), the second its host's.
	 */
	runningBridges(): BackgroundWorkMember[] {
		return this.#call<string[]>("runningBridges").flatMap(tab => {
			const sidecar = this.#live(tab)?.sidecar;
			const request = sidecar?.bridgeRequest?.bind(sidecar);
			return request ? [{ key: tab, request }] : [];
		});
	}

	/**
	 * Spawn + bind a sidecar for `cwd` to `win` as a tab. Returns null when creating or starting the sidecar throws.
	 * `tabId` defaults to a fresh snowflake; `sessionPath` resumes that session on first start. `kind` defaults to
	 * "agent"; "chat" marks a session outside any project. The first tab of a window becomes its active tab; later
	 * tabs start in the background (light TAB_STATUS wiring only). Removes the entry when the window closes.
	 *
	 * `deferStart` creates the tab WITHOUT spawning its process and without claiming the window's active slot: a
	 * sidecar holds ~200 MB of private memory, so a restored layout must not pay for tabs nobody has looked at. The
	 * spawn happens the first time the tab is rendered.
	 *
	 * `device` runs the tab on a paired host: the factory returns a RemoteSidecar and the cwd is the host's path, so it
	 * is not resolved here (the host canonicalizes it). `task`: what another session's agent opened it for, on the
	 * entry before its first status reaches a window. `formerIds`: the ids the session's tab had before this one,
	 * newest first (a paired host's tab re-adopted after a relaunch: `readopt.ts`); they name it while it holds `sessionPath`.
	 */
	acquire(
		cwd: string,
		win: ClientWindow,
		tabId: string = nextSnowflake(),
		sessionPath?: string,
		kind: "agent" | "chat" = "agent",
		worktree?: IpcTabWorktree,
		fresh = false,
		placeholder = false,
		deferStart = false,
		title?: string,
		device?: string,
		task?: string,
		formerIds?: string[],
	): SidecarLike | null {
		const winId = this.#windowId(win);
		const result = this.#call<{ ok: boolean; added: boolean }>("acquire", {
			cwd,
			win: winId,
			tab: tabId,
			sessionPath,
			kind,
			worktree,
			fresh,
			placeholder,
			deferStart,
			title,
			device,
			task,
			formerIds,
		});
		if (!result.added) this.#handles.delete(tabId);
		return result.ok ? (this.#handles.get(tabId)?.sidecar ?? null) : null;
	}

	/**
	 * Show in `win` the tab this computer runs for a paired device on `sessionPath` (`sidecar` is its
	 * HostedTabView from LocalHostServices): an entry like a tab of the window's own, but one that only
	 * shows that omp. It owns the session here (F-OWN), so another window's open goes to it, and a window
	 * with no tab yet makes it active. False when the session was deleted.
	 */
	acquireHostedView(win: ClientWindow, tabId: string, sidecar: SidecarLike, sessionPath: string): boolean {
		const winId = this.#windowId(win);
		// Open first: a new core is seeded with the handles held so far, and this tab is not one of them.
		this.#ensureOpen();
		this.#handles.set(tabId, {
			sidecar,
			device: undefined,
			winId,
			ownerDetached: false,
			hostCalls: new Map(),
			disconnectedViews: new Set(),
			gone: false,
			sessionFile: null,
			full: null,
			views: new Map(),
		});
		const shown = this.#call<boolean>("acquireHostedView", {
			win: winId,
			tab: tabId,
			kind: sidecar.kind,
			status: sidecar.status,
			// The device's tab may be mid-turn as this window joins it: its events so far reached nobody here.
			reading: sidecar instanceof HostedTabView ? sidecar.runReading() : null,
			sessionPath,
		});
		if (!shown) this.#handles.delete(tabId);
		return shown;
	}

	/** Whether the tab is a window's view of a tab this computer runs for a paired device (`acquireHostedView`). */
	isHostedView(tabId: string): boolean {
		return this.#call<boolean>("isHostedView", { tab: tabId });
	}

	/**
	 * A paired device opens `sessionPath`, which a window of this computer has open: that tab's omp as the device's
	 * tab's sidecar (a HostedTabView), so one omp serves both. The device's prompts are journaled as `origin`'s and a
	 * transcript page is labelled for it; the first answer to an ask, the device's or a window's, wins; the window's
	 * close ends the view (`VIEW_ENDED_EVENT`). Null when no window's own tab here holds the session.
	 */
	viewForDevice(sessionPath: string, origin: PromptOrigin, hostName: string): HostedTabView | null {
		const tab = this.#call<string | null>("viewTarget", { path: sessionPath });
		const handle = tab ? this.#live(tab) : undefined;
		if (!tab || !handle) return null;
		const idOf = (candidate: HostedTabView): number => {
			let id = this.#viewIds.get(candidate);
			if (id === undefined) {
				id = ++this.#nextView;
				this.#viewIds.set(candidate, id);
			}
			return id;
		};
		const view: HostedTabView = new HostedTabView({
			sidecar: handle.sidecar,
			promptOrigin: origin,
			labelTranscript: data => {
				const page = data as { messages?: PromptOriginLabel[] } | undefined;
				if (!page?.messages?.some(message => message.promptFromId !== undefined)) return data;
				return { ...page, messages: localizePromptOrigins(page.messages, origin.deviceId, hostName) };
			},
			start: () => {
				this.#call("ensureStarted", { tab });
			},
			answer: frame => {
				this.#call("deviceAnswer", { tab, frame, view: idOf(view) });
			},
			stopped: () => this.noteStopped(tab),
			cancelWait: () => this.onCancelWait?.(tab),
			snapshot: () => this.#call("deviceSnapshot", { tab }),
			subagentLevel: level =>
				this.#call<SubagentSubscriptionLevel>("deviceSubagentLevel", { tab, view: idOf(view), level }),
			leave: left => {
				const id = idOf(left);
				handle.views.delete(id);
				handle.disconnectedViews.delete(id);
				this.#call("deviceViewLeft", { tab, view: id });
			},
		});
		const id = idOf(view);
		handle.views.set(id, view);
		this.#viewSources.set(view, tab);
		this.#call("deviceViewAdded", { tab, view: id });
		queueMicrotask(() => this.#rerouteHostCalls(tab));
		return view;
	}

	/** Whether the tab holding `sessionPath` runs a turn or compacts: a delete waits for it (session-mutations.ts). */
	sessionRunning(sessionPath: string, device?: string): boolean {
		return this.#call<boolean>("sessionRunning", { path: sessionPath, device });
	}

	/**
	 * The person's Stop of the turn the tab holding `sessionPath` runs, in any window (a delete it refused: "Stop and
	 * delete", session-mutations.ts). Resolves once that tab's run has ended (its `idle` activity, or it went away),
	 * never on a timer; at once when nothing runs there. Rejects `session_running` if the run has not ended after
	 * `STOP_SESSION_WAIT_MS`.
	 */
	stopSession(sessionPath: string, device?: string): Promise<void> {
		return this.#later("stopSession", { path: sessionPath, device });
	}

	/** Make `tabId` the window's active tab (moves full event forwarding). False when unknown/foreign. */
	setActiveTab(win: ClientWindow, tabId: string): boolean {
		return this.setTabView(win, tabId, [tabId]);
	}

	/** Atomically focus one tab and wire full streams for up to four visible tabs. */
	setTabView(
		win: ClientWindow,
		focusedTabId: string,
		visibleTabIds: readonly string[],
		split?: IpcSetTabViewPayload["split"],
		rememberedSplits?: IpcSetTabViewPayload["rememberedSplits"],
	): boolean {
		return this.#call<boolean>("setTabView", {
			win: this.#windowId(win),
			focused: focusedTabId,
			visible: visibleTabIds,
			split,
			remembered: rememberedSplits,
		});
	}

	/**
	 * Show another window's tab in `win` too (multi-viewer: a paired web device opening a session that is already
	 * open). The window gets the tab's light channel at once and its full channel while the tab is visible there; a
	 * window with no tab yet makes it its active one. True when `win` shows the tab now, false when the tab is unknown.
	 */
	attachViewer(win: ClientWindow, tabId: string): boolean {
		return this.#call<boolean>("attachViewer", { win: this.#windowId(win), tab: tabId });
	}

	/**
	 * A viewer window leaves a tab (it closed it there). The sidecar and every other window are untouched; the draft
	 * the window reported stops counting. False when `win` is not a viewer of the tab (its owner closes it with `releaseTab`).
	 */
	detachViewer(win: ClientWindow, tabId: string): boolean {
		return this.#call<boolean>("detachViewer", { win: this.#windowId(win), tab: tabId });
	}

	/** This surface's attachment and session identity, not just the tab id it happens to show. */
	viewIdentity(win: ClientWindow, tabId: string): string | null {
		const identity = this.#call<string | null>("viewIdentity", { win: this.#windowId(win), tab: tabId });
		return identity === null ? null : `${this.#viewEpoch}/${identity}`;
	}

	async leaveWindowView(
		win: ClientWindow,
		tabId: string,
		expectedIdentity: string,
		expectedSessionPath: string,
		stillClosable: () => boolean,
	): Promise<boolean> {
		if (!stillClosable() || this.viewIdentity(win, tabId) !== expectedIdentity) return false;
		const guard = ++this.#token;
		this.#viewLeaveGuards.set(guard, stillClosable);
		try {
			return await this.#later<boolean>("leaveWindowView", {
				guard,
				win: this.#windowId(win),
				tab: tabId,
				identity: expectedIdentity.slice(expectedIdentity.indexOf("/") + 1),
				sessionPath: expectedSessionPath,
			});
		} finally {
			this.#viewLeaveGuards.delete(guard);
		}
	}

	reviveDetached(marker: ResumeMarker): string | null {
		if (!marker.ownerDetached || marker.peer) return null;
		const existing = this.tabForSession(marker.sessionPath);
		if (existing) return existing;
		const result = this.#call<{ ok: boolean; added: boolean }>("acquire", {
			tab: marker.tab,
			win: marker.window,
			cwd: marker.cwd,
			kind: marker.kind,
			sessionPath: marker.sessionPath,
			fresh: false,
			deferStart: true,
			ownerDetached: true,
		});
		return result.ok ? marker.tab : null;
	}

	continuationSettled(tabId: string): void {
		this.#call("continuationSettled", { tab: tabId });
	}

	/** Whether another window views the tab (multi-viewer). */
	isShared(tabId: string): boolean {
		return this.#call<boolean>("isShared", { tab: tabId });
	}

	/** A window last reported a non-empty composer draft for the tab (`noteDraft`). */
	hasDraft(tabId: string): boolean {
		return this.#call<boolean>("hasDraft", { tab: tabId });
	}

	/**
	 * A window reports whether its composer draft for the tab is empty (`DRAFT_COMMANDS`). Every window
	 * showing the tab has its own draft, so the tab's omp hears "empty" only once all of them are; the
	 * return value is what to send it. With one window that is its own report.
	 */
	noteDraft(tabId: string, winId: number, command: DraftCommand, empty: boolean): boolean {
		return this.#call<boolean>("noteDraft", { tab: tabId, win: winId, command, empty });
	}

	/**
	 * A window sets the tab's subagent stream level. The tab's omp holds one level, while every window that
	 * shows the tab (a work map open on the phone, none on the desktop) has its own: the omp is told the
	 * highest of them, so one window closing its map never drops another's event stream.
	 */
	noteSubagentLevel(tabId: string, winId: number, level: SubagentSubscriptionLevel): SubagentSubscriptionLevel {
		return this.#call<SubagentSubscriptionLevel>("noteSubagentLevel", { tab: tabId, win: winId, level });
	}

	/**
	 * A window toggled a composer mode (plan, prewalk, agents pause, fast/slow): most have no stock event, so the
	 * other windows that show the tab are told with a `config_update {modes: true}` frame and re-read them.
	 */
	noteModeChanged(tabId: string, exceptWinId: number): void {
		this.#call("noteModeChanged", { tab: tabId, win: exceptWinId });
	}

	/**
	 * A session renamed on disk while its tab holds no live omp (asleep): the tab entry, its strip and every
	 * window's session title learn the name now. A live omp's rename reports itself (`Sidecar`).
	 */
	noteSessionName(tabId: string, title: string): void {
		this.#call("noteSessionName", { tab: tabId, title });
	}

	/** Every live sidecar, across windows (account changes reach all tabs). */
	allSidecars(): SidecarLike[] {
		return this.#call<string[]>("tabIds").flatMap(tab => {
			const sidecar = this.#live(tab)?.sidecar;
			return sidecar ? [sidecar] : [];
		});
	}

	/** The window that owns a tab (not a viewer's); null for an unknown tab. */
	windowOfTab(tabId: string): ClientWindow | null {
		const id = this.#call<number | null>("windowOfTab", { tab: tabId });
		return id === null ? null : (this.#windows.get(id) ?? null);
	}

	/** The windows that show a tab: its owner, then its viewers (a paired phone's page viewing it). */
	windowsShowingTab(tabId: string): ClientWindow[] {
		return this.#call<number[]>("windowsShowingTab", { tab: tabId }).flatMap(id => {
			const win = this.#windows.get(id);
			return win ? [win] : [];
		});
	}

	/** Every window that owns a live tab, in tab acquisition order (the control tools' app-wide session list). */
	tabWindows(): ClientWindow[] {
		return this.#call<number[]>("tabWindows").flatMap(id => {
			const win = this.#windows.get(id);
			return win ? [win] : [];
		});
	}

	/**
	 * omp on this computer was updated: every local tab moves to it (omp-restart.ts).
	 * Idle tabs restart now on their session file; a tab in a turn restarts when it ends.
	 * Returns how many tabs still wait. Tabs on paired hosts are the host's; a hosted view's omp is the device tab's.
	 */
	restartOnNewOmp(): number {
		return this.#call<number>("restartOnNewOmp");
	}

	/**
	 * Every local tab's working directory, distinct, in order (asleep tabs included: they load plugins on wake).
	 * A hosted view's folder is LocalHostServices' to list.
	 */
	workspaceDirs(): string[] {
		return this.#call<string[]>("workspaceDirs");
	}

	/**
	 * An extension update landed on this computer (extension-reload.ts). Idle ready tabs apply it now,
	 * a tab in a turn when it ends. Returns how many tabs still wait. Tabs on paired hosts are the host's, and a
	 * hosted view's omp gets it as the device's tab (LocalHostServices).
	 */
	applyExtensionUpdate(plan: ExtensionApplyPlan): number {
		return this.#call<number>("applyExtensionUpdate", { plan });
	}

	/** Resolves via the ACTIVE tab, so every existing ipc.ts handler keeps working unchanged. */
	sidecarForWindow(win: ClientWindow): SidecarLike | null {
		const tab = this.#call<string | null>("tabForWindow", { win: this.#windowId(win) });
		return tab ? (this.#live(tab)?.sidecar ?? null) : null;
	}

	/** The sidecar of one specific tab, scoped to the window that owns it. */
	sidecarForTab(win: ClientWindow, tabId: string): SidecarLike | null {
		const tab = this.#call<string | null>("tabForWindowTab", { win: this.#windowId(win), tab: tabId });
		return tab ? (this.#live(tab)?.sidecar ?? null) : null;
	}

	/**
	 * One tab of `win` — `tabId`, or the window's active tab when omitted — with the device it runs on, so a handler
	 * can route a remote tab to its host, its owner window's id (`winId`), which keys what the tab owns on this
	 * machine (its terminals) whichever window asks, and the session file it is on or opening (null for a fresh tab).
	 */
	tabTarget(
		win: ClientWindow,
		tabId?: string,
	): {
		tabId: string;
		sidecar: SidecarLike;
		device: string | undefined;
		winId: number;
		sessionFile: string | null;
	} | null {
		const target = this.#call<{ tabId: string; device?: string; winId: number; sessionFile: string | null } | null>(
			"tabTarget",
			{ win: this.#windowId(win), tab: tabId },
		);
		const sidecar = target ? this.#live(target.tabId)?.sidecar : undefined;
		return target && sidecar ? { ...target, sidecar, device: target.device } : null;
	}

	/**
	 * Send a command to the ready tab attached to `sessionPath`, mid-run or not —
	 * for mutations stock applies safely during a run (rename). Null until the
	 * owner's process is ready.
	 */
	commandForSession(sessionPath: string, command: RpcCommand, device?: string): Promise<RpcResponse | null> {
		return this.#later("commandForSession", { path: sessionPath, command, device });
	}

	/**
	 * The session is being deleted: close the tab holding it, as a closed tab goes, and resolve once no omp of this
	 * computer has the file open (the owner's, or the one a tab the user just closed ran). The owner's window hears the
	 * tab is gone (`TAB_LIST_CHANGED` `closed`) and drops it like its own close. False, with nothing closed, while the
	 * owner's run or compaction is in flight.
	 */
	closeSessionTab(sessionPath: string, device?: string): Promise<boolean> {
		return this.#later("closeSessionTab", { path: sessionPath, device });
	}

	/**
	 * Resolves once the omp of a tab released a moment ago has exited (at once when none is exiting, and for a tab of a
	 * paired device, whose omp is not a process here). A closed tab leaves the lists before its process is gone, and on
	 * Windows that process keeps its working folder from being removed until it is.
	 */
	whenTabExited(tabId: string): Promise<void> {
		return this.#exitingTabs.get(tabId) ?? Promise.resolve();
	}

	/** Release one tab's sidecar. False when the tab is unknown. */
	releaseTab(tabId: string): boolean {
		return this.#call<boolean>("releaseTab", { tab: tabId });
	}

	/** Release one tab like `releaseTab`; resolves once its omp process has exited. */
	releaseTabWhenExited(tabId: string): Promise<void> {
		return this.releaseTab(tabId) ? this.whenTabExited(tabId) : Promise.resolve();
	}

	/**
	 * Tell `win` that main closed its tab `tabId` (already released): the window drops it as it drops a tab whose session
	 * was deleted (`TAB_LIST_CHANGED` `closed`), and a page that was not connected finds it gone at its next resync.
	 */
	announceClosed(win: ClientWindow, tabId: string): void {
		this.#call("announceClosed", { win: this.#windowId(win), tab: tabId });
	}

	/**
	 * Bind a worktree `worktree.onStart` created to a tab that is still starting (it restarts there next). Pushes
	 * TAB_STATUS so the chip shows it. False when the tab is gone.
	 */
	bindWorktree(tabId: string, worktree: IpcTabWorktree): boolean {
		return this.#call<boolean>("bindWorktree", { tab: tabId, worktree });
	}

	/** A tab's sidecar, any window (main-side flows that start from a tab id). */
	sidecarOf(tabId: string): SidecarLike | null {
		return this.#live(tabId)?.sidecar ?? null;
	}

	/**
	 * The tab/window currently attached to `sessionPath`, null when free (F-OWN). SPAWN_TAB and SESSION_OPEN_NEW_WINDOW
	 * consult this before spawning a second sidecar for the same file.
	 */
	sessionOwner(sessionPath: string, device?: string): IpcSessionOwner | null {
		return this.#call<IpcSessionOwner | null>("sessionOwner", { path: sessionPath, device });
	}

	/**
	 * Whether the owner tab of `sessionPath` has a process holding that session in memory. `asleep` (restored but never
	 * shown), `exited` and `error` have no process at all, so the file on disk is the entire session: a rename must go
	 * to the filesystem instead of a `set_session_name` with nobody to answer it. `starting` counts as live: that
	 * spawn is about to read the file. A child that is still running always counts, whatever the status says: a failed
	 * health check reports `error` over a live process that still holds the file.
	 */
	sessionOwnerIsLive(sessionPath: string, device?: string): boolean {
		return this.#call<boolean>("sessionOwnerIsLive", { path: sessionPath, device });
	}

	/**
	 * The owner BLOCKING `tabId`'s attach to `sessionPath` — the file's current owner when it is a different tab, else
	 * null (unowned, or owned by the issuer itself, which re-attaches freely). An untracked issuer (null tabId) is
	 * blocked by any owner: refusing is the safe direction there. F-OWN's refuse-or-focus decision point for the
	 * switch_session passthrough. The path is on the issuer's device.
	 */
	foreignSessionOwner(tabId: string | null, sessionPath: string): IpcSessionOwner | null {
		return this.#call<IpcSessionOwner | null>("foreignSessionOwner", { tab: tabId, path: sessionPath });
	}

	/**
	 * Record the session file a tab's sidecar is attached to. ipc.ts reports this from the RPC passthrough
	 * (switch_session success, get_state — the only main-observable carriers of the file path; session_info_update
	 * itself carries just the id). Null unregisters (fresh unsaved session).
	 */
	noteSessionFile(tabId: string, sessionFile: string | null): void {
		this.#call("noteSessionFile", { tab: tabId, file: sessionFile });
	}

	/**
	 * Re-root a tab to its live session's cwd. `switch_session` re-roots the agent with no main-observable event, so the
	 * chip and every `sidecar.cwd` consumer stay frozen at the spawn cwd until this is called — the RPC passthrough
	 * reports the post-switch cwd (get_state) here. Pushes TAB_STATUS when the cwd changed so the renderer's chip tracks
	 * the move. Returns true when the cwd changed (ipc.ts gates the window-record sync).
	 */
	adoptSessionCwd(tabId: string, cwd: string): boolean {
		return this.#call<boolean>("adoptSessionCwd", { tab: tabId, cwd });
	}

	/**
	 * Route a renderer side-channel response to the sidecar that RAISED the request (F-UI-ORIGIN), tracked by request id
	 * at forward time — not the window's active tab, which may have changed while the dialog was open. The response
	 * consumes the route once the sidecar took it: a paired host's tab that could not deliver it (the link down, or
	 * dropped while the answer was on its way, or the host refused it) rejects, the route and the open request stay and
	 * the card can be answered again. False when the id is unknown — the caller falls back to the active tab's sidecar.
	 *
	 * A shared tab's ask (multi-viewer) takes the first answer: `responder`'s closes the other windows' cards through a
	 * synthetic `cancel`, and an answer from another window after it is refused (`already_answered`), even while the
	 * first is still on its way.
	 */
	routeSideChannel(
		id: string,
		frame: object,
		tabId?: string,
		responder?: ClientWindow,
		claim?: number,
	): Promise<boolean> {
		return this.#later("routeSideChannel", {
			id,
			frame,
			tab: tabId,
			responder: responder ? this.#windowId(responder) : undefined,
			choice: describeAnswer(frame),
			...(claim === undefined ? {} : { claim }),
		});
	}

	/**
	 * An agent's answer takes a question before its attachments go in (`TargetAnswer`): every other answer to it (the
	 * person's card, another agent, a device viewing the tab) is refused as `being_answered` until it lands or the claim
	 * is released. The rule lives in the core's pool (`pool/claims.rs`); these are its calls. Null: not open, or taken.
	 */
	claimRequest(tabId: string, requestId: string): number | null {
		return this.#call<number | null>("claimRequest", { tab: tabId, id: requestId });
	}

	/** Give a claimed question back unanswered. */
	releaseRequest(requestId: string, claim: number): void {
		this.#call("releaseRequest", { id: requestId, claim });
	}

	/** Whether `requestId` is a question `tabId`'s omp still waits on. */
	isRequestOpen(tabId: string, requestId: string): boolean {
		return this.#call<boolean>("isRequestOpen", { tab: tabId, id: requestId });
	}

	/** Throws `being_answered` when an agent's answer holds the question and `claim` is not its own. */
	guardAsk(requestId: string, claim?: number): void {
		this.#call("guardAsk", { id: requestId, ...(claim === undefined ? {} : { claim }) });
	}

	/** Take the plan `tabId` waits on when it is the proposal at `planFilePath` of `generation`; null otherwise or when held. */
	claimPlan(tabId: string, planFilePath: string, generation: number): number | null {
		return this.#call<number | null>("claimPlan", { tab: tabId, file: planFilePath, generation });
	}

	/** Whether the plan `claim` took is still the pending one (a revision is another generation). */
	planStillClaimed(tabId: string, claim: number): boolean {
		return this.#call<boolean>("planStillClaimed", { tab: tabId, claim });
	}

	releasePlan(tabId: string, claim: number): void {
		this.#call("releasePlan", { tab: tabId, claim });
	}

	/**
	 * Throws `being_answered` for an approve or reject of a plan an agent's approval holds, unless it is the claiming
	 * step's own (`own`): the window dispatcher and a device viewing the tab both call it.
	 */
	guardPlan(tabId: string, own = false): void {
		this.#call("guardPlan", { tab: tabId, own });
	}

	/** An answer with attachments is one claimed step in this main (`TargetAnswer`), here for this pool's tabs. */
	readonly targetAnswer: TargetAnswer = new TargetAnswer({
		askOpen: (tabId, id) => this.isRequestOpen(tabId, id),
		claim: (tabId, id) => this.claimRequest(tabId, id),
		release: (id, claim) => this.releaseRequest(id, claim),
		route: (tabId, id, response, claim) => this.routeSideChannel(id, response, tabId, undefined, claim),
		claimPlan: (tabId, planFile, generation) => this.claimPlan(tabId, planFile, generation),
		planStillClaimed: (tabId, claim) => this.planStillClaimed(tabId, claim),
		releasePlan: (tabId, claim) => this.releasePlan(tabId, claim),
	});

	/**
	 * Each of this window's tabs' status texts, widgets and title, for a page that loaded after they were
	 * sent: no later frame repeats them.
	 */
	extensionUiState(win: ClientWindow): IpcOpenExtensionRequest[] {
		return this.#call<IpcOpenExtensionRequest[]>("extensionUiState", { win: this.#windowId(win) });
	}

	/** The asks and approvals this window's tabs still wait on, for a page that loaded after they were raised. */
	openRequests(win: ClientWindow): IpcOpenExtensionRequest[] {
		return this.#call<IpcOpenExtensionRequest[]>("openRequests", { win: this.#windowId(win) });
	}

	/** The window's active tab id (null when the window has no tabs). */
	activeTabForWindow(win: ClientWindow): string | null {
		return this.#call<string | null>("activeTabForWindow", { win: this.#windowId(win) });
	}

	/**
	 * The window missed pushes (a paired page that could not resume its connection, or whose stream was dropped
	 * while hidden): the next `message_update` of each of its tabs goes out whole again, so a reply that streams on
	 * carries the text the page missed instead of deltas glued after a gap.
	 */
	resnapshotWindow(win: ClientWindow): void {
		const winId = this.#windowId(win);
		for (const handle of this.#handles.values()) {
			const shown = handle.full?.windows.get(winId);
			if (shown) shown.slim = createMessageUpdateSlimmer();
		}
	}

	/** The window's tabs in acquisition order (GET_TABS boot reconciliation). */
	tabsForWindow(win: ClientWindow): IpcTabInfo[] {
		return this.#call<IpcTabInfo[]>("tabsForWindow", { win: this.#windowId(win) });
	}

	/**
	 * Put one window's tabs in `order` (tab overview drag, ⌘1…⌘9 positions); other windows' tabs keep their slots.
	 * False unless `order` names exactly the window's tabs once each. The saved layout follows.
	 */
	reorderWindowTabs(win: ClientWindow, order: readonly string[]): boolean {
		return this.#call<boolean>("reorderWindowTabs", { win: this.#windowId(win), order });
	}

	/**
	 * The inputs of the resume rules (turn-resume.ts): what each tab is doing and why it may continue.
	 * A hosted view's turn is the device tab's, which LocalHostServices reports.
	 */
	resumeFacts(): ResumeFact[] {
		const facts =
			this.#call<Array<Omit<ResumeFact, "retry"> & { retry?: { errorMessage: string; id: number } }>>("resumeFacts");
		const seen = new Set<string>();
		const out = facts.map(({ retry, ...fact }): ResumeFact => {
			if (!retry) return fact;
			seen.add(fact.tabId);
			// One object per `auto_retry_start`: the resume rules count the retries they took over by identity.
			let kept = this.#retries.get(fact.tabId);
			if (kept?.id !== retry.id) {
				kept = { id: retry.id, retry: { errorMessage: retry.errorMessage } };
				this.#retries.set(fact.tabId, kept);
			}
			return { ...fact, retry: kept.retry };
		});
		for (const tab of [...this.#retries.keys()]) if (!seen.has(tab)) this.#retries.delete(tab);
		return out;
	}

	/**
	 * The sessions this computer's windows run, for the one summary builder (session-summaries.ts). A tab on a paired
	 * host and a view of a device's tab here are left out: the host, and this computer's own tabs it runs for devices,
	 * say those.
	 */
	summarySources(): SummarySource[] {
		const sources = this.#call<Array<{ tabId: string; ask: "approval" | "input" | null }>>("summarySources");
		const read = { sources, facts: null as Map<string, CoreSummaryFacts | null> | null };
		return sources.flatMap(({ tabId }) => {
			const sidecar = this.#live(tabId)?.sidecar;
			if (!sidecar) return [];
			return [
				{
					sidecar,
					facts: (): SummaryFacts | null => {
						const facts = this.#summaryFacts(read).get(tabId) ?? null;
						return facts ? { ...facts, sessionPath: facts.sessionPath ?? unsavedSessionKey(tabId) } : null;
					},
				},
			];
		});
	}

	/**
	 * The facts of every source of one `summarySources`, read in one call when the summary builder asks for the first
	 * of them, and kept until anything could change them: the next call of the pool, anything the core tells main, or
	 * the end of this tick. The builder reads every source in one go; a read per tab was most of main's waits on the
	 * hub (9 500 a minute with 20 tabs).
	 */
	#summaryFacts(read: {
		sources: Array<{ tabId: string; ask: "approval" | "input" | null }>;
		facts: Map<string, CoreSummaryFacts | null> | null;
	}): Map<string, CoreSummaryFacts | null> {
		if (read.facts && this.#summaryRead === read) return read.facts;
		const answers = this.#call<Array<CoreSummaryFacts | null>>("summaryFactsAll", {
			sources: read.sources.map(({ tabId, ask }) => ({ tab: tabId, ask })),
		});
		read.facts = new Map(read.sources.map(({ tabId }, index) => [tabId, answers[index] ?? null]));
		this.#summaryRead = read;
		queueMicrotask(() => {
			if (this.#summaryRead === read) this.#summaryRead = null;
		});
		return read.facts;
	}

	/**
	 * Who opened what in this computer's windows (`setTabOpener`): child session file → its opener's file, for the
	 * devices paired to it (`LocalHostServices` `sessions.list`). A tab on a paired host and a view of a device's tab
	 * here are left out, as in `summarySources`.
	 */
	sessionOpeners(): Map<string, string> {
		return new Map(this.#call<Array<[string, string]>>("sessionOpeners"));
	}

	/**
	 * The tabs of this computer's windows that run on a paired device and that a session of this computer opened, for
	 * every other view of its sessions (its other windows, its phone pages, the devices paired to it): each nests the
	 * child under its opener as the window holding the tab does. A tab a session on a paired host opened is that
	 * host's, and a view of a device's tab here is left out.
	 */
	remoteOpenedTabs(): RemoteOpenedTab[] {
		return this.#call<RemoteOpenedTab[]>("remoteOpenedTabs");
	}

	/**
	 * The session files this computer's windows' tabs hold (a phone page's included), for the devices paired to it: such
	 * a session stays a row of its own on their list of this computer, as in its own sidebar. Left out as in
	 * `sessionOpeners`.
	 */
	windowSessionFiles(): Set<string> {
		return new Set(this.#call<string[]>("windowSessionFiles"));
	}

	/**
	 * The worktree each of this computer's own tabs is bound to, for the sidebar project list: where git cannot yet
	 * read a folder's branch (a worktree being made), the tab's binding names it.
	 */
	worktreeBindings(): Array<{ path: string; branch: string; baseCwd: string }> {
		return this.#call("worktreeBindings");
	}

	/** The session file a live tab shows, if it has one yet. */
	sessionFileOf(tabId: string): string | undefined {
		return this.#call<string | null>("sessionFileOf", { tab: tabId }) ?? undefined;
	}

	/** The user pressed Stop on this tab's run. */
	noteStopped(tabId: string): void {
		this.#call("noteStopped", { tab: tabId });
	}

	/**
	 * Whether a tab holds a new session nobody has written to yet (`IpcTabInfo.unstarted`). A `new_session` reset
	 * makes it one again; the person's first prompt or shell command ends it (a run's `agent_start` does too).
	 */
	noteUnstarted(tabId: string, unstarted: boolean): void {
		this.#call("noteUnstarted", { tab: tabId, unstarted });
	}

	/** The user is changing which session or branch this tab shows (`TOUCH_COMMANDS`): a scheduled retry no longer applies. */
	noteTouched(tabId: string): void {
		this.#call("noteTouched", { tab: tabId });
	}

	/** The person sent this tab a prompt of their own (`personsPrompt`): a run it starts is theirs, never a continuation's. */
	notePrompted(tabId: string): void {
		this.#call("notePrompted", { tab: tabId });
	}

	/** A command that may move this tab (`TOUCH_COMMANDS`) goes out; call the result once its answer was counted (`trackMove`). */
	beginMove(tabId: string): () => void {
		// A continuation whose check found no move on its way and whose command the core already wrote is sent first
		// (formal/turn-resume P9 `NoSendWhileMoveInFlight`, CORRESPONDENCE A18): the move's command goes after it.
		this.#hub.barrier();
		return this.#moves.begin(tabId);
	}

	/** Resolves once no move of the tab is on its way (turn-resume.ts: a continuation judges `touched` only then). */
	movesSettled(tabId: string): Promise<void> {
		return this.#moves.settled(tabId);
	}

	/**
	 * A provider sign-in (`login`) started on, or answered from, this tab. When the last one answers,
	 * a page that took the sign-in over after a reload (`IpcSignIn.active`) is told it is over.
	 */
	noteSignIn(tabId: string, active: boolean, login?: { providerId: string; error?: string | null }): void {
		this.#call("noteSignIn", { tab: tabId, active, login });
	}

	signInActive(tabId: string): boolean {
		return this.#call<boolean>("signInActive", { tab: tabId });
	}

	/** Show or clear the tab's "waiting for the internet connection" state. */
	setAwaitingConnection(tabId: string, awaiting: boolean): void {
		this.#call("setAwaitingConnection", { tab: tabId, awaiting });
	}

	/** Show or clear the tab's calm "continuing where it left off" row (a relaunch's resume). */
	setResuming(tabId: string, resuming: boolean): void {
		this.#call("setResuming", { tab: tabId, resuming });
	}

	/**
	 * Which tab a relaunch continues first: 0 the window's focused tab, 1 another pane of its split, 2 the rest, so the
	 * work the user is looking at starts before the background tabs compete for the same spawns.
	 */
	resumeRank(tabId: string): number {
		return this.#call<number>("resumeRank", { tab: tabId });
	}

	/** Show (or with `undefined` clear) the tab's scheduled retry (turn-resume.ts). */
	setScheduledRetry(tabId: string, retry: IpcScheduledRetry | undefined): void {
		this.#call("setScheduledRetry", { tab: tabId, retry });
	}

	/** Spawn a deferred tab's process now (a background tab a relaunch must resume); the sidecar, or null for an unknown tab. */
	startTab(tabId: string): SidecarLike | null {
		return this.#call<boolean>("startTab", { tab: tabId }) ? (this.#live(tabId)?.sidecar ?? null) : null;
	}

	/**
	 * Close the tabs on `device` (undefined: this computer's own) that a relaunch restored and nobody has shown since
	 * (`asleep`: no omp, here or on the host) whose folder is in `folders`, as a deleted session's tab closes; the ids
	 * closed. Fed the finished worktrees of that computer's project list (`finishedWorktreeFolders`): such a session
	 * never comes back through a tab nobody uses (the user's report, 29 Oct 2026).
	 */
	closeAsleepTabsIn(device: string | undefined, folders: ReadonlySet<string>): string[] {
		return this.#call<string[]>("closeAsleepTabsIn", { device, folders: [...folders] });
	}

	/** The session files the tabs here hold on paired host `device`: what `sessions.deleted` asks that host about. */
	deviceSessionFiles(device: string): string[] {
		return this.#call<string[]>("deviceSessionFiles", { device });
	}

	/**
	 * Paired host `device` deleted these sessions (`host.sessionsDeleted`, or its `sessions.deleted` answer as the link
	 * came up): every tab here on one closes as a delete's does, asleep, ready or running (a running one stops as
	 * closing a tab does), the tombstones are recorded under that host so no restore brings them back; the ids closed.
	 */
	closeHostDeletedSessions(device: string, sessionPaths: readonly string[]): string[] {
		return this.#call<string[]>("closeHostDeletedSessions", { device, paths: sessionPaths });
	}

	/** Name a tab after it exists (a relaunched one, from its saved session); a new tab gets its task in `acquire`. */
	setTabTask(tabId: string, task: string): void {
		this.#call("setTabTask", { tab: tabId, task });
	}

	/** The ids a tab had in earlier launches while it still holds the session they named (newest first). */
	formerTabIds(tabId: string): readonly string[] {
		return this.#call<string[]>("formerTabIds", { tab: tabId });
	}

	/**
	 * Record that `openerTabId`'s agent opened `tabId` (`ompdesk_session_open`): the windows nest the session under
	 * its opener, and the layout keeps the opener's session file so the family survives a relaunch.
	 */
	setTabOpener(tabId: string, openerTabId: string): void {
		this.#call("setTabOpener", { tab: tabId, opener: openerTabId });
	}

	/** The tab on this computer attached to `sessionPath`, if any. */
	tabForSession(sessionPath: string): string | null {
		return this.#call<string | null>("tabForSession", { path: sessionPath });
	}

	/** What every live tab is doing right now — the ⌘Q guard's inventory (a hosted view's turn is the host role's). */
	tabInventory(): WindowTabFact[] {
		return this.#call<WindowTabFact[]>("tabInventory");
	}

	/** The tabs whose omp runs on this computer, for idle release: pid, title, whether it is quiet. */
	memoryTabs(): Array<{ tabId: string; pid?: number; label: string; quiet: boolean }> {
		return this.#call("memoryTabs");
	}

	/**
	 * Give a quiet tab's omp back while memory is short (`idle-release.ts`): checked again, then stock's own settle
	 * predicate (`isSettled`: idle, nothing queued, no background job or delivery that could wake it), then once more
	 * after that answer. Resolves whether it went asleep.
	 */
	releaseIdle(tabId: string): Promise<boolean> {
		return this.#later("releaseIdle", { tab: tabId });
	}

	/**
	 * Serializable layout for the window, excluding transient run/status data. A paired device's window also names
	 * the stored sessions it views (another window owns them): after a relaunch it views them again (`restoreLayout`).
	 */
	tabLayoutForWindow(win: ClientWindow): PersistedTabLayout | null {
		return this.#call<PersistedTabLayout | null>("tabLayoutForWindow", { win: this.#windowId(win) });
	}

	/**
	 * Recreate saved tabs with fresh runtime ids, then restore their active index. Every tab is acquired with
	 * `deferStart`: only the panes the view ends up showing get a process, so a restored ten-tab session costs one
	 * sidecar instead of ten.
	 */
	restoreLayout(win: ClientWindow, layout: PersistedTabLayout): number {
		return this.#call<number>("restoreLayout", { win: this.#windowId(win), layout });
	}

	disposeAll(): void {
		this.#call("disposeAll");
	}
}
