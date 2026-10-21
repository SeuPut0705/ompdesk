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
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { redactDiagnosticsText } from "../../../resources/gui-bridge/redactor";
import type { AiMemoryPageRef, AiMemoryProject, AiMemoryProjectRef } from "../../shared/ai-memory";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { writeFileAtomic } from "../atomic-file";
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
import type { MemoryConclusionCopy, MemoryPageCopy, MemoryRepository } from "./client";

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

/** One page of a conclusion stream. */
export interface ConclusionPage {
	rows: MemoryConclusionCopy[];
	next: number;
	more: boolean;
	/** The database the seqs belong to. */
	store: string;
	/** The stream's highest seq now (0 when empty). */
	last: number;
}

/** The memory server, as the sync reads and writes it (AiMemoryClient). */
export interface MemoryStore {
	/** Each project with the repository identity it was claimed by, when one was. */
	projects(): Promise<Pick<AiMemoryProject, "workspace" | "project" | "identity" | "identitySource">[]>;
	/** Every latest page, expired ones too: a retired page must cross as retired, never be missed and re-created. */
	allPages(
		project: AiMemoryProjectRef,
	): Promise<Pick<AiMemoryPageRef, "workspace" | "project" | "path" | "updatedAt">[]>;
	pageCopy(ref: AiMemoryProjectRef & { path: string }): Promise<MemoryPageCopy>;
	/** Only over the version `expected` (a `pageCopy` id) or, with `null`, only where nothing is; false: it moved on. */
	writePageCopy(copy: MemoryPageCopy, origin: string | undefined, expected: string | null): Promise<boolean>;
	/**
	 * One conclusion stream after `after`, `seq` order (`AiMemoryClient.conclusions`): `store` names the database the
	 * seqs belong to, `last` is the stream's highest seq now.
	 */
	conclusions(source: "native" | "synced", after: number, limit: number): Promise<ConclusionPage>;
	/** Insert-if-absent under `origin`, a status per item in order (`AiMemoryClient.writeConclusions`). */
	writeConclusions(
		project: AiMemoryProjectRef,
		origin: string,
		items: Pick<MemoryConclusionCopy, "id" | "sessionId" | "title" | "body" | "at">[],
		/** The sender's repository for the project: the server files the rows under its project for it. */
		repository?: MemoryRepository,
	): Promise<("written" | "same" | "skipped")[]>;
}

type PageRef = AiMemoryProjectRef & { path: string };

/**
 * How this server names each repository's project. Two computers may name one repository differently (the paired
 * Windows host's path-style `seuput0705-ompdesk`, this Mac's `ompdesk`); a page or a conclusion carries its project's
 * repository identity and is filed under this computer's project for that repository. Without an identity on the item,
 * or a project here that holds it, the name stands, as before identities crossed.
 */
class ProjectNames {
	readonly #repositoryOf = new Map<string, MemoryRepository>();
	readonly #nameOf = new Map<string, string>();

	static async read(store: MemoryStore): Promise<ProjectNames> {
		const names = new ProjectNames();
		await names.refresh(store);
		return names;
	}

	/** Read the server's projects again (a write may just have made a repository's project). */
	async refresh(store: MemoryStore): Promise<void> {
		this.#repositoryOf.clear();
		this.#nameOf.clear();
		for (const project of await store.projects()) {
			if (!project.identity) continue;
			this.#repositoryOf.set(`${project.workspace}\u0000${project.project}`, {
				identity: project.identity,
				source: project.identitySource ?? "",
			});
			const key = `${project.workspace}\u0000${project.identity}`;
			if (!this.#nameOf.has(key)) this.#nameOf.set(key, project.project);
		}
	}

	/**
	 * Where an item written with its repository lives now. A write that made the repository's project here names it
	 * as this server does (path style: `acme-api`), not as the sender did (`team-notes`), so a repository this
	 * computer did not know is looked up again after the write.
	 */
	async landed<T extends AiMemoryProjectRef & { identity?: string }>(store: MemoryStore, item: T): Promise<T> {
		if (!item.identity || this.#nameOf.has(`${item.workspace}\u0000${item.identity}`)) return item;
		await this.refresh(store);
		return this.localize(item) ?? item;
	}

	/** The repository the project of that name here was claimed by. */
	repositoryOf(ref: AiMemoryProjectRef): MemoryRepository | undefined {
		return this.#repositoryOf.get(`${ref.workspace}\u0000${ref.project}`);
	}

	/**
	 * The item under this computer's name for its repository's project; null when the item names a repository and
	 * the project here of the same name belongs to another (the same `owner/repo` on another forge): it is never filed
	 * there. An item without an identity, or whose name holds no repository here, keeps the name.
	 */
	localize<T extends AiMemoryProjectRef & { identity?: string }>(item: T): T | null {
		if (!item.identity) return item;
		const local = this.#nameOf.get(`${item.workspace}\u0000${item.identity}`);
		if (local) return local === item.project ? item : { ...item, project: local };
		const held = this.repositoryOf(item);
		return held && held.identity !== item.identity ? null : item;
	}
}

/** The repository an item on the link names, as the server's write path takes it (both halves, or none). */
function wireRepository(item: { identity?: string; identitySource?: string }): MemoryRepository | undefined {
	return item.identity && item.identitySource ? { identity: item.identity, source: item.identitySource } : undefined;
}

/** The wire's fields for a repository. */
function repositoryFields(repository: MemoryRepository | undefined): { identity?: string; identitySource?: string } {
	return repository?.identity
		? { identity: repository.identity, ...(repository.source ? { identitySource: repository.source } : {}) }
		: {};
}

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
function toWire(
	copy: MemoryPageCopy,
	origin: string,
	at: string,
	repository?: MemoryRepository,
): MemoryPageWire | null {
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
		...repositoryFields(repository),
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
		...(wireRepository(page) ? { repository: wireRepository(page) } : {}),
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
	repository?: MemoryRepository,
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
		...repositoryFields(repository),
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
	const names = await ProjectNames.read(deps.store);
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
		const wire = toWire(copy, origin, entry.at, names.repositoryOf(entry.ref));
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
	const names = await ProjectNames.read(deps.store);
	const results: MemoryPushReply["results"] = [];
	for (const { page: sent, expect } of params.pages) {
		try {
			// Under this computer's name for the page's repository: the key, the write and every reply use it. A
			// page whose name here belongs to another repository is never written (`failed`: nothing changes).
			const page = names.localize(sent);
			if (!page) {
				results.push({ status: "failed", hash: null });
				continue;
			}
			const repository = names.repositoryOf(page);
			const incoming = fromWire(page);
			const held = index.get(pageKey(page));
			const current = held ? await deps.store.pageCopy(held.ref) : null;
			const currentHash = current ? pageHash(current) : null;
			if (currentHash !== null && currentHash === pageHash(incoming)) {
				results.push({ status: "same", hash: currentHash });
				continue;
			}
			if (current && held && currentHash !== expect) {
				const theirs = toWire(current, current.origin ?? self, held.at, repository);
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
				const theirs = toWire(moved, moved.origin ?? self, moved.updatedAt ?? "", repository);
				results.push({ status: "conflict", hash: pageHash(moved), ...(theirs ? { page: theirs } : {}) });
				continue;
			}
			results.push({
				status: "written",
				hash: pageHash(await deps.store.pageCopy(await names.landed(deps.store, page))),
			});
		} catch {
			results.push({ status: "failed", hash: null });
		}
	}
	return { memory: true, results };
}

/**
 * A page of a conclusion stream from the cursor `after`, which was read from the database `known`. Seqs restart in a
 * fresh database (delete all memory) and a restored backup rewinds them, so a cursor is good only for the store it
 * came from and while it is not past the stream's end; otherwise the page is read from 0 (`after: 0`). Offering rows
 * again is safe: a server answers `same` to a conclusion it holds.
 */
export async function readConclusions(
	store: MemoryStore,
	source: "native" | "synced",
	after: number,
	known: string | undefined,
	limit: number,
): Promise<{ page: ConclusionPage; after: number }> {
	const page = await store.conclusions(source, after, limit);
	if (after === 0 || (page.store === known && after <= page.last)) return { page, after };
	return { page: await store.conclusions(source, 0, limit), after: 0 };
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
	const names = await ProjectNames.read(deps.store);
	const conclusions: MemoryConclusionWire[] = [];
	const take = (row: MemoryConclusionCopy, origin: string | undefined): void => {
		if (!origin || origin === peer) return;
		const wire = cleanConclusion(row, origin, names.repositoryOf(row));
		if (wire) conclusions.push(wire);
	};
	const { page: native } = await readConclusions(
		deps.store,
		"native",
		params.since.native,
		params.since.store,
		CONCLUSION_BATCH,
	);
	for (const row of native.rows) take(row, self);
	// Both streams live in one database: when it is not the one the cursor came from, neither position holds.
	const next = {
		native: native.next,
		synced: native.store === params.since.store ? params.since.synced : 0,
		store: native.store,
	};
	let more = native.more;
	if (!more) {
		const room = CONCLUSION_BATCH - conclusions.length;
		if (room > 0) {
			const { page: synced } = await readConclusions(deps.store, "synced", next.synced, native.store, room);
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
	const names = await ProjectNames.read(deps.store);
	const results: MemoryConclusionPushReply["results"] = params.conclusions.map(() => ({ status: "failed" }));
	const writable: (MemoryConclusionWire & { index: number })[] = [];
	for (const [index, row] of params.conclusions.entries()) {
		if (row.origin === self) results[index] = { status: "same" };
		else {
			const local = names.localize(row);
			const clean = local && cleanConclusion(local, row.origin, wireRepository(local));
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
				wireRepository(group.rows[0] ?? {}),
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
	 * other computers), and the host's database those positions belong to (the host restarts from 0 for another).
	 * A sync.json written before conclusions existed has none: they start from the beginning.
	 */
	conclusions: MemoryConclusionCursor.default(() => ({ native: 0, synced: 0 })),
	/**
	 * The last row of each of this computer's streams (its own, the ones it holds) the host has answered for, and
	 * this computer's database they were read from (another one, or a position past a stream's end, starts over).
	 */
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
			const names = await ProjectNames.read(this.#deps.store);
			for (const page of reply.pages) {
				// Filed under this computer's name for its repository; a name here that belongs to another repository
				// takes nothing. The cursor stays in the host's own keys.
				const here = names.localize(page);
				if (here) await this.#take(host, state, here, local, report, names);
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
		names: ProjectNames,
	): Promise<void> {
		const key = pageKey(page);
		const base = state.base[key];
		state.remote[key] = page.hash;
		// The host's copy has not changed since the two agreed: anything changed here goes out with the push.
		if (base && base[1] === page.hash) return;
		const held = local.get(key);
		if (!held) return this.#write(state, page, report, null, names);
		const copy = await this.#deps.store.pageCopy(held.ref);
		const mine = pageHash(copy);
		if (mine === page.hash) {
			state.base[key] = [mine, page.hash];
			this.#unpend(state, key);
			return;
		}
		// Changed only there.
		if (base && base[0] === mine) return this.#write(state, page, report, copy.id ?? null, names);
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
		if (theirs) return this.#write(state, page, report, copy.id ?? null, names);
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
		names: ProjectNames,
	): Promise<void> {
		const key = pageKey(page);
		const origin = page.origin === this.#deps.selfId() ? undefined : page.origin;
		if (!(await this.#deps.store.writePageCopy(fromWire(page), origin, expected))) return;
		// Keyed where it landed: a repository new here gets the project name this server gives it.
		const landed = await names.landed(this.#deps.store, page);
		const at = pageKey(landed);
		state.base[at] = [pageHash(await this.#deps.store.pageCopy(landed)), page.hash];
		state.remote[at] = page.hash;
		this.#unpend(state, key);
		report.pulled++;
	}

	async #push(host: string, state: HostState, report: MemorySyncReport): Promise<void> {
		const self = this.#deps.selfId();
		const local = await durableIndex(this.#deps.store);
		const names = await ProjectNames.read(this.#deps.store);
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
					const here = names.localize(result.page);
					if (here) await this.#take(host, state, here, await durableIndex(this.#deps.store), report, names);
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
			const page = toWire(copy, copy.origin ?? self, entry.at, names.repositoryOf(entry.ref));
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
			const names = await ProjectNames.read(this.#deps.store);
			for (const row of reply.conclusions) {
				const here = row.origin === self ? null : names.localize(row);
				const clean = here && cleanConclusion(here, row.origin, wireRepository(here));
				if (clean) rows.push(clean);
			}
			// A group that fails throws before the cursor moves: the batch is read again, the written rows answer `same`.
			for (const group of groupConclusions(rows)) {
				const statuses = await this.#deps.store.writeConclusions(
					{ workspace: group.workspace, project: group.project },
					group.origin,
					group.rows,
					wireRepository(group.rows[0] ?? {}),
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
		const names = await ProjectNames.read(this.#deps.store);
		for (const source of ["native", "synced"] as const) {
			for (let batch = 0; batch < MAX_CONCLUSION_BATCHES; batch++) {
				const sent = state.conclusionsSent;
				const { page, after } = await readConclusions(
					this.#deps.store,
					source,
					sent[source],
					sent.store,
					CONCLUSION_BATCH,
				);
				if (page.store !== sent.store) {
					sent.native = 0;
					sent.synced = 0;
					sent.store = page.store;
				} else sent[source] = after;
				// The host's own conclusions never go back to it, and a computer's neither (`origin`).
				const entries = page.rows.map(row => {
					const origin = source === "native" ? self : row.origin;
					return {
						seq: row.seq,
						wire: origin && origin !== host ? cleanConclusion(row, origin, names.repositoryOf(row)) : null,
					};
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
				let reached = after;
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
			await writeFileAtomic(this.#deps.stateFile, JSON.stringify(file), { mode: 0o600 });
		});
		this.#saving = this.#saving.catch(() => undefined);
		return this.#saving;
	}
}
