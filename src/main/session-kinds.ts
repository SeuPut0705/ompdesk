/**
 * GUI-side record of which sessions are tool-free chats. Stock omp has no
 * session kind: a chat tab is just omp spawned with `--no-tools`, so the GUI
 * remembers the ids of the sessions its chat tabs created. Sessions written by
 * the old forked agent carry `kind: "chat"` in their header and need no entry.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

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
			mkdirSync(dirname(this.#file), { recursive: true });
			const temp = `${this.#file}.tmp`;
			writeFileSync(temp, JSON.stringify({ chat: [...chat] }));
			renameSync(temp, this.#file);
		} catch (err) {
			console.warn(
				`[session-kinds] could not persist ${this.#file}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
