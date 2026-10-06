/**
 * Live-session tree operations stock RPC does not expose: entry labels, in-place
 * leaf moves (`navigateTree`), an independent copy of one branch, and session
 * pins under omp's own cross-process lock.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { copySessionArtifacts, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadPinnedSessionIds } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { getAgentDir, withFileLock } from "@oh-my-pi/pi-utils";
import { methods as extras } from "./session-extras";
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

export const methods: BridgeMethods = {
	...extras,

	/** Set (non-empty `label`) or clear a label on any entry; TUI tree-selector Shift+L. */
	"sessions.set_entry_label": async (params, env) => {
		const entryId = entryIdParam(params);
		const label = optionalString(params, "label")?.trim() || undefined;
		const manager = env.session().sessionManager;
		if (typeof manager.appendLabelChange !== "function") throw new Error("This omp cannot label entries");
		manager.appendLabelChange(entryId, label);
		return null;
	},

	/** Move the active leaf in place (TUI tree-selector Enter); optionally summarize the abandoned branch. */
	"sessions.switch_leaf": async (params, env) => {
		const entryId = entryIdParam(params);
		const session = env.session();
		if (typeof session.navigateTree !== "function") throw new Error("This omp cannot navigate the session tree");
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
		const branch = live.getBranch(entryId);
		if (branch.at(-1)?.id !== entryId) throw new Error(`Entry ${entryId} not found`);

		const copy = SessionManager.create(live.getCwd(), live.getSessionDir());
		await copy.newSession({ parentSession: sourceFile, additionalDirectories: live.getAdditionalDirectories() });
		try {
			for (const entry of branch) {
				if (entry.type !== "label") copy.ingestReplicatedEntry(structuredClone(entry));
			}
			for (const entry of branch) {
				const label = entry.type === "label" ? undefined : live.getLabel(entry.id);
				if (label) copy.appendLabelChange(entry.id, label);
			}
			const title = live.getSessionName();
			if (title) await copy.setSessionName(title, live.titleSource ?? "auto");
			await copy.flush();
		} finally {
			await copy.close();
		}
		const sessionPath = copy.getSessionFile();
		if (!sessionPath) throw new Error("omp did not persist the new session");
		await copySessionArtifacts(sourceFile, sessionPath);
		return { sessionPath, sessionId: copy.getSessionId() };
	},

	/** Pin or unpin a session id in omp's pins file; the same lock and atomic replace as omp's `/pin`. */
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
};
