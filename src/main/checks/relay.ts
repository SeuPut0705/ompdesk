/**
 * Check control's relay to the pages: it watches the hub and sends every window and paired phone's page one frame
 * (`src/shared/checks-frame.ts`) at each change: the hub's snapshot as it is, beside it the names main knows for the
 * ids in it, and whether the hub can be reached. It decides nothing and holds no check state of its own. The person's
 * one control, Pause admission, goes through it to the hub; the hub's next snapshot carries the answer back.
 *
 * Until a hub answers there is no frame, and the pages draw nothing of check control. A hub that is lost (the core
 * ended) leaves its last frame marked `lost` until the next snapshot, so nothing old reads as current.
 */
import type { ChecksHub, Snapshot } from "../../shared/checks-contract";
import type { ChecksFrame, ChecksNames } from "../../shared/checks-frame";

export interface ChecksRelayDeps {
	hub: Pick<ChecksHub, "watch" | "pause">;
	/** The names main knows for the ids of a snapshot, read when it is sent. */
	names(snapshot: Snapshot): ChecksNames | Promise<ChecksNames>;
	/** Sends the frame to every window and page. */
	send(frame: ChecksFrame): void;
	/** Tells when the hub cannot be reached any more; returns the unsubscribe. */
	onLost(listener: () => void): () => void;
}

const NO_NAMES: ChecksNames = { devices: {}, sessions: {}, goals: {} };

export class ChecksRelay {
	readonly #deps: ChecksRelayDeps;
	#frame: ChecksFrame | null = null;
	/** Counts snapshots, so names read for an older one never replace a newer frame. */
	#seen = 0;

	constructor(deps: ChecksRelayDeps) {
		this.#deps = deps;
	}

	/** The frame a window that mounts later reads. */
	current(): ChecksFrame | null {
		return this.#frame;
	}

	setPaused(paused: boolean): Promise<void> {
		return this.#deps.hub.pause(paused);
	}

	/** Starts relaying; returns the stop. */
	start(): () => void {
		const unwatch = this.#deps.hub.watch(snapshot => void this.#show(snapshot));
		const unlost = this.#deps.onLost(() => {
			this.#seen += 1;
			if (this.#frame?.hub === "live") this.#set({ ...this.#frame, hub: "lost" });
		});
		return () => {
			unwatch();
			unlost();
		};
	}

	async #show(snapshot: Snapshot): Promise<void> {
		this.#seen += 1;
		const seen = this.#seen;
		// A name is a convenience: a snapshot is shown without names rather than not at all.
		const names = await Promise.resolve(this.#deps.names(snapshot)).catch(() => NO_NAMES);
		if (seen === this.#seen) this.#set({ snapshot, names, hub: "live" });
	}

	#set(frame: ChecksFrame): void {
		this.#frame = frame;
		this.#deps.send(frame);
	}
}

/** What main knows of the computers and sessions a snapshot may name. */
export interface NameSources {
	/** This computer, as origins and device pools write it. */
	here: { id: string; name: string };
	hosts: readonly { deviceId: string; name: string }[];
	sessions: readonly { id: string; title: string | null; autoTitle?: string }[];
}

/** The names of the ids a snapshot holds, and of no other (a frame never carries the whole session list). */
export function namesFor(snapshot: Snapshot, sources: NameSources): ChecksNames {
	const names: ChecksNames = { devices: {}, sessions: {}, goals: {} };
	const device = (id: string) => {
		if (id === sources.here.id) names.devices[id] = { name: sources.here.name, here: true };
		else {
			const host = sources.hosts.find(entry => entry.deviceId === id);
			if (host) names.devices[id] = { name: host.name };
		}
	};
	const origin = (value: Snapshot["runs"][number]["origin"]) => {
		if (value.kind !== "session") return;
		device(value.device);
		const session = sources.sessions.find(entry => entry.id === value.session);
		const title = session?.title ?? session?.autoTitle;
		if (title) names.sessions[value.session] = { title };
	};
	for (const pool of snapshot.pools) if (pool.where.kind === "device") device(pool.where.deviceId);
	for (const run of snapshot.runs) origin(run.origin);
	for (const result of snapshot.answers) origin(result.origin);
	for (const test of snapshot.trends.tests) if (test.quarantinedBy) origin(test.quarantinedBy);
	return names;
}
