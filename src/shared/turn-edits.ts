/**
 * A session's current (or last) turn's file-changing calls, cut from its transcript on the computer it runs on
 * (`get_turn_edits`, local/sessions.ts; a closed session's saved file, agent-control/service.ts), and what the sessions
 * one session opened changed (`agent_control_family_edits`). The opener's work board counts them with the work card's
 * own rule (`workOutcomes`), so a child's edits read as the child's card would, never through git.
 */
import type { AgentMessage, RpcGitUnlanded } from "./rpc-types";

/** The tools that write files (stock names); a bash edit is not one of them. */
export const TURN_EDIT_TOOLS: readonly string[] = ["write", "edit", "ast_edit", "apply_patch"];

export interface RpcTurnEdits {
	/** The session's folder, which relative paths in its calls are under. */
	cwd: string;
	/** When the prompt that started the turn arrived (epoch ms); null when it lies beyond what was read. */
	startedAt: number | null;
	/** Its newest message (epoch ms): a finished turn's end. */
	endedAt: number | null;
	/** The turn's assistant messages cut to their file-changing calls, and those calls' results. */
	messages: AgentMessage[];
}

/** A prompt that starts a turn; a steer joins the running one. */
export function isTurnPrompt(message: AgentMessage): boolean {
	return message.role === "user" && message.steering !== true;
}

function epochMs(timestamp: string | number | undefined): number | null {
	const value = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The newest turn of `messages` (from its last prompt, or all of them when none is there), cut to its edit calls. */
export function turnEdits(messages: readonly AgentMessage[], cwd: string): RpcTurnEdits {
	const at = messages.findLastIndex(isTurnPrompt);
	const prompt = at >= 0 ? messages[at] : undefined;
	const turn = messages.slice(at + 1);
	const calls = new Set<string>();
	const edits: AgentMessage[] = [];
	for (const message of turn) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const blocks = message.content.filter(
				block => block.type === "toolCall" && TURN_EDIT_TOOLS.includes(block.name),
			);
			if (blocks.length === 0) continue;
			for (const block of blocks) if (block.type === "toolCall") calls.add(block.id);
			edits.push({ role: "assistant", content: blocks, timestamp: message.timestamp });
		} else if (message.role === "toolResult" && message.toolCallId && calls.has(message.toolCallId)) {
			edits.push(message);
		}
	}
	return {
		cwd,
		startedAt: prompt ? epochMs(prompt.timestamp) : null,
		endedAt: epochMs(turn.at(-1)?.timestamp ?? prompt?.timestamp),
		messages: edits,
	};
}

/** A `get_turn_edits` answer (anything else, from an older host, says nothing). */
export function isTurnEdits(data: unknown): data is RpcTurnEdits {
	return !!data && typeof data === "object" && Array.isArray((data as RpcTurnEdits).messages);
}

/** A `get_git_unlanded` answer that names files. */
export function isGitUnlanded(data: unknown): data is RpcGitUnlanded {
	return !!data && typeof data === "object" && Array.isArray((data as RpcGitUnlanded).files);
}

/** One session the board's session opened, open or closed after its work landed, with what it changed. */
export interface FamilyMemberEdits {
	/** Its session file, else its tab id. */
	key: string;
	title: string;
	/** Running or waiting on an answer: its turn counts whenever it started. */
	live: boolean;
	/** The paired device it runs on; absent = the computer that answered. */
	device?: string;
	/** Its newest turn's edit calls; null while its omp cannot say (starting, an older host). */
	edits: RpcTurnEdits | null;
	/** What its worktree branch has not landed; null without a worktree or a branch to read. */
	unlanded: RpcGitUnlanded | null;
}

/** What `agent_control_family_edits` answers. */
export interface FamilyEdits {
	members: FamilyMemberEdits[];
}
