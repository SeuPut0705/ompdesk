/**
 * What a paired device read of its hosts' transcripts, kept on its disk so each read crosses the link once per change.
 *
 * A device's renderer holds a tab's subagent transcripts and tail page in memory only, so every relaunch, window reload
 * and session switch read every replayed agent's journal whole again (on 30 Oct 2026 the subagent journals of a day
 * were 42 MB deflated read once, and a relaunch read them again). `RemoteSidecar` answers those reads from here and
 * asks the host only for what follows. The folder, its files and the rules (a journal kept as the host's segments with
 * their `tail`, a tail page with its `version`, one read of a key at a time, the bound `TRANSCRIPT_CACHE_BYTES` with the
 * least recently read going first) are the core's (`remotebytes/transcripts.rs`); the host is asked here, over the link.
 */
import type { RpcResponse } from "../../shared/rpc-types";
import { core } from "../core/process";
import { askingCall } from "./bytes-asks";

/** The folder's bound: a few weeks of a heavy user's subagents without their pictures (those are `ImageBlobCache`'s). */
export const TRANSCRIPT_CACHE_BYTES = 128 * 1024 * 1024;

/** Asks the host for the journal from `fromByte`; `knownTail` is the tail this device kept there. */
export type JournalFetch = (fromByte: number, knownTail?: string) => Promise<RpcResponse>;

export class TranscriptCache {
	readonly #dir: string;
	readonly #limit: number;

	constructor(dir: string, limitBytes = TRANSCRIPT_CACHE_BYTES) {
		this.#dir = dir;
		this.#limit = limitBytes;
	}

	/**
	 * A journal read from `fromByte` as the renderer asked it: from the start, the messages this device kept and what
	 * the host added since; from where this device stopped, what the host added. Any other offset (a renderer ahead of
	 * a trimmed copy) goes to the host as asked. The answer is the host's own when it started over or failed.
	 */
	async readJournal(key: string, fromByte: number, fetch: JournalFetch): Promise<RpcResponse> {
		let fetched: RpcResponse | undefined;
		const { held } = await askingCall<{ held: unknown[] | null }>(
			"remotebytes.readJournal",
			{ dir: this.#dir, limit: this.#limit, key, fromByte },
			async ask => {
				const knownTail = typeof ask.knownTail === "string" ? ask.knownTail : undefined;
				fetched = await fetch(Number(ask.fromByte), knownTail);
				return fetched.success ? { data: fetched.data } : {};
			},
		);
		if (!fetched) throw new Error("The transcript cache asked the host nothing");
		if (!held || !fetched.success) return fetched;
		const read = fetched.data as { messages: unknown[] };
		return { ...fetched, data: { ...read, fromByte: 0, reset: false, messages: [...held, ...read.messages] } };
	}

	/** The tail page kept for `key`, with the version it was read at. */
	async page(key: string): Promise<{ version: string; page: object } | null> {
		try {
			return (
				await core().call<{ version: string; page: object } | null>("remotebytes.page", { dir: this.#dir, key })
			).result;
		} catch {
			return null;
		}
	}

	/** Keeps the tail page read at `version` for `key`, replacing the last. */
	async keepPage(key: string, version: string, page: object): Promise<void> {
		await core()
			.call("remotebytes.keepPage", { dir: this.#dir, limit: this.#limit, key, version, page })
			.catch(() => {
				// The core is gone: the page is read from the host again next time.
			});
	}
}
