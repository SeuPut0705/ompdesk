/**
 * Access to the local ai-memory server, asked through the core process (`native/ompdesk/crates/core/src/aimemory`):
 * each method here is one `aimemory.*` request, and the core does the HTTP (`/healthz`, the `/api/v1` REST reads, the
 * `/admin/*` routes, MCP `tools/call` on `/mcp`) and turns the server's JSON into these shapes. Main hands it what it
 * knows about the server with every request: its URL and ai-memory's data folder. The bearer token is the root token
 * `init` wrote into `<data dir>/auth-tokens/default` (owner-only); the core reads it per request and sends it to that
 * server only, and it never reaches the renderer.
 */
import type {
	AiMemoryDeleted,
	AiMemoryFeedback,
	AiMemoryHandoff,
	AiMemoryLintFinding,
	AiMemoryObservations,
	AiMemoryOverview,
	AiMemoryPage,
	AiMemoryPageRef,
	AiMemoryProfile,
	AiMemoryProject,
	AiMemoryProjectRef,
	AiMemorySession,
	AiMemorySweep,
	AiMemoryWriteInput,
} from "../../shared/ai-memory";
import { core } from "../core/process";

/** Where ai-memory's server listens unless its config says otherwise; the core spells it too (`aimemory/mod.rs`). */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:49374";

/**
 * How long main waits for the core. The core gives up on the server itself (2 s for `/healthz`, 10 s a read, 60 s a
 * write) and the longest request is a read followed by a write, so this only ends a wait on a core that is stuck.
 */
const CORE_TIMEOUT_MS = 80_000;

export interface ServerStatus {
	version: string | null;
	pages: number;
	sessions: number;
	observations: number;
	diskBytes: number;
}

/** The server URL ai-memory's own config names: `server_url`, else `http://<bind>`, else the default. */
export async function serverUrlFromConfig(toml: string | null): Promise<string> {
	return (await core().call<string>("aimemory.serverUrl", { toml })).result;
}

/** Where the server is, as main knows it now: what every request to the core names (`aimemory/client.rs` `Server`). */
export interface AiMemoryServer {
	url: string | null;
	dataDir: string | null;
}

export class AiMemoryClient {
	readonly #url: () => string | null;
	readonly #dataDir: () => string | null;

	constructor(deps: { url: () => string | null; dataDir: () => string | null }) {
		this.#url = deps.url;
		this.#dataDir = deps.dataDir;
	}

	server(): AiMemoryServer {
		return { url: this.#url(), dataDir: this.#dataDir() };
	}

	async #ask<T>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
		const server = this.server();
		const answer = await core().call<T>(
			`aimemory.${operation}`,
			{ server, ...params },
			{ timeoutMs: CORE_TIMEOUT_MS },
		);
		return answer.result;
	}

	/** The root bearer token, or null before `init` has written it. */
	token(): Promise<string | null> {
		return this.#ask<string | null>("token").catch(() => null);
	}

	/** `/healthz` answers (no token needed). */
	healthy(): Promise<boolean> {
		return this.#ask<boolean>("healthy").catch(() => false);
	}

	status(): Promise<ServerStatus | null> {
		return this.#ask<ServerStatus | null>("status").catch(() => null);
	}

	/** Every project, newest first. */
	projects(): Promise<AiMemoryProject[]> {
		return this.#ask("projects");
	}

	/**
	 * How the server resolves a project name (`/admin/project-coordinate`): `ambiguous` when the name is one project's
	 * name and another's canonical or legacy key, so every name read of it is refused.
	 */
	nameStatus(project: AiMemoryProjectRef): Promise<string> {
		return this.#ask("nameStatus", { project });
	}

	/**
	 * Renames by id a project no checkout ever captured into (`/admin/rename-unclaimed-project`: no repository identity,
	 * no repo path, no session, checked in the rename; else 409). The name only, no file moves; reversible. A server
	 * without the route answers 404, never an unguarded rename.
	 */
	async renameUnclaimedProject(workspace: string, projectId: string, to: string): Promise<void> {
		await this.#ask("renameUnclaimedProject", { workspace, projectId, to });
	}

	/** Full-text hits with `<mark>` stripped, in one project or all; tier and time come from the hits' projects. */
	search(query: string, project?: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return this.#ask("search", { query, project });
	}

	/** Every page of a project, newest first, with kind and tier. */
	pages(project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return this.#ask("pages", { project });
	}

	/** Counts, last capture, activity and health of one project. */
	overview(project: AiMemoryProjectRef): Promise<AiMemoryOverview> {
		return this.#ask("overview", { project });
	}

	/**
	 * The project's sessions, newest first, 30 unless `limit` says otherwise. The server answers at most 100 a call
	 * (api.rs `SESSION_LIST_MAX_LIMIT`), so a job that walks them all pages with `offset`.
	 */
	sessions(project: AiMemoryProjectRef, limit?: number, offset?: number): Promise<AiMemorySession[]> {
		return this.#ask("sessions", { project, limit, offset });
	}

	/** One session's raw observations, in capture order, read-only; `kinds` keeps only those kinds (`["user-prompt"]`). */
	observations(
		project: AiMemoryProjectRef,
		sessionId: string,
		offset = 0,
		kinds?: readonly string[],
	): Promise<AiMemoryObservations> {
		return this.#ask("observations", { project, sessionId, offset, kinds });
	}

	/** The cross-project profile: whether it is injected and its entries. */
	profile(): Promise<AiMemoryProfile> {
		return this.#ask("profile");
	}

	/** The rule-based audit (no report page is written, no LLM pass). */
	lint(project: AiMemoryProjectRef): Promise<AiMemoryLintFinding[]> {
		return this.#ask("lint", { project });
	}

	/** The retention sweep; `dryRun` reports what it would evict and changes nothing. */
	sweep(project: AiMemoryProjectRef, dryRun: boolean): Promise<AiMemorySweep> {
		return this.#ask("sweep", { project, dryRun });
	}

	/** Saves a page through ai-memory's write path (a new version; the old one stays in history). */
	async writePage(input: AiMemoryWriteInput): Promise<void> {
		await this.#ask("writePage", { input });
	}

	/**
	 * Rewrites a session page through `memory_write_page` with its session, the path the server offers for exactly
	 * this: it keeps the page's link to the session (`session_id`, `agent`), tells a title another page holds apart,
	 * and refuses (`precondition_failed`) when the page is no longer the version `expectedPageId` names.
	 */
	async writeSessionPage(
		input: AiMemoryProjectRef & {
			path: string;
			sessionId: string;
			body: string;
			expectedPageId: string;
			tier?: string;
			abstract?: string;
		},
	): Promise<void> {
		await this.#ask("writeSessionPage", { input });
	}

	/**
	 * Writes a page that does not exist yet (`create_only`), recording the session it was learned in as evidence when
	 * the page is in that session's project (the server refuses a session of another project, so a `_global` page has
	 * none). False when something already lives at the path: the page is never overwritten.
	 */
	createPage(
		input: AiMemoryProjectRef & { path: string; body: string; tier: string; kind: string; sessionId?: string },
	): Promise<boolean> {
		return this.#ask("createPage", { input });
	}

	/**
	 * Deletes a page and returns what Restore needs: the checkpoint that still holds it (the one the server saved just
	 * before the delete when the tree had unsaved changes, else the newest one, read before the call).
	 */
	deletePage(ref: AiMemoryProjectRef & { path: string; title?: string }): Promise<AiMemoryDeleted> {
		return this.#ask("deletePage", { ref });
	}

	/** The newest wiki checkpoint ("" before the first one): `restorePage` brings a page back as it stood there. */
	headCheckpoint(): Promise<string> {
		return this.#ask("headCheckpoint");
	}

	async restorePage(ref: AiMemoryProjectRef & { path: string }, rev: string): Promise<void> {
		await this.#ask("restorePage", { ref, rev });
	}

	/** `stale` and `wrong` also floor the page's salience and list it in the next lint (memory upkeep's flag). */
	async feedback(
		ref: AiMemoryProjectRef & { path: string },
		signal: AiMemoryFeedback | "stale" | "wrong",
	): Promise<void> {
		await this.#ask("feedback", { ref, signal });
	}

	/** Discards an open handoff (the next session in that folder no longer starts with it). */
	async cancelHandoff(project: AiMemoryProjectRef, id: string): Promise<void> {
		await this.#ask("cancelHandoff", { project, id });
	}

	/** A project's recently changed pages, at most 20. */
	recent(project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return this.#ask("recent", { project });
	}

	/** Recent pages of the most recently updated projects, merged newest first. */
	recentEverywhere(): Promise<AiMemoryPageRef[]> {
		return this.#ask("recentEverywhere");
	}

	/** The handoffs of one project, or of the most recently updated projects merged, newest first. */
	handoffs(project?: AiMemoryProjectRef): Promise<AiMemoryHandoff[]> {
		return this.#ask("handoffs", { project });
	}

	page(ref: AiMemoryProjectRef & { path: string }): Promise<AiMemoryPage> {
		return this.#ask("page", { ref });
	}

	/**
	 * Takes a page out of default recall, because a newer page replaces it or it went stale: the same page again through
	 * `memory_write_page` with `expires_at` = `at`. The server hides an expired page from `memory_query`, search, recent
	 * and the page list by default, while an exact read still answers. What the write path takes of the page's own
	 * metadata goes back (title, kind, abstract, entities, relations, tags; not `summary` or profile keys), plus the tag
	 * `superseded` and a closing line naming the successor, or, when no page replaces it, the tag `retired` and the
	 * reason. ai-memory's daily forget sweep later hard-deletes an expired page; only the wiki's git checkpoints keep it
	 * then. A pinned page is the owner's and is never retired. `changed` when the page is no longer the version
	 * `expectedPageId` names (the one the caller judged), or moved on during the write.
	 */
	retirePage(
		ref: AiMemoryProjectRef & {
			path: string;
			at: Date;
			expectedPageId?: string;
			successor?: string;
			reason?: string;
		},
	): Promise<"retired" | "pinned" | "changed"> {
		return this.#ask("retirePage", { ref });
	}

	/** One page whole, as a copy on another of the person's computers needs it (sync.ts). */
	pageCopy(ref: AiMemoryProjectRef & { path: string }): Promise<MemoryPageCopy> {
		return this.#ask("pageCopy", { ref });
	}

	/**
	 * Writes a copy of a page another computer holds, through the server's write path: a new version here with the
	 * same title, kind, tier, tags, pin and metadata, marked `origin_device` with the computer it came from (omitted:
	 * the page is this computer's own). Only over the version `expected` names (the id `pageCopy` read), or, with
	 * `null`, only where nothing is yet; false when the page moved on meanwhile and nothing was written.
	 */
	writePageCopy(copy: MemoryPageCopy, origin: string | undefined, expected: string | null): Promise<boolean> {
		return this.#ask("writePageCopy", { copy, origin, expected });
	}

	/** Every latest page of a project, expired (retired) ones too, which the page list hides: for sync.ts. */
	allPages(project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return this.#ask("allPages", { project });
	}

	/**
	 * One stream of session conclusions (Stop observations with a body) in `seq` order, for sync.ts: `native` is what
	 * this server captured, `synced` what it holds from the person's other computers (each row names its origin).
	 * `next` is the seq of the last row returned (`after` when none); `more`: rows are left after it. `store` names the
	 * database the seqs belong to ("" from a server that does not say) and `last` is the highest seq in this stream now:
	 * a cursor is good only for the same `store` and while it is not past `last`.
	 */
	conclusions(
		source: "native" | "synced",
		after: number,
		limit: number,
	): Promise<{ rows: MemoryConclusionCopy[]; next: number; more: boolean; store: string; last: number }> {
		return this.#ask("conclusions", { source, after, limit });
	}

	/**
	 * Inserts conclusions captured on the computer `origin`, each only where this server holds none with that id
	 * (never overwritten): `written`, `same` (held already) or `skipped` (nothing left of it after the server's own
	 * scrubbing). Results are in the order of `items`.
	 */
	writeConclusions(
		project: AiMemoryProjectRef,
		origin: string,
		items: Pick<MemoryConclusionCopy, "id" | "sessionId" | "title" | "body" | "at">[],
		repository?: MemoryRepository,
	): Promise<("written" | "same" | "skipped")[]> {
		return this.#ask("writeConclusions", { project, origin, items, repository });
	}
}

/** The write path's own frontmatter fields (beside kind, title, tags and pin), as a page stores them. */
export interface MemoryPageMetadata {
	entities?: string[];
	abstract?: string;
	relations?: Record<string, string[]>;
	applies_to?: string[];
	enforced_by?: string;
}

/**
 * The repository identity a project was claimed by, as the server lists it (`identity`, `identity_source`). A synced
 * copy written with it lands in this computer's project for that repository (`/admin/write-page`'s `identity`).
 */
export interface MemoryRepository {
	identity: string;
	source: string;
}

/** A session conclusion as `conclusions` reads it (a Stop observation's body, ≤ 2000 bytes, already redacted). */
export interface MemoryConclusionCopy extends AiMemoryProjectRef {
	/** Position in its stream (`source`): the cursor sync.ts goes on from. */
	seq: number;
	/** The observation id (native) or the id the row was written with (synced). */
	id: string;
	sessionId: string;
	title: string;
	body: string;
	/** When it was captured, RFC 3339. */
	at: string;
	/** Synced rows only: the OMPdesk device id of the computer that captured it. */
	origin?: string;
}

/** A page as `pageCopy` reads it and `writePageCopy` writes it. */
export interface MemoryPageCopy extends AiMemoryProjectRef {
	path: string;
	title: string;
	kind?: string;
	tier: string;
	body: string;
	tags: string[];
	pinned: boolean;
	metadata: MemoryPageMetadata;
	/** The computer (OMPdesk device id) this copy came from; absent on a page made or edited here. */
	origin?: string;
	/** Frontmatter `expires_at`: set on a page retired by a newer one (or written with a time limit). */
	expiresAt?: string;
	/** The version read (the server's page id): a copy written over this page names it, so a change in between wins. */
	id?: string;
	/** On a write: the sender's repository for its project, so the copy lands where this computer files it. */
	repository?: MemoryRepository;
	updatedAt: string | null;
}
