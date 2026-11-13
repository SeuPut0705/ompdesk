/**
 * The previous builds' hashed `/assets/` files, served for a while after this computer updated OMPdesk, so a
 * paired page loaded before the update still finds the chunks it asks for. The archive lives in the core
 * (`crates/core/src/web/archive.rs`, which has the why and the how); this is its client: `retain` keeps the current
 * build and learns which replaced builds are served, `roots` lists them.
 */
import { core } from "../core/process";

/** How long a replaced build's assets stay served. */
export const ARCHIVE_RETAIN_MS = 7 * 24 * 60 * 60_000;
/** How many replaced builds are kept at most. */
export const ARCHIVE_MAX_PREVIOUS = 2;

/** The build a renderer folder holds: the hash of its `web.html` (it names that build's entry chunks); null without one. */
export async function buildIdOf(staticRoot: string): Promise<string | null> {
	return (await core().call<{ build: string | null }>("web.assets.buildId", { staticRoot })).result.build;
}

export class AssetArchive {
	readonly #userData: string;
	readonly #now: () => number;
	#roots: readonly string[] = [];
	/** The newest call's number and the newest answer applied: the core runs calls in the order they were made. */
	#made = 0;
	#applied = 0;

	constructor(opts: { userData: string; now?: () => number }) {
		this.#userData = opts.userData;
		this.#now = opts.now ?? Date.now;
	}

	/** Folders holding a replaced build's `assets/`, newest first, as the last `retain` left them. */
	roots(): readonly string[] {
		return this.#roots;
	}

	/**
	 * Keep the build in `staticRoot` for later (copied once), mark the others replaced, drop what is past the window or
	 * the count, and serve the rest. Never throws for a missing renderer folder (a dev run has none). Calls run one
	 * after another in the core.
	 */
	async retain(staticRoot: string): Promise<void> {
		const mine = ++this.#made;
		const { result } = await core().call<{ roots: string[] }>("web.assets.retain", {
			userData: this.#userData,
			staticRoot,
			now: this.#now(),
		});
		// Answers may come back in any order (the core's wire allows it, and a loaded machine does it): the last call
		// made holds the archive's last state, so an older call's answer never replaces a newer one's.
		if (mine < this.#applied) return;
		this.#applied = mine;
		this.#roots = result.roots;
	}
}
