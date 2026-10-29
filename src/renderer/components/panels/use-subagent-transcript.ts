/**
 * One subagent's transcript, read through the owning tab's held transcripts (`subagent-transcripts.ts`): what the
 * work card's replay or an earlier open of this view already read is shown at once and only what the journal gained
 * since is asked for, and a settled agent read since it settled is not asked again. Loaded pages also feed the
 * tool-call ownership registry so nested spawn edges resolve progressively. A running agent is followed: a progress
 * frame (its `lastUpdate` moves) or the poll below asks for what is new, and a page with nothing new changes nothing,
 * so an idle agent re-renders no row. A hidden window asks nothing; it reads once when it shows again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import { pollWhileVisible } from "../../lib/visible-poll";
import { useRuntimeTabId, withSessionRuntime } from "../../stores/session-runtime-context";
import type { HeldTranscript } from "../../stores/subagent-transcripts";
import { settledMark, useSubagentsStore } from "../../stores/subagents";
import { isLiveSubagentStatus, registerTranscriptToolCalls } from "./subagent-graph";

/** How often a running agent's transcript is asked for news besides its progress frames. */
const FOLLOW_INTERVAL_MS = 4000;

export interface SubagentTranscriptState {
	/** The first page is in flight and nothing is shown yet. */
	loading: boolean;
	/** An explicit page ("Load more", retry) is in flight. */
	busy: boolean;
	messages: AgentMessage[];
	error: string | null;
	/** More may follow: only offered for a finished agent, a running one is followed. */
	hasMore: boolean;
	loadMore: () => void;
	reload: () => void;
}

interface PageState {
	loading: boolean;
	busy: boolean;
	messages: AgentMessage[];
	hasMore: boolean;
	error: string | null;
}

const INITIAL: PageState = { loading: true, busy: false, messages: [], hasMore: true, error: null };

function heldPage(held: HeldTranscript | undefined): PageState {
	return held ? { loading: false, busy: false, messages: held.messages, hasMore: true, error: null } : INITIAL;
}

type ReadKind = "follow" | "more" | "restart";

export function useSubagentTranscript(agent: SubagentSnapshot): SubagentTranscriptState {
	const transcripts = useSubagentsStore(state => state.transcripts);
	const tabId = useRuntimeTabId();
	const live = isLiveSubagentStatus(agent.status);
	const settled = settledMark(agent);
	const generation = useRef(0);
	const loadingRef = useRef(false);
	const [state, setState] = useState<PageState>(() => heldPage(transcripts.held(agent.id)));

	/** `follow`: a quiet read of what is new, with no spinner, changing nothing when nothing is. */
	const load = useCallback(
		async (kind: ReadKind) => {
			if (loadingRef.current) return;
			loadingRef.current = true;
			const version = generation.current;
			if (kind !== "follow") setState(prev => ({ ...prev, busy: true, error: null }));
			try {
				// "Load more" asks the journal again even for a settled agent read since it settled.
				const read = await transcripts.read(agent.id, {
					sessionFile: agent.sessionFile,
					settled: kind === "follow" ? settled : undefined,
					restart: kind === "restart",
				});
				if (version !== generation.current) return;
				if (tabId) withSessionRuntime(tabId, () => registerTranscriptToolCalls(agent.id, read.incoming));
				else registerTranscriptToolCalls(agent.id, read.incoming);
				setState(prev => {
					const hasMore = read.incoming.length > 0;
					if (
						read.messages === prev.messages &&
						hasMore === prev.hasMore &&
						!prev.loading &&
						!prev.busy &&
						prev.error === null
					) {
						return prev;
					}
					return { loading: false, busy: false, messages: read.messages, hasMore, error: null };
				});
			} catch (cause) {
				if (version === generation.current) {
					const error = cause instanceof Error ? cause.message : String(cause);
					setState(prev => ({ ...prev, loading: false, busy: false, hasMore: false, error }));
				}
			} finally {
				if (version === generation.current) loadingRef.current = false;
			}
		},
		[agent.id, agent.sessionFile, settled, tabId, transcripts],
	);

	// A new agent or tab starts the view over from what this tab holds.
	useEffect(() => {
		generation.current++;
		loadingRef.current = false;
		const held = transcripts.held(agent.id);
		setState(heldPage(held));
		// What another view or a replay already read: its tool calls are this tab's too.
		if (held) {
			if (tabId) withSessionRuntime(tabId, () => registerTranscriptToolCalls(agent.id, held.messages));
			else registerTranscriptToolCalls(agent.id, held.messages);
		}
		return () => {
			generation.current++;
		};
	}, [agent.id, transcripts, tabId]);

	// Follow a running agent: a progress frame moved its clock, or the interval fired while the window is shown.
	const progressMark = `${agent.status}:${agent.lastUpdate}:${agent.progress?.requests ?? 0}:${agent.progress?.toolCount ?? 0}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: progressMark is the trigger, not a value read.
	useEffect(() => {
		void load("follow");
	}, [progressMark, load]);
	useEffect(() => {
		if (!live) return;
		return pollWhileVisible(() => void load("follow"), FOLLOW_INTERVAL_MS);
	}, [live, load]);

	// One object per change, so the memoized transcript skips a render that changed none of it.
	return useMemo(
		() => ({
			loading: state.loading,
			busy: state.busy,
			messages: state.messages,
			error: state.error,
			hasMore: state.hasMore && !live,
			loadMore: () => void load("more"),
			reload: () => void load("restart"),
		}),
		[state, live, load],
	);
}
