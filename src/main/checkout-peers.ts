/**
 * Which live sessions of this computer share a git checkout, told to each of them (bridge modes/checkout-peers.ts,
 * contracts resources/gui-bridge/modes/checkout-peers-contracts.ts). Two scopes, as git has them: the worktree
 * (`--show-toplevel`: files, index, HEAD) and the repository (`--git-common-dir`: stash, branches, refs, shared by every
 * worktree of it). Each session hears the others of both, with the uncommitted files they changed lately (read from
 * their own bridges, `checkout_status`, and kept only while `git status` still lists them: a committed file is no
 * longer a claim), and whether it can message them.
 *
 * Members are this computer's own omps: the tabs of its windows and the tabs it runs for paired devices. A paired
 * host's tab is that host's to coordinate. A pass runs after tab activity, when a bridge reports a file it had not
 * changed before, and on a timer; a session hears only a change.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CHECKOUT_PEERS_SET,
	CHECKOUT_STATUS,
	type CheckoutPeer,
	type CheckoutPeers,
} from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import { gitRaw } from "./local/git/exec";
import { parseGitStatus } from "./local/git/parse";

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
	/** `git status --porcelain=v1 -z --untracked-files=all` of a worktree top level; rejects when git fails or is too slow. */
	gitStatus(toplevel: string): Promise<string>;
	now?: () => number;
}

/** A folder's checkout is asked again after this (a `git worktree add` or a deleted checkout changes it). */
const PLACE_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 2_000;
const GIT_STATUS_TIMEOUT_MS = 5_000;
/** Besides tab activity, a pass runs this often: a tab that became ready, a hidden session or a new worktree moves no tab. */
export const CHECKOUT_PEERS_SWEEP_MS = 10_000;

export class CheckoutPeerCoordinator {
	readonly #deps: CheckoutPeersDeps;
	readonly #places = new Map<string, { at: number; place: Promise<CheckoutPlace | null> }>();
	/** The payload last sent to each member (JSON); absent: it was never told it has company. */
	readonly #sent = new Map<string, string>();
	/** The ids of each member's peers as of the last pass: who its `ompdesk_report` may reach. */
	readonly #peerIds = new Map<string, string[]>();
	/** The last status each member's bridge answered with. */
	readonly #statuses = new Map<string, MemberStatus>();
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
			// A claim is a file that is uncommitted, so files are read for every member of a repository with company (a
			// session in another worktree hears them too, to know a merge will conflict), and git is asked once per worktree.
			const company = group.length > 1 ? group : [];
			const tops = [...new Set(company.map(({ place }) => place.toplevel))];
			const [statuses, listings] = await Promise.all([
				Promise.all(company.map(async ({ member }) => [member.key, await this.#statusOf(member)] as const)),
				Promise.all(
					tops.map(async top => [top, await this.#deps.gitStatus(top).then(listedPaths, () => null)] as const),
				),
			]);
			const status = new Map(statuses);
			const listed = new Map(listings);
			const claims = new Map<string, Claim[]>();
			await Promise.all(
				company.map(async ({ member, place }) =>
					claims.set(
						member.key,
						await claimsOf(
							status.get(member.key)?.files ?? [],
							place.toplevel,
							listed.get(place.toplevel) ?? null,
						),
					),
				),
			);
			for (const { member, place } of group) {
				live.add(member.key);
				const mine = claims.get(member.key) ?? [];
				const mineByRel = new Map(
					mine.flatMap(claim => (claim.rel === null ? [] : [[claim.rel, claim.file] as const])),
				);
				const mineFiles = new Set(mine.map(claim => claim.file));
				const peer = (
					other: { member: CheckoutMember; place: CheckoutPlace },
					sameWorktree: boolean,
				): CheckoutPeer => {
					const theirs = claims.get(other.member.key) ?? [];
					const files = sameWorktree
						? theirs.map(claim => claim.file)
						: theirs.flatMap(claim => (claim.rel === null ? [] : [path.join(place.toplevel, claim.rel)]));
					const shared = theirs.flatMap(claim => {
						const own =
							(claim.rel === null ? undefined : mineByRel.get(claim.rel)) ??
							(sameWorktree && mineFiles.has(claim.file) ? claim.file : undefined);
						return own ? [own] : [];
					});
					const isHidden = other.member.sessionPath !== undefined && hidden.has(other.member.sessionPath);
					const task = status.get(other.member.key)?.task;
					return {
						id: isHidden ? null : other.member.id,
						title: isHidden ? "" : other.member.title,
						...(other.member.device ? { device: other.member.device } : {}),
						...(!isHidden && other.member.sessionPath ? { sessionPath: other.member.sessionPath } : {}),
						...(!isHidden && task ? { task } : {}),
						...(!sameWorktree && !isHidden ? { worktree: other.place.toplevel } : {}),
						files,
						...(shared.length > 0 ? { shared } : {}),
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
		for (const key of [...this.#statuses.keys()]) if (!keys.has(key)) this.#statuses.delete(key);
		for (const key of [...this.#peerIds.keys()]) if (!keys.has(key) || !live.has(key)) this.#peerIds.delete(key);
	}

	/** A member's status now; its last answer when its bridge does not answer in time, so a busy omp keeps its claims. */
	async #statusOf(member: CheckoutMember): Promise<MemberStatus> {
		const answer = await askStatus(member);
		if (!answer) return this.#statuses.get(member.key) ?? { files: [] };
		this.#statuses.set(member.key, answer);
		return answer;
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

interface MemberStatus {
	files: string[];
	task?: string;
}

/** A file a member changed: as its bridge spelled it, and relative to its worktree's top level (null: outside it). */
interface Claim {
	file: string;
	rel: string | null;
}

/** The files a member's agents changed lately and its in-progress task; null when its bridge does not answer in time (an older omp, a busy one). */
async function askStatus(member: CheckoutMember): Promise<MemberStatus | null> {
	const timeout = Promise.withResolvers<null>();
	const timer = setTimeout(() => timeout.resolve(null), STATUS_TIMEOUT_MS);
	const answer = await Promise.race([member.request(CHECKOUT_STATUS, {}).catch(() => null), timeout.promise]);
	clearTimeout(timer);
	if (!answer || typeof answer !== "object") return null;
	const record = answer as { files?: unknown; task?: unknown };
	const files = Array.isArray(record.files)
		? record.files.filter((file): file is string => typeof file === "string")
		: [];
	return { files, ...(typeof record.task === "string" && record.task ? { task: record.task } : {}) };
}

/** `git status --porcelain=v1 -z --untracked-files=all` of a worktree top level. */
export async function readGitStatus(toplevel: string): Promise<string> {
	const result = await gitRaw(toplevel, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		timeoutMs: GIT_STATUS_TIMEOUT_MS,
		maxBytes: 16 * 1024 * 1024,
	});
	if (result.code !== 0 || result.truncated) throw new Error(result.stderr.trim() || "git status failed");
	return result.stdout.toString("utf8");
}

/** The paths git lists as changed in a worktree (both of a rename), relative to its top level. */
function listedPaths(status: string): Set<string> {
	const listed = new Set<string>();
	for (const entry of parseGitStatus(status)) {
		listed.add(path.normalize(entry.path));
		if (entry.oldPath) listed.add(path.normalize(entry.oldPath));
	}
	return listed;
}

/** `file` relative to `toplevel`; null when it lies outside (a path spelled through a symlink is resolved before giving up). */
async function relativeTo(toplevel: string, file: string): Promise<string | null> {
	const within = (target: string): string | null => {
		const rel = path.relative(toplevel, target);
		return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : null;
	};
	const direct = within(file);
	if (direct) return direct;
	const dir = await fs.realpath(path.dirname(file)).catch(() => null);
	return dir ? within(path.join(dir, path.basename(file))) : null;
}

/** The member's changed files that are still uncommitted: all of them when git could not say (`listed` null). */
async function claimsOf(files: string[], toplevel: string, listed: Set<string> | null): Promise<Claim[]> {
	const claims = await Promise.all(files.map(async file => ({ file, rel: await relativeTo(toplevel, file) })));
	return listed ? claims.filter(claim => claim.rel !== null && listed.has(claim.rel)) : claims;
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
