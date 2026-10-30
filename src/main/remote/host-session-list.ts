/**
 * A paired host's session list as this computer keeps it: one numbered copy for every window and phone page here that
 * shows the host's section (`SessionListShare`), kept current from the host's `sessions.changed` events. A host that
 * sends what changed (`slimSessionLists`, `shared/session-list-delta.ts`) costs one small event per change and no read;
 * a change this copy cannot apply (a missed event, an older host's bare event) is read once, whoever asks first, and
 * every window here then gets what changed from it. Before, each window read the whole list from the host after every
 * change (128 KB of JSON on this Mac, 30 Oct 2026).
 */
import { z } from "zod";
import type { IpcSessionsChanged, SessionInfo } from "../../shared/ipc-types";
import {
	applySessionListDelta,
	compareSessionRows,
	olderSessionListVersion,
	type SessionListDelta,
	type VersionedSessionList,
} from "../../shared/session-list-delta";
import { SessionListShare } from "../session-list-share";

/** Rows cross as the host sent them; only the fields the copy and its order rest on are checked. */
const Row = z.object({ path: z.string(), modified: z.string() }).passthrough();
const VersionedReply = z.object({ version: z.string(), sessions: z.array(Row) });
const DeltaEvent = z.object({
	base: z.string(),
	version: z.string(),
	set: z.array(Row),
	remove: z.array(z.string()),
});

export interface HostSessionListDeps {
	/** The host's `sessions.list` read. */
	read: (params: { scope: "global"; versioned: true }) => Promise<unknown>;
	/** Tells this computer's windows (`SESSIONS_CHANGED` with this host's `device`). */
	broadcast: (change: IpcSessionsChanged) => void;
}

export class HostSessionList {
	readonly #device: string;
	readonly #deps: HostSessionListDeps;
	readonly #share: SessionListShare;
	/** The host's version the copy holds; null when the host numbers none (an older host) or nothing was read. */
	#hostVersion: string | null = null;
	#reads = 0;
	/** The newest host version a change announced while a read was under way. */
	#announced: string | null = null;

	constructor(device: string, deps: HostSessionListDeps) {
		this.#device = device;
		this.#deps = deps;
		this.#share = new SessionListShare(() => this.#read());
		this.#share.onChange = delta => deps.broadcast(delta ? { device, list: delta } : { device });
	}

	/** The whole list with this computer's version of it: the copy, or the one read every asker here shares. */
	current(): Promise<VersionedSessionList> {
		return this.#share.current();
	}

	/**
	 * The host's `sessions.changed`: a change of the version the copy holds is applied here; anything else (no copy, a
	 * missed change, an older host's bare event) makes the next ask read the host's list, once for every window.
	 */
	hostChanged(data: unknown): void {
		const delta = DeltaEvent.safeParse(data);
		const held = this.#share.held();
		if (delta.success && held && this.#hostVersion === delta.data.base) {
			this.#hostVersion = delta.data.version;
			const change = delta.data as unknown as Pick<SessionListDelta, "set" | "remove">;
			this.#share.set(applySessionListDelta(held.sessions, { set: this.#own(change.set), remove: change.remove }));
			return;
		}
		if (delta.success && this.#hostVersion === delta.data.version) return;
		// A read under way answers this change (the host answers after every event it sent before); checked when it lands.
		if (this.#reads > 0) {
			if (delta.success) this.#announced = delta.data.version;
			return;
		}
		this.stale();
	}

	/** The host's list may have changed unseen (the link came back, a change made through it): read it on the next ask. */
	stale(): void {
		this.#share.stale();
		this.#deps.broadcast({ device: this.#device });
	}

	async #read(): Promise<SessionInfo[]> {
		this.#reads++;
		try {
			const reply = await this.#deps.read({ scope: "global", versioned: true });
			const versioned = VersionedReply.safeParse(reply);
			// An older host answers the rows alone, in its own order.
			const rows = versioned.success ? versioned.data.sessions : z.array(Row).parse(reply);
			this.#hostVersion = versioned.success ? versioned.data.version : null;
			return this.#own(rows as unknown as SessionInfo[]).sort(compareSessionRows);
		} finally {
			this.#reads--;
			const announced = this.#announced;
			this.#announced = null;
			// The host published a later version in the moment between taking this answer and sending it.
			if (announced && this.#hostVersion && olderSessionListVersion(this.#hostVersion, announced))
				queueMicrotask(() => this.stale());
		}
	}

	/** Rows as this computer lists them: tagged with the host they live on. */
	#own(rows: readonly SessionInfo[]): SessionInfo[] {
		return rows.map(row => ({ ...row, device: this.#device }));
	}
}
