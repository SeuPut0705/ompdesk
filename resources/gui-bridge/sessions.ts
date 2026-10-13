/**
 * Live-session tree operations stock RPC does not expose: entry labels, in-place
 * leaf moves (`navigateTree`), an independent copy of one branch, and session
 * pins under omp's own cross-process lock.
 */
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { guard } from "./health";
import { attachEntryIds, buildTranscript, flattenSessionTree } from "./session-display";
import { setSessionPinned } from "./session-pins";
import { transcriptTurnStart } from "./transcript-page";
import type { BridgeMethods } from "./types";

function param(params: unknown, key: string): unknown {
	return typeof params === "object" && params !== null && key in params ? params[key] : undefined;
}

function entryIdParam(params: unknown): string {
	const entryId = param(params, "entryId");
	if (typeof entryId !== "string" || !entryId.trim()) throw new Error("Entry id cannot be empty");
	return entryId.trim();
}

function optionalString(params: unknown, key: string): string | undefined {
	const value = param(params, key);
	return typeof value === "string" ? value : undefined;
}

/**
 * The last stock replay of this process's session, reused while the journal is
 * unchanged: a transcript walk asks page by page, and each page must cost a
 * slice, not a replay. Pages keep every bridge reply small, since one socket
 * carries every bridge request in order and a whole long transcript (tens of
 * MB) would hold up the rest behind it.
 */
let replay: { key: string; snapshot: ReturnType<typeof buildTranscript> } | undefined;

function transcriptSnapshot(manager: SessionManager): ReturnType<typeof buildTranscript> {
	const entries = manager.getEntries();
	const key = [
		manager.getSessionFile() ?? "",
		entries.length,
		entries.at(-1)?.id ?? "",
		manager.getLeafId() ?? "",
	].join("\0");
	if (replay?.key !== key) replay = { key, snapshot: buildTranscript(manager) };
	return replay.snapshot;
}

function pageNumber(params: unknown, key: string, fallback: number): number {
	const value = param(params, key);
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export const methods: BridgeMethods = {
	// stream-metadata is imported per call, not statically: a vanished read/URL
	// export then fails only these two (feature streamMetadata), not the tree.
	...guard(["sessionTree", "streamMetadata"], {
		"sessions.transcript": async (params, env) => {
			const { decorateMessages } = await import("./stream-metadata");
			const { leafId, messages } = transcriptSnapshot(env.session().sessionManager);
			let offset = Math.min(pageNumber(params, "offset", 0), messages.length);
			const end = Math.min(messages.length, offset + pageNumber(params, "limit", messages.length));
			// A page starts with the user's turn, never with an orphan tool result
			// or an assistant step whose call/read group is on the preceding page.
			if (param(params, "snapToTurn") === true) offset = transcriptTurnStart(messages, offset, end);
			return {
				leafId,
				total: messages.length,
				startIndex: offset,
				messages: decorateMessages(messages.slice(offset, end)),
			};
		},
		"sessions.attach_entry_ids": async (params, env) => {
			const messages = param(params, "messages");
			if (
				!Array.isArray(messages) ||
				messages.some(
					message => typeof message !== "object" || message === null || typeof message.role !== "string",
				)
			) {
				throw new Error("Messages must be an array of agent messages");
			}
			const { decorateMessages } = await import("./stream-metadata");
			const entries = env.session().sessionManager.getEntries();
			return { messages: decorateMessages(attachEntryIds(messages as AgentMessage[], entries)) };
		},
	}),
	...guard("sessionTree", {
		"sessions.tree": async (_params, env) => {
			const manager = env.session().sessionManager;
			return flattenSessionTree(
				manager.getTree(),
				manager.getLeafId() === null ? [] : manager.getBranch(),
				entryId => manager.getLabel(entryId),
			);
		},
		/** Called only after stock new_session succeeds. Never delete the new active file. */
		"sessions.delete": async (params, env) => {
			const sessionPath = optionalString(params, "sessionPath");
			if (!sessionPath || !path.isAbsolute(sessionPath) || !sessionPath.endsWith(".jsonl")) {
				throw new Error("Invalid session path");
			}
			const target = path.resolve(sessionPath);
			const active = env.session().sessionManager.getSessionFile();
			if (active && target === path.resolve(active)) throw new Error("Cannot delete the active session");
			await new FileSessionStorage().deleteSessionWithArtifacts(target);
			return null;
		},

		/** Set (non-empty `label`) or clear a label on any entry; TUI tree-selector Shift+L. */
		"sessions.set_entry_label": async (params, env) => {
			const entryId = entryIdParam(params);
			const label = optionalString(params, "label")?.trim() || undefined;
			const manager = env.session().sessionManager;
			manager.appendLabelChange(entryId, label);
			return null;
		},

		/** Move the active leaf in place (TUI tree-selector Enter); optionally summarize the abandoned branch. */
		"sessions.switch_leaf": async (params, env) => {
			const entryId = entryIdParam(params);
			const session = env.session();
			if (session.isStreaming) throw new Error("Session is busy (streaming)");
			const result = await session.navigateTree(entryId, {
				summarize: param(params, "summarize") === true,
				customInstructions: optionalString(params, "customInstructions"),
			});
			if (result.cancelled || result.aborted) {
				return {
					cancelled: result.cancelled,
					aborted: result.aborted,
					editorText: result.editorText,
					editorImages: result.editorImages,
				};
			}
			return {
				cancelled: false,
				editorText: result.editorText,
				editorImages: result.editorImages,
				activeLeafId: session.sessionManager.getLeafId() ?? undefined,
			};
		},

		/**
		 * Write a new, independent session holding only the root→`entryId` path and
		 * leave the live session where it is (omp's own `fork`/`branch` move the live
		 * session onto the copy). Labels in effect on the path and the title carry over.
		 */
		"sessions.fork_from": async (params, env) => {
			const entryId = entryIdParam(params);
			const live = env.session().sessionManager;
			const sourceFile = live.getSessionFile();
			if (!sourceFile) throw new Error("Session is not persisting — cannot create a session from here");
			const sessionDir = live.getSessionDir();
			const cwd = live.getCwd();
			await live.flush();
			const copy = await SessionManager.open(sourceFile, sessionDir, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
				initialCwd: cwd,
			});
			try {
				const sessionPath = copy.createBranchedSession(entryId, { copyArtifacts: true });
				if (!sessionPath) throw new Error("omp did not persist the new session");
				await copy.flush();
				return { sessionPath, sessionId: copy.getSessionId() };
			} finally {
				await copy.close();
			}
		},

		"sessions.set_pinned": async params => {
			const sessionId = optionalString(params, "sessionId")?.trim();
			if (!sessionId) throw new Error("Session id cannot be empty");
			return { pinned: await setSessionPinned(sessionId, param(params, "pinned") === true) };
		},
	}),
};
