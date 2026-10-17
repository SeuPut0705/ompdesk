/**
 * One subagent's transcript, read through the owning tab's runtime by byte
 * offset (`get_subagent_messages`). Loaded pages also feed the tool-call
 * ownership registry so nested spawn edges resolve progressively. A running
 * agent is followed: a progress frame (its `lastUpdate` moves) or the poll
 * below asks for what is new, and a page with nothing new changes nothing, so
 * an idle agent re-renders no row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import { useTabRpc } from "../../lib/tab-rpc";
import { useRuntimeTabId, withSessionRuntime } from "../../stores/session-runtime-context";
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
	nextByte: number;
	hasMore: boolean;
	error: string | null;
}

const INITIAL: PageState = { loading: true, busy: false, messages: [], nextByte: 0, hasMore: true, error: null };

/** The same transcript again: as long, ending on the same message. */
function sameTail(shown: readonly AgentMessage[], reread: readonly AgentMessage[]): boolean {
	const last = reread.at(-1);
	return (
		shown.length === reread.length &&
		(last === undefined || (shown.at(-1)?.timestamp === last.timestamp && shown.at(-1)?.role === last.role))
	);
}

export function useSubagentTranscript(agent: SubagentSnapshot): SubagentTranscriptState {
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const live = isLiveSubagentStatus(agent.status);
	const generation = useRef(0);
	const loadingRef = useRef(false);
	const [state, setState] = useState<PageState>(INITIAL);
	// The next offset a follow-up reads from, without making `load` depend on a render.
	const nextByteRef = useRef(0);
	nextByteRef.current = state.nextByte;

	/** `quiet`: a follow-up of a running agent, which shows no spinner and changes nothing when nothing is new. */
	const load = useCallback(
		async (fromByte: number, quiet = false) => {
			if (loadingRef.current) return;
			loadingRef.current = true;
			const version = generation.current;
			if (!quiet) setState(prev => ({ ...prev, busy: true, error: null }));
			try {
				const response = await rpc.getSubagentMessages(agent.id, agent.sessionFile, fromByte);
				if (version !== generation.current) return;
				if (!response.success) {
					setState(prev => ({ ...prev, loading: false, busy: false, hasMore: false, error: response.error }));
					return;
				}
				const data = response.data as { messages?: AgentMessage[]; nextByte?: number; reset?: boolean };
				const incoming = data.messages ?? [];
				if (tabId) withSessionRuntime(tabId, () => registerTranscriptToolCalls(agent.id, incoming));
				else registerTranscriptToolCalls(agent.id, incoming);
				setState(prev => {
					const replace = data.reset || fromByte === 0;
					const messages = replace
						? !data.reset && sameTail(prev.messages, incoming)
							? prev.messages
							: incoming
						: incoming.length === 0
							? prev.messages
							: [...prev.messages, ...incoming];
					const nextByte = data.nextByte ?? fromByte;
					const hasMore = incoming.length > 0;
					if (
						messages === prev.messages &&
						nextByte === prev.nextByte &&
						hasMore === prev.hasMore &&
						!prev.loading &&
						!prev.busy &&
						prev.error === null
					) {
						return prev;
					}
					return { loading: false, busy: false, messages, nextByte, hasMore, error: null };
				});
			} catch (cause) {
				if (version === generation.current) {
					setState(prev => ({ ...prev, loading: false, busy: false, error: String(cause) }));
				}
			} finally {
				if (version === generation.current) loadingRef.current = false;
			}
		},
		[agent.id, agent.sessionFile, rpc.getSubagentMessages, tabId],
	);

	useEffect(() => {
		generation.current++;
		loadingRef.current = false;
		setState(INITIAL);
		void load(0);
		return () => {
			generation.current++;
		};
	}, [load]);

	// Follow a running agent: a progress frame moved its clock, or the interval fired.
	const progressMark = `${agent.status}:${agent.lastUpdate}:${agent.progress?.requests ?? 0}:${agent.progress?.toolCount ?? 0}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: progressMark is the trigger, not a value read.
	useEffect(() => {
		void load(nextByteRef.current, true);
	}, [progressMark]);
	useEffect(() => {
		if (!live) return;
		const timer = window.setInterval(() => void load(nextByteRef.current, true), FOLLOW_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [live, load]);

	// One object per change, so the memoized transcript skips a render that changed none of it.
	return useMemo(
		() => ({
			loading: state.loading,
			busy: state.busy,
			messages: state.messages,
			error: state.error,
			hasMore: state.hasMore && !live,
			loadMore: () => void load(state.nextByte),
			reload: () => void load(0),
		}),
		[state, live, load],
	);
}
