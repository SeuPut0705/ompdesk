/**
 * What main tells the checks hub that the hub cannot read itself (`MainFact`, `checks.runners`): how gh and git run,
 * the GitHub repositories of the sidebar's projects, which session each process tag belongs to, and each paired
 * computer's heavy pool or that its link is lost. Each is sent when it changes, never twice the same, and all of it
 * again for a hub that started over (the core ended), since a new hub knows nothing.
 *
 * Paired computers are read every `PAIRED_POOL_EVERY_MS` and when a link comes up: a computer answers its own pool
 * as its hub reads it (`checks.localPool` over the link), and this computer files it under that computer's device id.
 */
import type { LocalPool, MainFact, Origin } from "../../shared/checks-contract";
import type { RemoteLinkState } from "../../shared/ipc-types";
import type { CoreRunner } from "../local/git/exec";

/** How often a paired computer's pool is read while its link is up. */
export const PAIRED_POOL_EVERY_MS = 15_000;

export interface Runners {
	gh: CoreRunner | null;
	git: CoreRunner | null;
	home: string;
}

/** A tab's process tag and its session file, as `SessionProcesses.owners` lists them. */
export interface TaggedSession {
	tag: string;
	sessionPath?: string;
}

export interface ChecksFactsDeps {
	hub: {
		told(fact: MainFact): Promise<void>;
		runners(gh: CoreRunner | null, git: CoreRunner | null, home: string): Promise<void>;
	};
	runners(): Promise<Runners>;
	/** The folders of the sidebar's projects. */
	projects(): readonly string[];
	/** A folder's `origin` remote URL; null when it has none or is no repository. */
	originUrl(folder: string): Promise<string | null>;
	sessions(): readonly TaggedSession[];
	hosts(): readonly { deviceId: string; state: RemoteLinkState }[];
	/** A paired computer's pool as it reads it; null when it cannot say (an older build, a link that dropped). */
	hostPool(deviceId: string): Promise<LocalPool | null>;
	log(message: string, details: Record<string, string | number | boolean>): void;
}

/** The saved id of a session file (stock names one `<time>_<id>.jsonl`). */
export function savedIdOfPath(path: string): string | null {
	return /_([^_/\\]+)\.jsonl$/.exec(path)?.[1] ?? null;
}

/** `owner/name` of a GitHub remote URL, as the URL spells it; null for any other host. */
export function githubRepoOf(url: string): string | null {
	const match =
		/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
			url.trim(),
		);
	return match ? `${match[1]}/${match[2]}` : null;
}

/** Which session each tag is (a tag whose tab has no session file yet names none and is left out). */
export function sessionTags(sessions: readonly TaggedSession[]): Record<string, Origin> {
	const tags: Record<string, Origin> = {};
	for (const { tag, sessionPath } of sessions) {
		const session = sessionPath ? savedIdOfPath(sessionPath) : null;
		if (session) tags[tag] = { kind: "session", session, device: "local" };
	}
	return tags;
}

export class ChecksFacts {
	readonly #deps: ChecksFactsDeps;
	/** What the hub was last told, by kind (and by device for pools): a repeat is not sent. */
	readonly #sent = new Map<string, string>();
	/** The last failure logged, by what failed. */
	readonly #failures = new Map<string, string>();
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(deps: ChecksFactsDeps) {
		this.#deps = deps;
	}

	/** Tells the hub everything now and reads the paired computers on a timer; returns the stop. */
	start(): () => void {
		this.#everything();
		this.#timer = setInterval(() => this.hostsChanged(), PAIRED_POOL_EVERY_MS);
		return () => {
			clearInterval(this.#timer ?? undefined);
			this.#timer = null;
		};
	}

	/** The hub started over (a new core): it knows nothing, so it hears everything again. */
	hubLost(): void {
		this.#sent.clear();
		this.#everything();
	}

	runnersChanged(): void {
		void this.#deps
			.runners()
			.then(({ gh, git, home }) =>
				this.#send(`runners`, JSON.stringify([gh !== null, git !== null, home]), () =>
					this.#deps.hub.runners(gh, git, home),
				),
			)
			.catch(error => this.#failed("runners", error));
	}

	reposChanged(): void {
		void Promise.all(
			this.#deps.projects().map(folder =>
				this.#deps
					.originUrl(folder)
					.then(url => (url ? githubRepoOf(url) : null))
					.catch(() => null),
			),
		).then(found => {
			const repos = [...new Set(found.filter((repo): repo is string => repo !== null))].sort();
			this.#tell("repos", { kind: "repos", repos });
		});
	}

	sessionsChanged(): void {
		this.#tell("sessions", { kind: "sessions", tags: sessionTags(this.#deps.sessions()) });
	}

	/** A link came up or went down, or it is time to read the pools again. */
	hostsChanged(): void {
		for (const host of this.#deps.hosts()) {
			if (host.state !== "online") {
				// A link never seen up says nothing: the hub has no pool of that computer to take back.
				if (this.#sent.has(`pool:${host.deviceId}`))
					this.#tell(`pool:${host.deviceId}`, { kind: "deviceOffline", device: host.deviceId });
				continue;
			}
			void this.#deps
				.hostPool(host.deviceId)
				.then(pool => {
					if (pool)
						this.#tell(`pool:${host.deviceId}`, {
							kind: "devicePool",
							pool: { ...pool, device: host.deviceId, offline: false },
						});
				})
				.catch(error => this.#failed("devicePool", error));
		}
	}

	#everything(): void {
		this.runnersChanged();
		this.reposChanged();
		this.sessionsChanged();
		this.hostsChanged();
	}

	#tell(key: string, fact: MainFact): void {
		// A pool carries when it was read, so every read is new: the hub tells a stale pool by it.
		this.#send(key, JSON.stringify(fact), () => this.#deps.hub.told(fact));
	}

	#send(key: string, signature: string, send: () => Promise<void>): void {
		if (this.#sent.get(key) === signature) return;
		this.#sent.set(key, signature);
		send().then(
			() => this.#failures.delete(key),
			error => {
				// Not told: the next change, or the next hub, tries again.
				if (this.#sent.get(key) === signature) this.#sent.delete(key);
				this.#failed(key, error);
			},
		);
	}

	#failed(what: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		// One line per failure, not one per read: a hub that cannot take facts yet refuses every one alike.
		if (this.#failures.get(what) === message) return;
		this.#failures.set(what, message);
		this.#deps.log("checks-fact-failed", { what, error: message });
	}
}
