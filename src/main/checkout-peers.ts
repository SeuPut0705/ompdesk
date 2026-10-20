/**
 * Which live sessions of this computer share a git checkout, told to each of them (bridge modes/checkout-peers.ts,
 * contracts resources/gui-bridge/modes/checkout-peers-contracts.ts). Two scopes, as git has them: the worktree
 * (`--show-toplevel`: files, index, HEAD) and the repository (`--git-common-dir`: stash, branches, refs, shared by every
 * worktree of it). Each session hears the others of both, with the files the worktree's others changed lately (read
 * from their own bridges, `checkout_touched`), and whether it can message them.
 *
 * Members are this computer's own omps: the tabs of its windows and the tabs it runs for paired devices. A paired
 * host's tab is that host's to coordinate. A pass runs after tab activity and on a timer; a session hears only a change.
 */
import * as fs from "node:fs/promises";
import {
	CHECKOUT_PEERS_SET,
	CHECKOUT_TOUCHED,
	type CheckoutPeer,
	type CheckoutPeers,
} from "../../resources/gui-bridge/modes/checkout-peers-contracts";

/** One live omp on this computer. */
export interface CheckoutMember {
	/** Stable while the omp lives (a tab id, or the hosted tab's key). */
	key: string;
	/** The id the control tools address it by; null for a session run here for a paired device (its tools answer on that device). */
	id: string | null;
	title: string;
	cwd: string;
	sessionPath?: string;
	/** A paired device's name, for a session this computer runs for it. */
	device?: string;
	/** It has the OMPdesk control tools, so it can message the others. */
	canMessage: boolean;
	request(method: string, params?: unknown): Promise<unknown>;
}

export interface CheckoutPlace {
	toplevel: string;
	commonDir: string;
}

export interface CheckoutPeersDeps {
	members(): CheckoutMember[];
	/** The checkout a folder is in, or null outside a repository. */
	place(cwd: string): Promise<CheckoutPlace | null>;
	/** Session files the user hid from agents (Sidebar › hide from other agents). */
	hiddenPaths(): Set<string>;
	now?: () => number;
}

/** A folder's checkout is asked again after this (a `git worktree add` or a deleted checkout changes it). */
const PLACE_TTL_MS = 30_000;
const TOUCHED_TIMEOUT_MS = 2_000;
/** Besides tab activity, a pass runs this often: a tab that became ready, a hidden session or a new worktree moves no tab. */
export const CHECKOUT_PEERS_SWEEP_MS = 10_000;

export class CheckoutPeerCoordinator {
	readonly #deps: CheckoutPeersDeps;
	readonly #places = new Map<string, { at: number; place: Promise<CheckoutPlace | null> }>();
	/** The payload last sent to each member (JSON); absent: it was never told it has company. */
	readonly #sent = new Map<string, string>();
	/** The ids of each member's peers as of the last pass: who its `ompdesk_report` may reach. */
	readonly #peerIds = new Map<string, string[]>();
	#running: Promise<void> | null = null;
	#again = false;

	constructor(deps: CheckoutPeersDeps) {
		this.#deps = deps;
	}

	/** Run a pass now, or once more after the one running (a burst of activity costs at most two). */
	refresh(): Promise<void> {
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		this.#running = (async () => {
			do {
				this.#again = false;
				await this.#pass().catch(() => undefined);
			} while (this.#again);
			this.#running = null;
		})();
		return this.#running;
	}

	#place(cwd: string): Promise<CheckoutPlace | null> {
		const now = (this.#deps.now ?? Date.now)();
		const cached = this.#places.get(cwd);
		if (cached && now - cached.at < PLACE_TTL_MS) return cached.place;
		const place = this.#deps.place(cwd).catch(() => null);
		this.#places.set(cwd, { at: now, place });
		return place;
	}

	async #pass(): Promise<void> {
		const members = this.#deps.members();
		const placed = await Promise.all(members.map(async member => ({ member, place: await this.#place(member.cwd) })));
		const byRepo = new Map<string, Array<{ member: CheckoutMember; place: CheckoutPlace }>>();
		for (const { member, place } of placed) {
			if (!place) continue;
			const group = byRepo.get(place.commonDir) ?? [];
			group.push({ member, place });
			byRepo.set(place.commonDir, group);
		}
		const hidden = this.#deps.hiddenPaths();
		const live = new Set<string>();
		for (const group of byRepo.values()) {
			// Changed files matter only to a session in the same worktree, so only those members are asked.
			const files = new Map<string, string[]>();
			const sharing = group.filter(
				({ place }) => group.filter(other => other.place.toplevel === place.toplevel).length > 1,
			);
			await Promise.all(sharing.map(async ({ member }) => files.set(member.key, await touched(member))));
			for (const { member, place } of group) {
				live.add(member.key);
				const peer = (
					other: { member: CheckoutMember; place: CheckoutPlace },
					sameWorktree: boolean,
				): CheckoutPeer => {
					const isHidden = other.member.sessionPath !== undefined && hidden.has(other.member.sessionPath);
					return {
						id: isHidden ? null : other.member.id,
						title: isHidden ? "" : other.member.title,
						...(other.member.device ? { device: other.member.device } : {}),
						...(!isHidden && other.member.sessionPath ? { sessionPath: other.member.sessionPath } : {}),
						...(sameWorktree ? { files: files.get(other.member.key) ?? [] } : { worktree: other.place.toplevel }),
					};
				};
				const others = group.filter(other => other.member.key !== member.key);
				const payload: CheckoutPeers = {
					toplevel: place.toplevel,
					commonDir: place.commonDir,
					worktree: others
						.filter(other => other.place.toplevel === place.toplevel)
						.map(other => peer(other, true)),
					repo: others.filter(other => other.place.toplevel !== place.toplevel).map(other => peer(other, false)),
					canMessage: member.canMessage,
				};
				this.#peerIds.set(
					member.key,
					[...payload.worktree, ...payload.repo].flatMap(other => (other.id ? [other.id] : [])),
				);
				await this.#send(member, payload);
			}
		}
		// A member whose folder left every repository (or that is now alone in none) is told once it works alone.
		for (const { member, place } of placed)
			if (!live.has(member.key) && this.#sent.has(member.key))
				await this.#send(member, {
					toplevel: place?.toplevel ?? member.cwd,
					commonDir: place?.commonDir ?? "",
					worktree: [],
					repo: [],
					canMessage: member.canMessage,
				});
		const keys = new Set(members.map(member => member.key));
		for (const key of [...this.#sent.keys()]) if (!keys.has(key)) this.#sent.delete(key);
		for (const key of [...this.#peerIds.keys()]) if (!keys.has(key) || !live.has(key)) this.#peerIds.delete(key);
	}

	/** The ids of the sessions sharing `key`'s checkout or repository, as the last pass found them. */
	peersOf(key: string): readonly string[] {
		return this.#peerIds.get(key) ?? [];
	}

	async #send(member: CheckoutMember, payload: CheckoutPeers): Promise<void> {
		const json = JSON.stringify(payload);
		const alone = payload.worktree.length === 0 && payload.repo.length === 0;
		const last = this.#sent.get(member.key);
		// A session never told of company starts alone; one told is told again only of a change.
		if (last === undefined ? alone : last === json) return;
		const sent = await member.request(CHECKOUT_PEERS_SET, payload).then(
			() => true,
			() => false,
		);
		if (!sent) return;
		if (alone) this.#sent.delete(member.key);
		else this.#sent.set(member.key, json);
	}
}

/** The files a member's agents changed lately; none when its bridge does not answer in time (an older omp, a busy one). */
async function touched(member: CheckoutMember): Promise<string[]> {
	const timeout = Promise.withResolvers<null>();
	const timer = setTimeout(() => timeout.resolve(null), TOUCHED_TIMEOUT_MS);
	const answer = await Promise.race([member.request(CHECKOUT_TOUCHED, {}).catch(() => null), timeout.promise]);
	clearTimeout(timer);
	const files = answer && typeof answer === "object" && "files" in answer ? answer.files : undefined;
	return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
}

/** The checkout `cwd` is in, both paths in one spelling (macOS /var vs /private/var). */
export async function readCheckoutPlace(
	cwd: string,
	facts: (cwd: string) => Promise<{ toplevel: string | null; commonDir: string } | null>,
): Promise<CheckoutPlace | null> {
	const found = await facts(cwd);
	if (!found?.toplevel) return null;
	const [toplevel, commonDir] = await Promise.all(
		[found.toplevel, found.commonDir].map(dir => fs.realpath(dir).catch(() => dir)),
	);
	return { toplevel, commonDir };
}
