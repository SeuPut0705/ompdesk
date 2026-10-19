/**
 * Memory shared between a person's paired computers (C8): a decision, rule, gotcha, procedure, preference or profile
 * entry made on one computer is in the other's memory server too, so a session the Mac opens on the Windows host
 * recalls the Mac's decisions there. Only durable pages cross (`isDurablePath`); session pages and raw observations
 * stay where they were captured. Deletes do not cross.
 *
 * The device that connected to a host drives both directions over its link (the link only carries requests that
 * way): `host.memory.pull` brings the host's pages changed after a cursor, `host.memory.push` sends this computer's
 * pages changed since it last looked. The host serves both with `servePull`/`servePush` on its own server.
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
import type { AiMemoryPageRef, AiMemoryProjectRef } from "../../shared/ai-memory";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import {
	isDurablePath,
	MEMORY_METHODS,
	MEMORY_PAGE_MAX_BYTES,
	MEMORY_REQUEST_TIMEOUT_MS,
	MemoryCursor,
	MemoryPageWire,
	type MemoryPullParams,
	MemoryPullReply,
	type MemoryPushParams,
	MemoryPushReply,
} from "../remote/app-protocol";
import type { MemoryPageCopy } from "./client";

/** While a host is connected and memory is on, they sync this often (and whenever the link comes up). */
export const MEMORY_SYNC_INTERVAL_MS = 5 * 60_000;
/** Pages and body bytes one pull or push batch carries at most. */
const BATCH_PAGES = 25;
const BATCH_BYTES = 1_000_000;
/** One round pulls at most this many batches; the next round goes on from the cursor. */
const MAX_PULL_BATCHES = 40;
/** Agreement pairs kept per host (a person has hundreds of durable pages, not thousands). */
const BASE_LIMIT = 10_000;

/** The memory server, as the sync reads and writes it (AiMemoryClient). */
export interface MemoryStore {
	projects(): Promise<AiMemoryProjectRef[]>;
	pages(project: AiMemoryProjectRef): Promise<Pick<AiMemoryPageRef, "workspace" | "project" | "path" | "updatedAt">[]>;
	pageCopy(ref: AiMemoryProjectRef & { path: string }): Promise<MemoryPageCopy>;
	writePageCopy(copy: MemoryPageCopy, origin: string | undefined): Promise<void>;
}

type PageRef = AiMemoryProjectRef & { path: string };

export function pageKey(ref: PageRef): string {
	return `${ref.workspace}\u0000${ref.project}\u0000${ref.path}`;
}

/** What a page holds, independent of where it lives, when it changed, its pin and where it came from. */
export function pageHash(page: Pick<MemoryPageCopy, "title" | "kind" | "tier" | "body" | "tags" | "metadata">): string {
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
		for (const page of await store.pages({ workspace: project.workspace, project: project.project })) {
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
		updatedAt: page.updatedAt || null,
	};
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
		next = cursor;
		const copy = await deps.store.pageCopy(entry.ref).catch(() => null);
		if (!copy) continue;
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
			await deps.store.writePageCopy(incoming, page.origin === self ? undefined : page.origin);
			results.push({ status: "written", hash: pageHash(await deps.store.pageCopy(page)) });
		} catch {
			results.push({ status: "failed", hash: null });
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
});
type HostState = z.infer<typeof HostState>;
const SyncFile = z.object({ v: z.literal(1), hosts: z.record(HostState) });
type SyncFile = z.infer<typeof SyncFile>;

function freshHost(): HostState {
	return { pull: null, push: "", base: {}, remote: {}, pending: [] };
}

export interface MemorySyncReport {
	pulled: number;
	pushed: number;
	conflicts: number;
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
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(deps: MemorySyncDeps) {
		this.#deps = deps;
	}

	start(): void {
		this.#timer = setInterval(() => this.syncAll(), this.#deps.intervalMs ?? MEMORY_SYNC_INTERVAL_MS);
		this.#timer.unref?.();
	}

	/** A host's link came up: it may run a newer OMPdesk now, and its pages may have changed meanwhile. */
	hostOnline(host: string): void {
		this.#unsupported.delete(host);
		void this.sync(host);
	}

	syncAll(): void {
		for (const host of this.#deps.onlineHosts()) void this.sync(host);
	}

	/** One round with `host`: pull, then push. Null when nothing ran (memory off on either side, an older host). */
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
		const report: MemorySyncReport = { pulled: 0, pushed: 0, conflicts: 0 };
		let step = "pull";
		try {
			await this.#pull(host, state, report);
			step = "push";
			await this.#push(host, state, report);
		} catch (error) {
			if (error instanceof MemoryOff) return null;
			if (ipcErrorCode(error) === "unsupported") {
				this.#unsupported.add(host);
				this.#deps.log("unsupported", { host });
				return null;
			}
			this.#deps.log("failed", { host, step, error: error instanceof Error ? error.message : String(error) });
			return null;
		} finally {
			this.#trim(state);
			await this.#save();
		}
		if (report.pulled + report.pushed + report.conflicts > 0)
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
		if (!held) return this.#write(state, page, report);
		const mine = pageHash(await this.#deps.store.pageCopy(held.ref));
		if (mine === page.hash) {
			state.base[key] = [mine, page.hash];
			this.#unpend(state, key);
			return;
		}
		// Changed only there.
		if (base && base[0] === mine) return this.#write(state, page, report);
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
		if (theirs) return this.#write(state, page, report);
		if (!state.pending.includes(key)) state.pending.push(key);
	}

	async #write(state: HostState, page: MemoryPageWire, report: MemorySyncReport): Promise<void> {
		const key = pageKey(page);
		await this.#deps.store.writePageCopy(
			fromWire(page),
			page.origin === this.#deps.selfId() ? undefined : page.origin,
		);
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
			if (!copy) continue;
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
