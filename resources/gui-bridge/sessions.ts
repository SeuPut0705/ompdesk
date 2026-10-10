/**
 * Live-session tree operations stock RPC does not expose: entry labels, in-place
 * leaf moves (`navigateTree`), an independent copy of one branch, and session
 * pins under omp's own cross-process lock.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadPinnedSessionIds } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { getAgentDir, withFileLock } from "@oh-my-pi/pi-utils";
import { guard } from "./health";
import { attachEntryIds, buildTranscript, flattenSessionTree } from "./session-display";
import { decorateMessages } from "./stream-metadata";
import type { BridgeMethods } from "./types";

/** omp's pins file (session/session-pins.ts): a JSON array of session ids. */
const PINS_FILENAME = "session-pins.json";

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

export const methods: BridgeMethods = guard("sessionTree", {
	...guard("streamMetadata", {
		"sessions.transcript": async (_params, env) => {
			const snapshot = buildTranscript(env.session().sessionManager);
			return { ...snapshot, messages: decorateMessages(snapshot.messages) };
		},
		"sessions.attach_entry_ids": async (params, env) => {
			const messages = param(params, "messages");
			if (
				!Array.isArray(messages) ||
				messages.some(message => typeof message !== "object" || message === null || typeof message.role !== "string")
			) {
				throw new Error("Messages must be an array of agent messages");
			}
			const entries = env.session().sessionManager.getEntries();
			return { messages: decorateMessages(attachEntryIds(messages as AgentMessage[], entries)) };
		},
	}),
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

	/**
	 * Keep_better than stock toggleSessionPin: assigning the requested boolean is
	 * retry-safe under the same cross-process lock; load-then-toggle is not atomic.
	 */
	"sessions.set_pinned": async params => {
		const sessionId = optionalString(params, "sessionId")?.trim();
		if (!sessionId) throw new Error("Session id cannot be empty");
		const pinned = param(params, "pinned") === true;
		const agentDir = getAgentDir();
		const filePath = path.join(agentDir, PINS_FILENAME);
		await fs.mkdir(agentDir, { recursive: true });
		return withFileLock(filePath, async () => {
			const pins = await loadPinnedSessionIds(agentDir);
			if (pins.has(sessionId) === pinned) return { pinned };
			if (pinned) pins.add(sessionId);
			else pins.delete(sessionId);
			const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
			try {
				await fs.writeFile(tmpPath, JSON.stringify([...pins], null, "\t"), { encoding: "utf-8", mode: 0o600 });
				await replaceFileAtomically(tmpPath, filePath);
			} catch (error) {
				await fs.rm(tmpPath, { force: true }).catch(() => {});
				throw error;
			}
			return { pinned };
		});
	},
});
