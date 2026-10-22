/**
 * GUI-side record of which sessions are chats, so the sidebar lists them in
 * its Chats section. Stock omp has no session kind: a chat tab is plain omp with
 * its full tool set, started in the GUI's default workspace, so the GUI
 * remembers the ids of the sessions its chat tabs created. Sessions written by
 * the old forked agent carry `kind: "chat"` in their header and need no entry.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomicSync } from "./atomic-file";

const StoredKinds = z.object({ chat: z.array(z.string()) });

export class SessionKindStore {
	readonly #file: string;
	#chat: Set<string> | null = null;

	constructor(file: string) {
		this.#file = file;
	}

	#load(): Set<string> {
		if (this.#chat) return this.#chat;
		try {
			this.#chat = new Set(StoredKinds.parse(JSON.parse(readFileSync(this.#file, "utf8"))).chat);
		} catch {
			this.#chat = new Set();
		}
		return this.#chat;
	}

	isChat(sessionId: string): boolean {
		return this.#load().has(sessionId);
	}

	/** Record a chat session id; persisted atomically, failures only lose the label. */
	markChat(sessionId: string): void {
		const chat = this.#load();
		if (chat.has(sessionId)) return;
		chat.add(sessionId);
		try {
			writeFileAtomicSync(this.#file, JSON.stringify({ chat: [...chat] }));
		} catch (err) {
			console.warn(
				`[session-kinds] could not persist ${this.#file}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
