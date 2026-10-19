/**
 * Memory shared between a person's paired computers (C8): a decision, rule, gotcha, procedure, preference or profile
 * entry made on one computer is in the other's memory server too, so a session the Mac opens on the Windows host
 * recalls the Mac's decisions there. Only durable pages cross (`isDurablePath`); session pages and raw observations
 * stay where they were captured. Deletes do not cross.
 *
 * Session conclusions cross too (each turn's final-answer excerpt, ≤ 2000 bytes, the server's `Stop` observations
 * with a body), so a session on the other computer can recall them (`memory_query {conclusions: true}`). They are
 * immutable and written insert-if-absent under the computer that captured them (`origin`); a conclusion is redacted
 * again before it leaves and again when it arrives, never goes back to its origin, and is forwarded to the other
 * computers once (a computer sends the ones it captured and the ones it holds from third computers). Deletes do not
 * cross either; the receiver's own retention applies to what it holds.
 *
 * The device that connected to a host drives both directions over its link (the link only carries requests that
 * way): `host.memory.pull` brings the host's pages changed after a cursor, `host.memory.push` sends this computer's
 * pages changed since it last looked, `host.memory.conclusions.pull`/`push` do the same for conclusions with
 * a cursor per stream. The host serves them with `servePull`/`servePush`/`serveConclusionPull`/`serveConclusionPush`
 * on its own server. A host that answers `unsupported` to the conclusion methods (an older OMPdesk) still syncs
 * pages; the device leaves its conclusions alone until the link comes up again.
 *
 * Identity: (workspace, project, path). Content: `pageHash` of what the write path stores. A page's two copies are
 * "in agreement" at a pair of hashes (`base`: this computer's, the host's), recorded whenever a sync made them so;
 * a side whose hash still equals its half of the pair has not changed since. That keeps a sync idempotent even when
 * a server normalizes what it stores (entities lowercased, a body scrubbed), and a copy received from a peer is never
 * sent back as new. A copy also carries `origin_device` (the computer it came from) until someone edits it, and an
 * unedited copy never goes back to that computer. When both sides changed, the one changed last wins (each page's
 * `updated_at`), logged as `conflict` (source `memory-sync`).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { redactDiagnosticsText } from "../../../resources/gui-bridge/redactor";
import type { AiMemoryPageRef, AiMemoryProjectRef } from "../../shared/ai-memory";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import {
	isDurablePath,
	MEMORY_CONCLUSION_MAX_BYTES,
	MEMORY_METHODS,
	MEMORY_PAGE_MAX_BYTES,
	MEMORY_REQUEST_TIMEOUT_MS,
	MemoryConclusionCursor,
	type MemoryConclusionPullParams,
	MemoryConclusionPullReply,
	type MemoryConclusionPushParams,
	MemoryConclusionPushReply,
	MemoryConclusionWire,
	MemoryCursor,
	MemoryPageWire,
	type MemoryPullParams,
	MemoryPullReply,
	type MemoryPushParams,
	MemoryPushReply,
} from "../remote/app-protocol";
import type { MemoryConclusionCopy, MemoryPageCopy } from "./client";

/** While a host is connected and memory is on, they sync this often (and whenever the link comes up). */
export const MEMORY_SYNC_INTERVAL_MS = 5 * 60_000;
/** Pages and body bytes one pull or push batch carries at most. */
const BATCH_PAGES = 25;
const BATCH_BYTES = 1_000_000;
/** One round pulls at most this many batches; the next round goes on from the cursor. */
const MAX_PULL_BATCHES = 40;
/** Agreement pairs kept per host (a person has hundreds of durable pages, not thousands). */
const BASE_LIMIT = 10_000;
/** Conclusions one pull reply or push request carries at most (the wire's cap), and batches one round goes through. */
const CONCLUSION_BATCH = 200;
const MAX_CONCLUSION_BATCHES = 40;
/** A conclusion's title is cut to this many characters (the server's own cut). */
const CONCLUSION_TITLE_CHARS = 500;

/** The memory server, as the sync reads and writes it (AiMemoryClient). */
export interface MemoryStore {
	projects(): Promise<AiMemoryProjectRef[]>;
	/** Every latest page, expired ones too: a retired page must cross as retired, never be missed and re-created. */
	allPages(
		project: AiMemoryProjectRef,
	): Promise<Pick<AiMemoryPageRef, "workspace" | "project" | "path" | "updatedAt">[]>;
	pageCopy(ref: AiMemoryProjectRef & { path: string }): Promise<MemoryPageCopy>;
	/** Only over the version `expected` (a `pageCopy` id) or, with `null`, only where nothing is; false: it moved on. */
	writePageCopy(copy: MemoryPageCopy, origin: string | undefined, expected: string | null): Promise<boolean>;
	/** One conclusion stream after `after`, `seq` order (`AiMemoryClient.conclusions`). */
	conclusions(
		source: "native" | "synced",
		after: number,
		limit: number,
	): Promise<{ rows: MemoryConclusionCopy[]; next: number; more: boolean }>;
	/** Insert-if-absent under `origin`, a status per item in order (`AiMemoryClient.writeConclusions`). */
	writeConclusions(
		project: AiMemoryProjectRef,
		origin: string,
		items: Pick<MemoryConclusionCopy, "id" | "sessionId" | "title" | "body" | "at">[],
	): Promise<("written" | "same" | "skipped")[]>;
}

type PageRef = AiMemoryProjectRef & { path: string };

export function pageKey(ref: PageRef): string {
	return `${ref.workspace}\u0000${ref.project}\u0000${ref.path}`;
}

/**
 * What a page holds, independent of where it lives, when it changed, its pin and where it came from. Its expiry
 * counts (a retired page is a change); a page without one hashes as it did before expiry was carried.
 */
export function pageHash(
	page: Pick<MemoryPageCopy, "title" | "kind" | "tier" | "body" | "tags" | "metadata" | "expiresAt">,
): string {
	const meta = page.metadata;
	const relations = Object.entries(meta.relations ?? {})
		.filter(([, targets]) => targets.length > 0)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const canonical = JSON.stringify([
		page.title,
		page.kind ?? "",
		page.tier,
		page.body,
		[...page.tags].sort(),
		meta.entities ?? [],
		meta.abstract ?? "",
		relations,
		meta.applies_to ?? [],
		meta.enforced_by ?? "",
		...(page.expiresAt ? [page.expiresAt] : []),
	]);
	return createHash("sha256").update(canonical).digest("hex");
}

interface IndexEntry {
	key: string;
	ref: PageRef;
	/** The page's `updated_at` on this server ("" when it reports none). */
	at: string;
}

/** This server's durable pages, by key. */
async function durableIndex(store: MemoryStore): Promise<Map<string, IndexEntry>> {
	const index = new Map<string, IndexEntry>();
	for (const project of await store.projects()) {
		for (const page of await store.allPages({ workspace: project.workspace, project: project.project })) {
			if (!isDurablePath(page.path)) continue;
			const ref = { workspace: page.workspace, project: page.project, path: page.path };
			index.set(pageKey(ref), { key: pageKey(ref), ref, at: page.updatedAt ?? "" });
		}
	}
	return index;
}

function compareCursor(a: MemoryCursor, b: MemoryCursor): number {
	if (a.at !== b.at) return a.at < b.at ? -1 : 1;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The page on the link; null when it cannot cross (too big, a field past the link's bounds). */
function toWire(copy: MemoryPageCopy, origin: string, at: string): MemoryPageWire | null {
	if (Buffer.byteLength(copy.body) > MEMORY_PAGE_MAX_BYTES) return null;
	const parsed = MemoryPageWire.safeParse({
		workspace: copy.workspace,
		project: copy.project,
		path: copy.path,
		title: copy.title,
		...(copy.kind ? { kind: copy.kind } : {}),
		tier: copy.tier,
		body: copy.body,
		tags: copy.tags,
		pinned: copy.pinned,
		metadata: copy.metadata,
		...(copy.expiresAt ? { expiresAt: copy.expiresAt } : {}),
		origin,
		updatedAt: at,
		hash: pageHash(copy),
	});
	return parsed.success ? parsed.data : null;
}

function fromWire(page: MemoryPageWire): MemoryPageCopy {
	const metadata: MemoryPageCopy["metadata"] = {};
	for (const [field, value] of Object.entries(page.metadata)) {
		if (value !== undefined) Object.assign(metadata, { [field]: value });
	}
	return {
		workspace: page.workspace,
		project: page.project,
		path: page.path,
		title: page.title,
		...(page.kind ? { kind: page.kind } : {}),
		tier: page.tier,
		body: page.body,
		tags: page.tags,
		pinned: page.pinned,
		metadata,
		...(page.expiresAt ? { expiresAt: page.expiresAt } : {}),
		updatedAt: page.updatedAt || null,
	};
}

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutBytes(text: string, max: number): string {
	if (Buffer.byteLength(text) <= max) return text;
	let kept = "";
	let bytes = 0;
	for (const char of text.slice(0, max)) {
		bytes += Buffer.byteLength(char);
		if (bytes > max) break;
		kept += char;
	}
	return kept;
}

/**
 * A conclusion as it may leave or be written: title and body redacted again (an older or hostile peer may not have),
 * the body cut to the excerpt cap, the title to the server's cut. Null when nothing can be written of it: no text
 * left, an id the server would refuse, a field past the wire's bounds.
 */
function cleanConclusion(
	row: Pick<MemoryConclusionCopy, "workspace" | "project" | "id" | "sessionId" | "title" | "body" | "at">,
	origin: string,
): MemoryConclusionWire | null {
	const body = cutBytes(redactDiagnosticsText(row.body), MEMORY_CONCLUSION_MAX_BYTES);
	if (!body.trim() || !/^\S+$/.test(row.id)) return null;
	const parsed = MemoryConclusionWire.safeParse({
		workspace: row.workspace,
		project: row.project,
		id: row.id,
		sessionId: row.sessionId,
		title: [...redactDiagnosticsText(row.title)].slice(0, CONCLUSION_TITLE_CHARS).join(""),
		body,
		at: row.at,
		origin,
	});
	return parsed.success ? parsed.data : null;
}

/** Rows of one (workspace, project, origin), the unit the server writes in one request. */
function groupConclusions<T extends { workspace: string; project: string; origin: string }>(
	rows: T[],
): { workspace: string; project: string; origin: string; rows: T[] }[] {
	const groups = new Map<string, { workspace: string; project: string; origin: string; rows: T[] }>();
	for (const row of rows) {
		const key = `${row.workspace}\u0000${row.project}\u0000${row.origin}`;
		const group = groups.get(key) ?? { workspace: row.workspace, project: row.project, origin: row.origin, rows: [] };
		group.rows.push(row);
		groups.set(key, group);
	}
	return [...groups.values()];
}

/** The host side: this computer's server, whether memory is on, and this computer's device id. */
export interface MemoryHostDeps {
	store: MemoryStore;
	ready(): boolean;
	selfId(): string;
}

/** `host.memory.pull`: this computer's durable pages after `since`, oldest first, none of `peer`'s own copies. */
export async function servePull(
	deps: MemoryHostDeps,
	peer: string,
	params: MemoryPullParams,
): Promise<MemoryPullReply> {
	if (!deps.ready()) return { memory: false, pages: [], next: params.since, more: false };
	const self = deps.selfId();
	const entries = [...(await durableIndex(deps.store)).values()]
		.map(entry => ({ entry, cursor: { at: entry.at, key: entry.key } }))
		.filter(({ cursor }) => params.since === null || compareCursor(cursor, params.since) > 0)
		.sort((a, b) => compareCursor(a.cursor, b.cursor));
	const pages: MemoryPageWire[] = [];
	let bytes = 0;
	let next = params.since;
	let examined = 0;
	for (const { entry, cursor } of entries) {
		if (pages.length >= BATCH_PAGES || bytes >= BATCH_BYTES) break;
		examined++;
		// A read that fails fails the pull: the cursor stays before this page, so the next round reads it again.
		const copy = await deps.store.pageCopy(entry.ref);
		next = cursor;
		const origin = copy.origin ?? self;
		// An unedited copy of the asking device's own page: it has the page already.
		if (origin === peer) continue;
		const wire = toWire(copy, origin, entry.at);
		if (!wire) continue;
		pages.push(wire);
		bytes += Buffer.byteLength(wire.body);
	}
	return { memory: true, pages, next, more: examined < entries.length };
}

/**
 * `host.memory.push`: write each page here unless this computer already holds it, or changed it since the device
 * last saw it (`conflict`, with this computer's version, so the device settles it at once).
 */
export async function servePush(
	deps: MemoryHostDeps,
	_peer: string,
	params: MemoryPushParams,
): Promise<MemoryPushReply> {
	if (!deps.ready()) return { memory: false, results: [] };
	const self = deps.selfId();
	const index = await durableIndex(deps.store);
	const results: MemoryPushReply["results"] = [];
	for (const { page, expect } of params.pages) {
		try {
			const incoming = fromWire(page);
			const held = index.get(pageKey(page));
			const current = held ? await deps.store.pageCopy(held.ref) : null;
			const currentHash = current ? pageHash(current) : null;
			if (currentHash !== null && currentHash === pageHash(incoming)) {
				results.push({ status: "same", hash: currentHash });
				continue;
			}
			if (current && held && currentHash !== expect) {
				const theirs = toWire(current, current.origin ?? self, held.at);
				results.push({ status: "conflict", hash: currentHash, ...(theirs ? { page: theirs } : {}) });
				continue;
			}
			// Only over the version just judged: a change landing in between (a retire) is never overwritten.
			if (
				!(await deps.store.writePageCopy(
					incoming,
					page.origin === self ? undefined : page.origin,
					current?.id ?? null,
				))
			) {
				const moved = await deps.store.pageCopy(page);
				const theirs = toWire(moved, moved.origin ?? self, moved.updatedAt ?? "");
				results.push({ status: "conflict", hash: pageHash(moved), ...(theirs ? { page: theirs } : {}) });
				continue;
			}
			results.push({ status: "written", hash: pageHash(await deps.store.pageCopy(page)) });
		} catch {
			results.push({ status: "failed", hash: null });
		}
	}
	return { memory: true, results };
}

/**
 * `host.memory.conclusions.pull`: this computer's own conclusions after `since.native`, then the ones it holds from
 * other computers after `since.synced`, at most 200 together, none that `peer` captured. Memory off: nothing read.
 */
export async function serveConclusionPull(
	deps: MemoryHostDeps,
	peer: string,
	params: MemoryConclusionPullParams,
): Promise<MemoryConclusionPullReply> {
	if (!deps.ready()) return { memory: false, conclusions: [], next: params.since, more: false };
	const self = deps.selfId();
	const conclusions: MemoryConclusionWire[] = [];
	const take = (row: MemoryConclusionCopy, origin: string | undefined): void => {
		if (!origin || origin === peer) return;
		const wire = cleanConclusion(row, origin);
		if (wire) conclusions.push(wire);
	};
	const next = { ...params.since };
	const native = await deps.store.conclusions("native", params.since.native, CONCLUSION_BATCH);
	for (const row of native.rows) take(row, self);
	next.native = native.next;
	let more = native.more;
	if (!more) {
		const room = CONCLUSION_BATCH - conclusions.length;
		if (room > 0) {
			const synced = await deps.store.conclusions("synced", params.since.synced, room);
			for (const row of synced.rows) take(row, row.origin);
			next.synced = synced.next;
			more = synced.more;
		} else more = true;
	}
	return { memory: true, conclusions, next, more };
}

/**
 * `host.memory.conclusions.push`: write each conclusion here under the computer that captured it, unless this
 * computer holds it already (the server answers `same`) or it is this computer's own coming back (`same`, no write).
 * A group the server refuses or fails on is `failed` for its rows only.
 */
export async function serveConclusionPush(
	deps: MemoryHostDeps,
	_peer: string,
	params: MemoryConclusionPushParams,
): Promise<MemoryConclusionPushReply> {
	if (!deps.ready()) return { memory: false, results: [] };
	const self = deps.selfId();
	const results: MemoryConclusionPushReply["results"] = params.conclusions.map(() => ({ status: "failed" }));
	const writable: (MemoryConclusionWire & { index: number })[] = [];
	for (const [index, row] of params.conclusions.entries()) {
		if (row.origin === self) results[index] = { status: "same" };
		else {
			const clean = cleanConclusion(row, row.origin);
			if (clean) writable.push({ ...clean, index });
			else results[index] = { status: "skipped" };
		}
	}
	for (const group of groupConclusions(writable)) {
		try {
			const statuses = await deps.store.writeConclusions(
				{ workspace: group.workspace, project: group.project },
				group.origin,
				group.rows.map(({ id, sessionId, title, body, at }) => ({ id, sessionId, title, body, at })),
			);
			for (const [at, row] of group.rows.entries()) results[row.index] = { status: statuses[at] ?? "failed" };
		} catch {
			// Left `failed`: the device offers these rows again.
		}
	}
	return { memory: true, results };
}

const HostState = z.object({
	/** Where the next pull of this host's pages goes on. */
	pull: MemoryCursor.nullable(),
	/** This computer's newest `updated_at` already offered to the host. */
	push: z.string(),
	/** Key → [this computer's hash, the host's hash] when the two last agreed. */
	base: z.record(z.tuple([z.string(), z.string()])),
	/** Key → the host's hash as last seen. */
	remote: z.record(z.string()),
	/** Keys to offer again whatever their time: a push that failed or lost a conflict it then won. */
	pending: z.array(z.string()),
	/**
	 * Where the next pull of this host's conclusions goes on, per stream (its own, then the ones it holds from
	 * other computers). A sync.json written before conclusions existed has none: they start from the beginning.
	 */
	conclusions: MemoryConclusionCursor.default(() => ({ native: 0, synced: 0 })),
	/** The last row of each of this computer's streams (its own, the ones it holds) the host has answered for. */
	conclusionsSent: MemoryConclusionCursor.default(() => ({ native: 0, synced: 0 })),
});
type HostState = z.infer<typeof HostState>;
const SyncFile = z.object({ v: z.literal(1), hosts: z.record(HostState) });
type SyncFile = z.infer<typeof SyncFile>;

function freshHost(): HostState {
	return {
		pull: null,
		push: "",
		base: {},
		remote: {},
		pending: [],
		conclusions: { native: 0, synced: 0 },
		conclusionsSent: { native: 0, synced: 0 },
	};
}

export interface MemorySyncReport {
	pulled: number;
	pushed: number;
	conflicts: number;
	/** Session conclusions written here (pulled) and written on the host (pushed) this round. */
	conclusions: { pulled: number; pushed: number };
}

export interface MemorySyncDeps {
	store: MemoryStore;
	/** Memory is on and its server answers here. */
	ready(): boolean;
	/** This computer's OMPdesk device id (what its copies on other computers name as their origin). */
	selfId(): string;
	/** The hosts this computer is connected to now. */
	onlineHosts(): string[];
	/** One request to a host over its link (RemoteDevices.request). */
	request<T>(host: string, method: string, params: unknown, timeoutMs?: number): Promise<T>;
	/** `<userData>/ai-memory/sync.json`: cursors and agreement pairs per host. */
	stateFile: string;
	/** A line in the runtime log (source `memory-sync`). */
	log(message: string, details: Record<string, unknown>): void;
	intervalMs?: number;
}

class MemoryOff extends Error {}

/** The device side: syncs with every connected host while memory is on. */
export class MemorySync {
	readonly #deps: MemorySyncDeps;
	#file: SyncFile | null = null;
	#saving: Promise<void> = Promise.resolve();
	readonly #running = new Map<string, Promise<MemorySyncReport | null>>();
	/** Hosts whose OMPdesk has no memory sync (older): left alone until their link comes up again. */
	readonly #unsupported = new Set<string>();
	/** Hosts that sync pages but have no conclusion methods (older): asked again when their link comes up. */
	readonly #conclusionsUnsupported = new Set<string>();
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(deps: MemorySyncDeps) {
		this.#deps = deps;
	}

	start(): void {
		this.#timer = setInterval(() => this.syncAll(), this.#deps.intervalMs ?? MEMORY_SYNC_INTERVAL_MS);
		this.#timer.unref?.();
	}

	/** A host's link came up: it may run a newer OMPdesk now, and its pages and conclusions may have changed meanwhile. */
	hostOnline(host: string): void {
		this.#unsupported.delete(host);
		this.#conclusionsUnsupported.delete(host);
		void this.sync(host);
	}

	syncAll(): void {
		for (const host of this.#deps.onlineHosts()) void this.sync(host);
	}

	/** One round with `host`: pages, then conclusions, each pull then push. Null when nothing ran (memory off, an older host). */
	sync(host: string): Promise<MemorySyncReport | null> {
		const running = this.#running.get(host);
		if (running) return running;
		if (this.#disposed || this.#unsupported.has(host) || !this.#deps.ready()) return Promise.resolve(null);
		const round = this.#round(host).finally(() => this.#running.delete(host));
		this.#running.set(host, round);
		return round;
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#timer);
	}

	async #round(host: string): Promise<MemorySyncReport | null> {
		const started = Date.now();
		const state = await this.#hostState(host);
		const report: MemorySyncReport = { pulled: 0, pushed: 0, conflicts: 0, conclusions: { pulled: 0, pushed: 0 } };
		let step = "pull";
		try {
			await this.#pull(host, state, report);
			step = "push";
			await this.#push(host, state, report);
			step = "conclusions";
			await this.#conclusions(host, state, report);
		} catch (error) {
			if (error instanceof MemoryOff) return null;
			const unsupported = ipcErrorCode(error) === "unsupported";
			// Pages are done by now: a host or server that cannot do conclusions costs only them.
			if (step === "conclusions" && unsupported) {
				this.#conclusionsUnsupported.add(host);
				this.#deps.log("conclusions-unsupported", { host });
			} else if (unsupported) {
				this.#unsupported.add(host);
				this.#deps.log("unsupported", { host });
				return null;
			} else {
				this.#deps.log("failed", { host, step, error: error instanceof Error ? error.message : String(error) });
				if (step !== "conclusions") return null;
			}
		} finally {
			this.#trim(state);
			await this.#save();
		}
		const { pulled, pushed } = report.conclusions;
		if (report.pulled + report.pushed + report.conflicts + pulled + pushed > 0)
			this.#deps.log("round", { host, ...report, ms: Date.now() - started });
		return report;
	}

	async #pull(host: string, state: HostState, report: MemorySyncReport): Promise<void> {
		for (let batch = 0; batch < MAX_PULL_BATCHES; batch++) {
			const reply = MemoryPullReply.parse(
				await this.#deps.request(host, MEMORY_METHODS.pull, { since: state.pull }, MEMORY_REQUEST_TIMEOUT_MS),
			);
			if (!reply.memory) throw new MemoryOff();
			const local = await durableIndex(this.#deps.store);
			for (const page of reply.pages) {
				await this.#take(host, state, page, local, report);
				state.pull = { at: page.updatedAt, key: pageKey(page) };
			}
			state.pull = reply.next ?? state.pull;
			if (!reply.more) return;
		}
	}

	/** Settle one of the host's pages here. */
	async #take(
		host: string,
		state: HostState,
		page: MemoryPageWire,
		local: Map<string, IndexEntry>,
		report: MemorySyncReport,
	): Promise<void> {
		const key = pageKey(page);
		const base = state.base[key];
		state.remote[key] = page.hash;
		// The host's copy has not changed since the two agreed: anything changed here goes out with the push.
		if (base && base[1] === page.hash) return;
		const held = local.get(key);
		if (!held) return this.#write(state, page, report, null);
		const copy = await this.#deps.store.pageCopy(held.ref);
		const mine = pageHash(copy);
		if (mine === page.hash) {
			state.base[key] = [mine, page.hash];
			this.#unpend(state, key);
			return;
		}
		// Changed only there.
		if (base && base[0] === mine) return this.#write(state, page, report, copy.id ?? null);
		// Changed on both (or first met with different content): the one changed last wins.
		report.conflicts++;
		const theirs = page.updatedAt > held.at;
		this.#deps.log("conflict", {
			host,
			workspace: page.workspace,
			project: page.project,
			path: page.path,
			winner: theirs ? "host" : "here",
			hereAt: held.at,
			hostAt: page.updatedAt,
		});
		if (theirs) return this.#write(state, page, report, copy.id ?? null);
		if (!state.pending.includes(key)) state.pending.push(key);
	}

	/**
	 * Write the host's page here over the version just judged (`expected`; `null`: none was here). When this page
	 * changed in between (a retire, an edit), nothing is written: that change is newer and goes out with the push.
	 */
	async #write(
		state: HostState,
		page: MemoryPageWire,
		report: MemorySyncReport,
		expected: string | null,
	): Promise<void> {
		const key = pageKey(page);
		const origin = page.origin === this.#deps.selfId() ? undefined : page.origin;
		if (!(await this.#deps.store.writePageCopy(fromWire(page), origin, expected))) return;
		state.base[key] = [pageHash(await this.#deps.store.pageCopy(page)), page.hash];
		this.#unpend(state, key);
		report.pulled++;
	}

	async #push(host: string, state: HostState, report: MemorySyncReport): Promise<void> {
		const self = this.#deps.selfId();
		const local = await durableIndex(this.#deps.store);
		const pending = new Set(state.pending);
		const candidates = [...local.values()]
			.filter(entry => entry.at > state.push || pending.has(entry.key))
			.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
		let newest = state.push;
		let batch: { key: string; hash: string; item: MemoryPushParams["pages"][number] }[] = [];
		let bytes = 0;
		const flush = async (): Promise<void> => {
			if (batch.length === 0) return;
			const sent = batch;
			batch = [];
			bytes = 0;
			const reply = MemoryPushReply.parse(
				await this.#deps.request(
					host,
					MEMORY_METHODS.push,
					{ pages: sent.map(entry => entry.item) },
					MEMORY_REQUEST_TIMEOUT_MS,
				),
			);
			if (!reply.memory) throw new MemoryOff();
			for (const [index, entry] of sent.entries()) {
				const result = reply.results[index];
				if (result && (result.status === "written" || result.status === "same") && result.hash) {
					state.base[entry.key] = [entry.hash, result.hash];
					state.remote[entry.key] = result.hash;
					this.#unpend(state, entry.key);
					if (result.status === "written") report.pushed++;
				} else if (result?.status === "conflict" && result.page) {
					await this.#take(host, state, result.page, await durableIndex(this.#deps.store), report);
				} else if (!state.pending.includes(entry.key)) {
					state.pending.push(entry.key);
				}
			}
		};
		for (const entry of candidates) {
			if (entry.at > newest) newest = entry.at;
			const copy = await this.#deps.store.pageCopy(entry.ref).catch(() => null);
			// The push time moves on past it: offer it again next round whatever its time.
			if (!copy) {
				if (!state.pending.includes(entry.key)) state.pending.push(entry.key);
				continue;
			}
			const hash = pageHash(copy);
			const base = state.base[entry.key];
			// Unchanged since the two agreed, or an unedited copy of the host's own page: nothing to tell it.
			if ((base && base[0] === hash) || copy.origin === host) {
				this.#unpend(state, entry.key);
				continue;
			}
			const page = toWire(copy, copy.origin ?? self, entry.at);
			if (!page) continue;
			batch.push({ key: entry.key, hash, item: { page, expect: state.remote[entry.key] ?? null } });
			bytes += Buffer.byteLength(page.body);
			if (batch.length >= BATCH_PAGES || bytes >= BATCH_BYTES) await flush();
		}
		await flush();
		state.push = newest;
		// A page deleted here since it was left pending has nothing more to offer.
		state.pending = state.pending.filter(key => local.has(key));
	}

	/** Conclusions, after the pages: the host's first, then this computer's two streams. */
	async #conclusions(host: string, state: HostState, report: MemorySyncReport): Promise<void> {
		if (this.#conclusionsUnsupported.has(host)) return;
		await this.#pullConclusions(host, state, report);
		await this.#pushConclusions(host, state, report);
	}

	async #pullConclusions(host: string, state: HostState, report: MemorySyncReport): Promise<void> {
		const self = this.#deps.selfId();
		for (let batch = 0; batch < MAX_CONCLUSION_BATCHES; batch++) {
			const reply = MemoryConclusionPullReply.parse(
				await this.#deps.request(
					host,
					MEMORY_METHODS.conclusionsPull,
					{ since: state.conclusions },
					MEMORY_REQUEST_TIMEOUT_MS,
				),
			);
			if (!reply.memory) throw new MemoryOff();
			// This computer's own coming back is never written; whatever the host says, nothing unredacted is.
			const rows: MemoryConclusionWire[] = [];
			for (const row of reply.conclusions) {
				const clean = row.origin === self ? null : cleanConclusion(row, row.origin);
				if (clean) rows.push(clean);
			}
			// A group that fails throws before the cursor moves: the batch is read again, the written rows answer `same`.
			for (const group of groupConclusions(rows)) {
				const statuses = await this.#deps.store.writeConclusions(
					{ workspace: group.workspace, project: group.project },
					group.origin,
					group.rows,
				);
				report.conclusions.pulled += statuses.filter(status => status === "written").length;
			}
			state.conclusions = reply.next;
			if (!reply.more) return;
		}
	}

	/** Offer the host what it lacks of this computer's streams; the cursor stops at the first row it did not take. */
	async #pushConclusions(host: string, state: HostState, report: MemorySyncReport): Promise<void> {
		const self = this.#deps.selfId();
		for (const source of ["native", "synced"] as const) {
			for (let batch = 0; batch < MAX_CONCLUSION_BATCHES; batch++) {
				const page = await this.#deps.store.conclusions(source, state.conclusionsSent[source], CONCLUSION_BATCH);
				// The host's own conclusions never go back to it, and a computer's neither (`origin`).
				const entries = page.rows.map(row => {
					const origin = source === "native" ? self : row.origin;
					return { seq: row.seq, wire: origin && origin !== host ? cleanConclusion(row, origin) : null };
				});
				const wires = entries.flatMap(entry => (entry.wire ? [entry.wire] : []));
				let results: MemoryConclusionPushReply["results"] = [];
				if (wires.length > 0) {
					const reply = MemoryConclusionPushReply.parse(
						await this.#deps.request(
							host,
							MEMORY_METHODS.conclusionsPush,
							{ conclusions: wires },
							MEMORY_REQUEST_TIMEOUT_MS,
						),
					);
					if (!reply.memory) throw new MemoryOff();
					results = reply.results;
					report.conclusions.pushed += results.filter(result => result.status === "written").length;
				}
				let answered = 0;
				let reached = state.conclusionsSent[source];
				let stalled = false;
				for (const entry of entries) {
					if (entry.wire) {
						const status = results[answered++]?.status;
						if (status === undefined || status === "failed") {
							stalled = true;
							break;
						}
					}
					reached = entry.seq;
				}
				state.conclusionsSent[source] = stalled ? reached : page.next;
				if (stalled || !page.more) break;
			}
		}
	}

	#unpend(state: HostState, key: string): void {
		const at = state.pending.indexOf(key);
		if (at >= 0) state.pending.splice(at, 1);
	}

	/** Keep the newest agreement pairs only (insertion order is the order they were made in). */
	#trim(state: HostState): void {
		const keys = Object.keys(state.base);
		for (const key of keys.slice(0, Math.max(0, keys.length - BASE_LIMIT))) {
			delete state.base[key];
			delete state.remote[key];
		}
	}

	async #hostState(host: string): Promise<HostState> {
		if (!this.#file) {
			const text = await readFile(this.#deps.stateFile, "utf8").catch(() => null);
			let parsed: SyncFile | null = null;
			try {
				parsed = text ? SyncFile.parse(JSON.parse(text)) : null;
			} catch {
				parsed = null;
			}
			this.#file ??= parsed ?? { v: 1, hosts: {} };
		}
		this.#file.hosts[host] ??= freshHost();
		return this.#file.hosts[host];
	}

	#save(): Promise<void> {
		const file = this.#file;
		if (!file) return this.#saving;
		this.#saving = this.#saving.then(async () => {
			const tmp = `${this.#deps.stateFile}.tmp`;
			await mkdir(dirname(this.#deps.stateFile), { recursive: true });
			await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
			await rename(tmp, this.#deps.stateFile);
		});
		this.#saving = this.#saving.catch(() => undefined);
		return this.#saving;
	}
}
