import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import { assignmentTitle, unwrapStockPrompt } from "../../../resources/gui-bridge/modes/subagent-title-contracts";
import type { AgentMessage, SubagentFrame, SubagentSnapshot } from "../../shared/rpc-types";
import { messageText } from "../lib/messages";
import { reportedOutputTokens } from "../lib/turn-meter";
import { activeTabCommand, createScopedStoreHook, type TabCommand } from "./session-runtime-context";
import { createToolsStore, type ToolsStore } from "./tools";

export type SubagentNode = SubagentSnapshot;

export interface SubagentsStore {
	subagents: Map<string, SubagentNode>;
	surfaces: Map<string, StoreApi<ToolsStore>>;
	surface: (id: string) => StoreApi<ToolsStore>;
	hydrateSurface: (id: string) => Promise<void>;
	surfaceVersion: number;
	/** Provider-reported output seen before the next stock progress snapshot. */
	observedTokens: Map<string, number>;
	/** Visible expanded surfaces; hydration must not downgrade their event stream. */
	eventConsumers: number;
	/** Why the roster could not be read. Rows stay on screen when set; an empty
	    roster plus an error is "couldn't load", never "nothing spawned". */
	error: string | null;
	applyFrame: (frame: SubagentFrame) => void;
	/**
	 * Read a row's original assignment back from its transcript's first user message when the roster carries neither the
	 * assignment nor a label (a snapshot taken after a follow-up run, which reports no assignment). Once per id.
	 */
	recoverAssignment: (id: string) => Promise<void>;
	setSnapshots: (snapshots: SubagentNode[]) => void;
	/**
	 * Pull the full roster over get_subagents and MERGE it. Unlike
	 * setSnapshots this keeps local terminal rows: the RPC registry deletes
	 * completed/failed agents on their terminal lifecycle frame (AgentRegistry
	 * retains only parked/aborted refs), so a wholesale replace would make
	 * finished agents vanish from the UI on every poll. Best-effort — a
	 * failed fetch leaves frame-driven state untouched.
	 */
	refresh: (options?: { expect?: () => boolean }) => Promise<void>;
	reset: () => void;
}

/**
 * Live (non-terminal) wire statuses, mirror of statusMeta().live in
 * components/panels/subagent-graph (component layer — not importable here).
 * Rows absent from a refresh fetch are dropped when live (released) but kept
 * when terminal (the server forgets them; the user is still looking at them).
 */
const LIVE_STATUSES: Record<string, true> = {
	started: true,
	running: true,
	pending: true,
	idle: true,
	parked: true,
	// Stale registrations remain server-owned rows and must disappear after
	// hub cancel removes them; do not retain them as terminal history.
	stale: true,
};

/**
 * A row's original assignment. Stock reports a run's own message as `task` and, for a run after the first (a follow-up
 * to an idle subagent, the revival after a restart), no `assignment`: a revival's `task` is the wrapped original (so
 * the assignment is read back from it), a follow-up's is not and must never become the row's label.
 */
function normalizeSnapshot(snapshot: SubagentNode): SubagentNode {
	const assignment = snapshot.assignment ?? unwrapStockPrompt(snapshot.task);
	const withAssignment = assignment === snapshot.assignment ? snapshot : { ...snapshot, assignment };
	const title = assignmentTitle(assignment);
	const titled =
		title && title !== withAssignment.description ? { ...withAssignment, description: title } : withAssignment;
	return titled.status === "running" && titled.live === false ? { ...titled, status: "stale" } : titled;
}

/**
 * Merge one fetched row over the local one: the fetch wins EXCEPT it may never
 * blank a populated label/progress field. Server rows discovered late (bare
 * AgentRegistry refs) can lack task/assignment/description/progress/sessionFile
 * that a progress frame already delivered — replacing wholesale would blank
 * the card and lose durationMs mid-poll.
 */
function mergeFetchedSnapshot(fresh: SubagentNode, prev: SubagentNode): SubagentNode {
	return {
		...fresh,
		task: fresh.task ?? prev.task,
		assignment: fresh.assignment ?? prev.assignment,
		description: assignmentTitle(fresh.assignment ?? prev.assignment) ?? fresh.description ?? prev.description,
		progress: fresh.progress ?? prev.progress,
		sessionFile: fresh.sessionFile ?? prev.sessionFile,
	};
}

/**
 * Structural equality over JSON-shaped wire rows (primitives, arrays, plain
 * objects). A key holding `undefined` equals a missing key: the merge spells
 * out every optional field, while frames and fetches omit absent ones.
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => sameValue(item, b[index]));
	}
	if (Array.isArray(b)) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	for (const key of Object.keys(left)) if (!sameValue(left[key], right[key])) return false;
	for (const key of Object.keys(right)) if (!(key in left) && right[key] !== undefined) return false;
	return true;
}

export const createSubagentsStore = (command: TabCommand = activeTabCommand) => {
	let refreshVersion = 0;
	// Ids whose original assignment was already looked up in the transcript: once each, found or not.
	const recovered = new Set<string>();
	const hydrations = new Map<
		string,
		{ completed: boolean; toolCount: number; pending: boolean; load: Promise<void> }
	>();
	const observedUsage = new Map<string, Map<AgentMessage["timestamp"], number>>();
	const captureOutput = (id: string, message: AgentMessage): number => {
		if (message.role !== "assistant") return 0;
		const tokens = reportedOutputTokens(message);
		if (!tokens) return 0;
		let usage = observedUsage.get(id);
		if (!usage) {
			usage = new Map();
			observedUsage.set(id, usage);
		}
		const previous = usage.get(message.timestamp) ?? 0;
		if (tokens <= previous) return 0;
		usage.set(message.timestamp, tokens);
		return tokens - previous;
	};
	return createStore<SubagentsStore>()((set, get) => ({
		subagents: new Map(),
		surfaces: new Map(),
		eventConsumers: 0,
		surfaceVersion: 0,
		observedTokens: new Map(),
		surface: id => {
			const existing = get().surfaces.get(id);
			if (existing) return existing;
			const store = createToolsStore();
			set({ surfaces: new Map(get().surfaces).set(id, store) });
			return store;
		},
		hydrateSurface: id => {
			const existing = hydrations.get(id);
			const tools = get().surface(id);
			const node = get().subagents.get(id);
			const completed = !!node && node.status !== "running" && node.status !== "pending";
			const toolCount = node?.progress?.toolCount ?? 0;
			const observed = tools.getState();
			const missing =
				toolCount > observed.finishedTools.size + observed.liveTools.size ||
				(completed && observed.liveTools.size > 0);
			// A newer snapshot may arrive while replay is loading. Share that load;
			// after it settles, inspect the latest gap and replay it once if needed.
			if (existing?.pending) return existing.load;
			// Snapshot once on first expansion; replay a gap only at a new mount or completion.
			// No timer, no progress-frame polling, and no repeated completion fetch.
			if (existing && (!missing || existing.completed || (!completed && existing.toolCount >= toolCount)))
				return existing.load;
			const load = Promise.resolve()
				.then(async () => {
					const response = await command({ type: "get_subagent_messages", subagentId: id });
					if (response.success) return response;
					// Stock's RPC registry forgets settled agents across a relaunch; their
					// transcripts stay in the session's artifacts dir.
					const stored = await command({ type: "get_subagent_transcript", subagentId: id });
					if (!stored.success) throw new Error(response.error);
					return stored;
				})
				.then(response => {
					const data = response.data as { messages?: AgentMessage[] } | undefined;
					if (!data?.messages) return;
					const status = get().subagents.get(id)?.status;
					tools.getState().hydrateMessages(data.messages, {
						// Persisted messages can lag events already observed before this one-time fetch.
						keepChangedSince: 0,
						turnIsLive: status === "running" || status === "pending",
					});
					const tokens = data.messages.reduce((total, message) => total + captureOutput(id, message), 0);
					set(state => ({
						surfaceVersion: state.surfaceVersion + 1,
						observedTokens: tokens
							? new Map(state.observedTokens).set(id, (state.observedTokens.get(id) ?? 0) + tokens)
							: state.observedTokens,
					}));
				})
				.then(() => {
					hydration.pending = false;
					const latest = get().subagents.get(id);
					const nowCompleted = !!latest && latest.status !== "running" && latest.status !== "pending";
					const latestCount = latest?.progress?.toolCount ?? 0;
					const surface = tools.getState();
					const gap =
						latestCount > surface.finishedTools.size + surface.liveTools.size ||
						(nowCompleted && surface.liveTools.size > 0);
					if (gap && (latestCount > toolCount || (nowCompleted && !completed))) {
						hydrations.delete(id);
						return get().hydrateSurface(id);
					}
				})
				.finally(() => {
					hydration.pending = false;
				});
			const hydration = { completed, toolCount, pending: true, load };
			hydrations.set(id, hydration);
			return load;
		},
		error: null,
		applyFrame: frame => {
			// Copy-on-first-write: a progress frame without an id leaves the map
			// untouched and must not trigger a re-render.
			let subagents: Map<string, SubagentNode> | null = null;
			let touched: string | undefined;

			switch (frame.type) {
				case "subagent_event": {
					const surface = get().surface(frame.payload.id);
					const version = surface.getState().revision;
					surface.getState().applyEvents([frame.payload.event]);
					const event = frame.payload.event;
					const tokens =
						event.type === "message_update" || event.type === "message_end"
							? captureOutput(frame.payload.id, event.message)
							: 0;
					if (surface.getState().revision !== version || tokens)
						set(state => ({
							surfaceVersion: state.surfaceVersion + 1,
							observedTokens: tokens
								? new Map(state.observedTokens).set(
										frame.payload.id,
										(state.observedTokens.get(frame.payload.id) ?? 0) + tokens,
									)
								: state.observedTokens,
						}));
					break;
				}
				case "subagent_lifecycle": {
					const p = frame.payload;
					subagents = new Map(get().subagents);
					const existing = subagents.get(p.id);
					subagents.set(p.id, {
						id: p.id,
						index: p.index,
						agent: p.agent,
						agentSource: p.agentSource,
						description: assignmentTitle(existing?.assignment) ?? p.description ?? existing?.description,
						status: p.status === "started" ? "running" : p.status,
						task: existing?.task,
						assignment: existing?.assignment,
						sessionFile: p.sessionFile ?? existing?.sessionFile,
						lastUpdate: Date.now(),
						parentToolCallId: p.parentToolCallId ?? existing?.parentToolCallId,
						parentSubagentId: p.parentSubagentId ?? existing?.parentSubagentId,
						progress: existing?.progress,
						kind: existing?.kind ?? "sub",
					});
					break;
				}
				case "subagent_progress": {
					// Attribute by stable id, not the per-batch index. A progress
					// frame can be the first frame observed after a late subscription,
					// so materialize the row instead of silently dropping it.
					const progress = frame.payload.progress;
					if (!progress?.id) break;
					const existing = get().subagents.get(progress.id);
					const assignment =
						frame.payload.assignment ?? existing?.assignment ?? unwrapStockPrompt(frame.payload.task);
					subagents = new Map(get().subagents);
					subagents.set(progress.id, {
						id: progress.id,
						index: frame.payload.index,
						agent: frame.payload.agent,
						agentSource: frame.payload.agentSource,
						description: assignmentTitle(assignment) ?? progress.description ?? existing?.description,
						status: progress.status,
						task: frame.payload.task,
						assignment,
						sessionFile: frame.payload.sessionFile ?? existing?.sessionFile,
						lastUpdate: Date.now(),
						parentToolCallId: frame.payload.parentToolCallId ?? existing?.parentToolCallId,
						parentSubagentId: frame.payload.parentSubagentId ?? existing?.parentSubagentId,
						kind: existing?.kind ?? "sub",
						progress,
					});
					touched = progress.id;
					break;
				}
			}

			if (subagents) set({ subagents });
			if (touched) void get().recoverAssignment(touched);
		},
		recoverAssignment: async id => {
			const node = get().subagents.get(id);
			if (!node || node.assignment || node.description || recovered.has(id)) return;
			recovered.add(id);
			try {
				let response = await command({ type: "get_subagent_messages", subagentId: id, firstPrompt: true });
				if (!response.success)
					response = await command({ type: "get_subagent_transcript", subagentId: id, firstPrompt: true });
				if (!response.success) return;
				const messages = (response.data as { messages?: AgentMessage[] } | undefined)?.messages;
				const first = messages?.find(message => message.role === "user");
				const text = first ? messageText(first) : "";
				const assignment = unwrapStockPrompt(text) ?? (text || undefined);
				const latest = get().subagents.get(id);
				if (!assignment || !latest || latest.assignment || latest.description) return;
				set(state => ({
					subagents: new Map(state.subagents).set(id, normalizeSnapshot({ ...latest, assignment })),
				}));
			} catch {
				// Best-effort: the row keeps its role name.
			}
		},
		setSnapshots: snapshots => {
			refreshVersion++;
			const subagents = new Map<string, SubagentNode>();
			for (const snap of snapshots) {
				const normalized = normalizeSnapshot(snap);
				subagents.set(normalized.id, normalized);
			}
			set({ subagents });
		},
		refresh: async options => {
			const version = ++refreshVersion;
			const before = get().subagents;
			try {
				const res = await command({ type: "get_subagents" });
				// Post-await guard: the poll may have been sent for a tab/session
				// that is no longer foreground — its snapshots must not merge into
				// the new session's store.
				if (version !== refreshVersion || (options?.expect && !options.expect())) return;
				if (!res.success) {
					if (get().error !== res.error) set({ error: res.error });
					return;
				}
				const data = res.data as { subagents?: SubagentNode[] } | undefined;
				if (!data?.subagents) {
					if (get().error !== null) set({ error: null });
					return;
				}
				const current = get().subagents;
				const fetched = new Set<string>();
				const subagents = new Map<string, SubagentNode>();
				let changed = false;
				for (const snap of data.subagents) {
					const normalized = normalizeSnapshot(snap);
					fetched.add(normalized.id);
					const prev = current.get(normalized.id);
					let next = normalized;
					if (prev && prev !== before.get(normalized.id)) next = prev;
					else if (prev) {
						const merged = mergeFetchedSnapshot(normalized, prev);
						// An idle poll returns the same rows: keep identity so selectors
						// and memoized rows don't re-render every 3s.
						next = sameValue(merged, prev) ? prev : merged;
					}
					if (next !== prev) changed = true;
					subagents.set(normalized.id, next);
				}
				// Terminal rows the server has forgotten survive the merge — see the
				// refresh docstring (RPC registry deletes completed/failed agents).
				for (const [id, node] of current) {
					if (!fetched.has(id) && (!LIVE_STATUSES[node.status] || node !== before.get(id)))
						subagents.set(id, node);
				}
				if (!changed && subagents.size === current.size) {
					// Same ids, same objects (every surviving current row was re-set
					// or carried over): only the error may need clearing.
					if (get().error !== null) set({ error: null });
					return;
				}
				set({ subagents, error: null });
				for (const id of subagents.keys()) void get().recoverAssignment(id);
			} catch (cause) {
				// Best-effort poll: frames + hydration remain authoritative. The
				// failure is still recorded so the empty roster can name it.
				if (version !== refreshVersion || (options?.expect && !options.expect())) return;
				set({ error: cause instanceof Error ? cause.message : String(cause) });
			}
		},
		reset: () => {
			refreshVersion++;
			hydrations.clear();
			recovered.clear();
			observedUsage.clear();
			set({
				subagents: new Map(),
				surfaces: new Map(),
				observedTokens: new Map(),
				surfaceVersion: 0,
				eventConsumers: 0,
				error: null,
			});
		},
	}));
};

const defaultSubagentsStore = createSubagentsStore();
export const useSubagentsStore = createScopedStoreHook("subagents", defaultSubagentsStore);
