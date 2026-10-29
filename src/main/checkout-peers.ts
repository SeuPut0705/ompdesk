/**
 * Which live sessions of this computer share a git checkout, told to each of them (bridge modes/checkout-peers.ts,
 * contracts resources/gui-bridge/modes/checkout-peers-contracts.ts). Two scopes, as git has them: the worktree
 * (`--show-toplevel`: files, index, HEAD) and the repository (`--git-common-dir`: stash, branches, refs, shared by every
 * worktree of it). Each session hears the others of both, with the uncommitted files they changed lately (read from
 * their own bridges, `checkout_status`, and judged per claim by `judgeClaim`, checkout-claims.ts: a committed file is
 * no longer a claim), and whether it can message them.
 *
 * Members are this computer's own omps: the tabs of its windows and the tabs it runs for paired devices. A paired
 * host's tab is that host's to coordinate. A pass runs after tab activity, when a bridge reports a file it had not
 * changed before, and on a timer; a session hears only a change.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { judgeClaim } from "../../resources/gui-bridge/modes/checkout-claims";
import {
	CHECKOUT_PEERS_SET,
	CHECKOUT_RETIRE,
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
	/** What its `checkout_files` frames name (the sidecar): `filesChanged` ignores those of a session that works alone. */
	owner?: object;
	/** `timeoutMs`: the request is dropped (and rejects) after it, so a frozen omp leaves nothing behind. */
	request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
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
	/** `git status --porcelain=v1 -z --untracked-files=all` of a worktree top level, limited to `paths` (relative to it); rejects when git fails or is too slow. */
	gitStatus(toplevel: string, paths: string[]): Promise<string>;
	now?: () => number;
}

/** A folder's checkout is asked again after this (a `git worktree add` or a deleted checkout changes it). */
const PLACE_TTL_MS = 30_000;
/** Every request of a pass to a member's bridge: one omp that does not answer never holds the others back. */
const REQUEST_TIMEOUT_MS = 2_000;
const GIT_STATUS_TIMEOUT_MS = 5_000;
/** The command line of one `git status` stays far below Windows' 32 767 characters. */
const GIT_ARGS_BUDGET = 6_000;
/** A burst of `checkout_files` frames (one per file a session writes) costs one pass. */
const FILES_DEBOUNCE_MS = 250;
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
	/** Per worktree: the claims (`member\0file\0stamp`) the last successful git listing found committed, for a pass whose git fails. */
	readonly #committed = new Map<string, Set<string>>();
	/** Owners of the members that worked alone in the last pass. */
	#lone = new Set<object>();
	#timer: ReturnType<typeof setTimeout> | null = null;
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

	/**
	 * A bridge reported a file it had not changed before: a pass runs soon (a burst of frames costs one). A session that
	 * works alone has nobody to tell, so its frames are ignored: whoever joins it asks for a pass of its own.
	 */
	filesChanged(owner?: object): void {
		if (owner && this.#lone.has(owner)) return;
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.refresh();
		}, FILES_DEBOUNCE_MS);
		this.#timer.unref?.();
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
		const lone = new Set<object>();
		for (const { member, place } of placed) {
			const alone = !place || (byRepo.get(place.commonDir)?.length ?? 0) < 2;
			if (alone && member.owner) lone.add(member.owner);
		}
		this.#lone = lone;
		// Every member is told on its own: one omp that does not answer in time never holds the others back.
		const sends: Array<Promise<void>> = [];
		for (const group of byRepo.values()) {
			// A claim is a file that is uncommitted, so files are read for every member of a repository with company (a
			// session in another worktree hears them too, to know a merge will conflict), and git is asked once per worktree
			// about the claimed paths only. Git is asked after the claims are read: a file changed after its claim was read
			// carries a newer stamp, so the retirement below can never drop a change git did not see yet.
			const company = group.length > 1 ? group : [];
			const tops = [...new Set(company.map(({ place }) => place.toplevel))];
			const status = new Map(
				await Promise.all(company.map(async ({ member }) => [member.key, await this.#statusOf(member)] as const)),
			);
			const held = new Map(
				await Promise.all(
					company.map(
						async ({ member, place }) =>
							[
								member.key,
								await claimsOf(status.get(member.key)?.status ?? EMPTY_STATUS, place.toplevel),
							] as const,
					),
				),
			);
			const listed = new Map(
				await Promise.all(
					tops.map(async top => {
						const asked = new Set<string>();
						for (const { member, place } of company)
							if (place.toplevel === top)
								for (const claim of held.get(member.key) ?? [])
									if (claim.rel !== null) {
										asked.add(claim.rel);
										asked.add(claim.norm ?? claim.rel);
									}
						// No claim in this worktree: nothing to ask git, and nothing to retire.
						if (asked.size === 0) return [top, new Set<string>()] as const;
						return [top, await this.#deps.gitStatus(top, [...asked]).then(listedPaths, () => null)] as const;
					}),
				),
			);
			const judged = new Map<string, Set<string>>();
			const claims = new Map<string, Claim[]>();
			await Promise.all(
				company.map(async ({ member, place }) => {
					const { status: known, fresh } = status.get(member.key) ?? { status: EMPTY_STATUS, fresh: false };
					const gitSays = listed.get(place.toplevel) ?? null;
					const before = this.#committed.get(place.toplevel);
					const now = judged.get(place.toplevel) ?? new Set<string>();
					judged.set(place.toplevel, now);
					const kept: Claim[] = [];
					const committed: Array<{ file: string; stamp: number }> = [];
					for (const claim of held.get(member.key) ?? []) {
						const { stamp } = claim;
						// One claim of one omp load: a restored omp numbers its stamps from 1 again.
						const key = `${member.key}\0${known.instance ?? ""}\0${claim.file}\0${stamp}`;
						const verdict = judgeClaim({
							pending: claim.pending,
							fresh,
							inside: claim.norm !== null,
							stamped: stamp !== undefined,
							git: !gitSays
								? "unknown"
								: claim.norm !== null && holds(gitSays, claim.norm)
									? "listed"
									: "unlisted",
							committedBefore: stamp !== undefined && before?.has(key) === true,
						});
						if (verdict.kind === "shown") kept.push(claim);
						else if (verdict.kind === "committed" && stamp !== undefined) {
							committed.push({ file: claim.file, stamp });
							if (claim.norm !== null) now.add(key);
						}
					}
					claims.set(member.key, kept);
					// The session stops holding a committed claim for good, so a later change by another session is never
					// taken for this one's.
					if (committed.length > 0) await this.#retire(member, known, committed);
				}),
			);
			for (const [top, set] of judged) this.#committed.set(top, set);
			for (const { member, place } of group) {
				live.add(member.key);
				const mine = claims.get(member.key) ?? [];
				const mineByRel = new Map(
					mine.flatMap(claim => (claim.norm === null ? [] : [[claim.norm, claim.file] as const])),
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
							(claim.norm === null ? undefined : mineByRel.get(claim.norm)) ??
							(sameWorktree && mineFiles.has(claim.file) ? claim.file : undefined);
						return own ? [own] : [];
					});
					const isHidden = other.member.sessionPath !== undefined && hidden.has(other.member.sessionPath);
					const task = status.get(other.member.key)?.status.task;
					return {
						id: isHidden ? null : other.member.id,
						title: isHidden ? "" : other.member.title,
						...(other.member.device ? { device: other.member.device } : {}),
						...(!isHidden && other.member.sessionPath ? { sessionPath: other.member.sessionPath } : {}),
						...(!isHidden && task ? { task } : {}),
						...(!sameWorktree && !isHidden ? { worktree: other.place.toplevel } : {}),
						files,
						// The same files at their real place, so a write or a git run aimed into that worktree is judged.
						...(!sameWorktree && !isHidden
							? {
									worktreeFiles: theirs.flatMap(claim =>
										claim.rel === null ? [] : [path.join(other.place.toplevel, claim.rel)],
									),
								}
							: {}),
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
				sends.push(this.#send(member, payload));
			}
		}
		// A member whose folder left every repository (or that is now alone in none) is told once it works alone.
		for (const { member, place } of placed)
			if (!live.has(member.key) && this.#sent.has(member.key))
				sends.push(
					this.#send(member, {
						toplevel: place?.toplevel ?? member.cwd,
						commonDir: place?.commonDir ?? "",
						worktree: [],
						repo: [],
						canMessage: member.canMessage,
					}),
				);
		await Promise.allSettled(sends);
		const keys = new Set(members.map(member => member.key));
		for (const key of [...this.#sent.keys()]) if (!keys.has(key)) this.#sent.delete(key);
		for (const key of [...this.#statuses.keys()]) if (!keys.has(key)) this.#statuses.delete(key);
		for (const key of [...this.#peerIds.keys()]) if (!keys.has(key) || !live.has(key)) this.#peerIds.delete(key);
		const tops = new Set(placed.flatMap(({ place }) => (place ? [place.toplevel] : [])));
		for (const top of [...this.#committed.keys()]) if (!tops.has(top)) this.#committed.delete(top);
	}

	/**
	 * A member's status now; its last answer when its bridge does not answer in time (`fresh` false), so a busy omp
	 * keeps its claims. A new `instance` is a new omp process (a restart keeps the tab): it starts with no peers, so it
	 * is told again.
	 */
	async #statusOf(member: CheckoutMember): Promise<{ status: MemberStatus; fresh: boolean }> {
		const answer = await askStatus(member);
		if (!answer) return { status: this.#statuses.get(member.key) ?? EMPTY_STATUS, fresh: false };
		const before = this.#statuses.get(member.key);
		if (before && before.instance !== answer.instance) this.#sent.delete(member.key);
		this.#statuses.set(member.key, answer);
		return { status: answer, fresh: true };
	}

	/** Tells a member's bridge these claims were committed; its answer, the claims it holds now, is what main remembers of it. */
	async #retire(
		member: CheckoutMember,
		status: MemberStatus,
		committed: Array<{ file: string; stamp: number }>,
	): Promise<void> {
		const params = { ...(status.instance === undefined ? {} : { instance: status.instance }), files: committed };
		const answer = parseStatus(
			await timed(member.request(CHECKOUT_RETIRE, params, REQUEST_TIMEOUT_MS)).catch(() => null),
		);
		const last = this.#statuses.get(member.key);
		if (answer && last && answer.instance === last.instance)
			this.#statuses.set(member.key, { ...answer, ...(last.task ? { task: last.task } : {}) });
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
		// A send that times out leaves `#sent` as it was, so the next pass tells it again.
		const sent = await timed(member.request(CHECKOUT_PEERS_SET, payload, REQUEST_TIMEOUT_MS)).then(
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
	/** Each file's edit stamp (parallel to `files`); absent from a bridge that predates `checkout_retire`. */
	stamps?: number[];
	/** Files a call still running is writing. */
	pending: string[];
	/** The omp process's load of the bridge; absent from a bridge that predates it. */
	instance?: string;
	task?: string;
}

const EMPTY_STATUS: MemberStatus = { files: [], pending: [] };

/** A file a member changed: as its bridge spelled it, relative to its worktree's top level (null: outside it), and that relative path in NFC. */
interface Claim {
	file: string;
	rel: string | null;
	norm: string | null;
	stamp: number | undefined;
	/** A call still running writes it. */
	pending: boolean;
}

/** `work`, or a rejection after `ms`; the timer never outlives it. */
function timed<T>(work: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error("The bridge did not answer in time")), ms);
	return Promise.race([work, expired.promise]).finally(() => clearTimeout(timer));
}

/** The files a member's agents changed lately and its in-progress task; null when its bridge does not answer in time (an older omp, a busy one). */
async function askStatus(member: CheckoutMember): Promise<MemberStatus | null> {
	const answer = await timed(member.request(CHECKOUT_STATUS, {}, REQUEST_TIMEOUT_MS)).catch(() => null);
	return answer && typeof answer === "object" ? parseStatus(answer) : null;
}

/** A bridge's `CheckoutStatus` (`checkout_status`, and `checkout_retire`'s answer); null when it carries no file list. */
function parseStatus(answer: unknown): MemberStatus | null {
	if (!answer || typeof answer !== "object") return null;
	const record = answer as {
		files?: unknown;
		stamps?: unknown;
		pending?: unknown;
		instance?: unknown;
		task?: unknown;
	};
	if (!Array.isArray(record.files)) return null;
	const raw = record.files;
	const stamps = Array.isArray(record.stamps) && record.stamps.length === raw.length ? record.stamps : undefined;
	const kept = raw.flatMap((file, index) =>
		typeof file === "string"
			? [{ file, stamp: typeof stamps?.[index] === "number" ? stamps[index] : undefined }]
			: [],
	);
	return {
		files: kept.map(claim => claim.file),
		...(stamps && kept.every(claim => claim.stamp !== undefined)
			? { stamps: kept.map(claim => claim.stamp ?? 0) }
			: {}),
		pending: Array.isArray(record.pending)
			? record.pending.filter((file): file is string => typeof file === "string")
			: [],
		...(typeof record.instance === "string" ? { instance: record.instance } : {}),
		...(typeof record.task === "string" && record.task ? { task: record.task } : {}),
	};
}

/** A member's claims in a worktree: every file it holds plus the ones a running call is writing that it does not hold yet. */
async function claimsOf(status: MemberStatus, toplevel: string): Promise<Claim[]> {
	const pending = new Set(status.pending);
	const entries = status.files.map((file, index) => ({
		file,
		stamp: status.stamps?.[index],
		pending: pending.has(file),
	}));
	const held = new Set(status.files);
	for (const file of pending) if (!held.has(file)) entries.push({ file, stamp: undefined, pending: true });
	return Promise.all(
		entries.map(async entry => {
			const rel = await relativeTo(toplevel, entry.file);
			return { ...entry, rel, norm: rel === null ? null : rel.normalize("NFC") };
		}),
	);
}

/** `git status` of a worktree top level, limited to `paths` (relative to it, literal). */
async function statusOf(toplevel: string, paths: string[]): Promise<string> {
	const chunks: string[][] = [];
	let size = 0;
	for (const spec of paths) {
		if (chunks.length === 0 || size + spec.length > GIT_ARGS_BUDGET) {
			chunks.push([]);
			size = 0;
		}
		chunks[chunks.length - 1]?.push(spec);
		size += spec.length + 1;
	}
	const outputs = await Promise.all(
		chunks.map(async chunk => {
			const result = await gitRaw(
				toplevel,
				["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...chunk],
				{ timeoutMs: GIT_STATUS_TIMEOUT_MS, maxBytes: 16 * 1024 * 1024 },
			);
			if (result.code !== 0 || result.truncated) throw new Error(result.stderr.trim() || "git status failed");
			return result.stdout.toString("utf8");
		}),
	);
	return outputs.join("");
}

/** The submodule roots of a worktree (relative to it), from its `.gitmodules`. */
async function submoduleRoots(toplevel: string): Promise<string[]> {
	const result = await gitRaw(
		toplevel,
		["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\..*\\.path$"],
		{
			timeoutMs: GIT_STATUS_TIMEOUT_MS,
		},
	);
	if (result.code !== 0) return [];
	return result.stdout
		.toString("utf8")
		.split("\0")
		.flatMap(entry => {
			const value = entry.slice(entry.indexOf("\n") + 1);
			return entry.includes("\n") && value ? [path.normalize(value)] : [];
		});
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all` of a worktree top level, asked only about `paths` (relative to
 * it): a full-tree status of a large repository costs seconds of CPU, and only the claimed paths matter. Git does not
 * look inside a submodule for a path in it, so a path nothing lists is asked again through the submodule that holds it.
 */
export async function readGitStatus(toplevel: string, paths: string[]): Promise<string> {
	const specs = [...new Set(paths.map(spec => spec.split(path.sep).join("/")))];
	let text = await statusOf(toplevel, specs);
	const listed = listedPaths(text);
	const unlisted = paths.filter(spec => !holds(listed, path.normalize(spec).normalize("NFC")));
	if (unlisted.length === 0) return text;
	const roots = (await submoduleRoots(toplevel)).filter(root =>
		unlisted.some(spec => path.normalize(spec).startsWith(root + path.sep)),
	);
	if (roots.length > 0)
		text += await statusOf(
			toplevel,
			roots.map(root => root.split(path.sep).join("/")),
		);
	return text;
}

/** The paths git lists as changed in a worktree (both of a rename), relative to its top level, in NFC. */
function listedPaths(status: string): Set<string> {
	const listed = new Set<string>();
	for (const entry of parseGitStatus(status)) {
		listed.add(path.normalize(entry.path).normalize("NFC"));
		if (entry.oldPath) listed.add(path.normalize(entry.oldPath).normalize("NFC"));
	}
	return listed;
}

/** `rel` is still uncommitted: git lists it, anything under it (a folder), or a path that contains it (a submodule, a folder). */
function holds(listed: Set<string>, rel: string): boolean {
	if (listed.has(rel)) return true;
	for (let dir = path.dirname(rel); dir !== "." && dir !== path.dirname(dir); dir = path.dirname(dir))
		if (listed.has(dir)) return true;
	const prefix = rel + path.sep;
	for (const entry of listed) if (entry.startsWith(prefix)) return true;
	return false;
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
