/**
 * Access to the local ai-memory server. Reads: `/healthz`, `/admin/status` and the `/api/v1` REST surface the server
 * mounts with `--enable-web` (which is read-only by construction). Writes go through the server's own write path, never
 * to its files: `/admin/write-page`, `/admin/delete-page`, `/admin/restore-page`, `/admin/lint`, `/admin/forget-sweep`,
 * `/admin/write-conclusions` (and `/admin/conclusions` reads the streams sync.ts shares between computers),
 * and the two actions the REST surface lacks (`memory_feedback`, `memory_handoff_cancel`) as MCP `tools/call` on
 * `/mcp`. The bearer token is the root token `init` wrote into `<data dir>/auth-tokens/default` (owner-only); it is
 * read here in main and never reaches the renderer.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

export const DEFAULT_SERVER_URL = "http://127.0.0.1:49374";
const HEALTH_TIMEOUT_MS = 2_000;
const READ_TIMEOUT_MS = 10_000;
/** How many projects a merged (all projects) list reads, newest first. */
const MERGE_PROJECTS = 12;
const LIST_LIMIT = 20;
/** Search shows more than the recent lists do. */
const SEARCH_LIMIT = 30;
const SESSION_LIMIT = 30;
const OBSERVATION_LIMIT = 50;
/** A lint pass, a sweep and a write touch the disk and the index: more time than a read. */
const WRITE_TIMEOUT_MS = 60_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ServerStatus {
	version: string | null;
	pages: number;
	sessions: number;
	observations: number;
	diskBytes: number;
}

/** The server URL ai-memory's own config names: `server_url`, else `http://<bind>`, else the default. */
export function serverUrlFromConfig(toml: string | null): string {
	if (toml) {
		const explicit = /^\s*server_url\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
		if (explicit) return explicit.replace(/\/+$/, "");
		const bind = /^\s*bind\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
		if (bind) return `http://${bind}`;
	}
	return DEFAULT_SERVER_URL;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function rows(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
		: [];
}

/** ai-memory marks search hits with `<mark>`; the panel shows plain text. */
export function plainSnippet(snippet: string): string {
	return snippet.replace(/<\/?mark>/g, "");
}

function projectOf(ref: AiMemoryProjectRef): AiMemoryProjectRef {
	return { workspace: ref.workspace, project: ref.project };
}

function sessionRow(row: Record<string, unknown>): AiMemorySession {
	return {
		id: str(row.session_id),
		cwd: str(row.cwd),
		agent: str(row.agent_kind),
		startedAt: str(row.started_at) || null,
		endedAt: str(row.ended_at) || null,
		observations: num(row.observation_count),
		consolidation: str(record(row.consolidation).state) || null,
	};
}

function byNewest<T extends { updatedAt?: string | null; createdAt?: string | null }>(a: T, b: T): number {
	const x = a.updatedAt ?? a.createdAt ?? "";
	const y = b.updatedAt ?? b.createdAt ?? "";
	return x < y ? 1 : x > y ? -1 : 0;
}

export class AiMemoryClient {
	readonly #url: () => string | null;
	readonly #dataDir: () => string | null;
	readonly #fetch: Fetch;

	constructor(deps: { url: () => string | null; dataDir: () => string | null; fetch?: Fetch }) {
		this.#url = deps.url;
		this.#dataDir = deps.dataDir;
		this.#fetch = deps.fetch ?? ((url, init) => fetch(url, init));
	}

	/** The root bearer token, or null before `init` has written it. */
	async token(): Promise<string | null> {
		const dir = this.#dataDir();
		if (!dir) return null;
		const text = await readFile(join(dir, "auth-tokens", "default"), "utf8").catch(() => null);
		return text?.trim() || null;
	}

	/** `/healthz` answers (no token needed). */
	async healthy(): Promise<boolean> {
		const url = this.#url();
		if (!url) return false;
		try {
			const response = await this.#fetch(`${url}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
			return response.ok;
		} catch {
			return false;
		}
	}

	async #get(path: string): Promise<unknown> {
		return this.#send(path, undefined, READ_TIMEOUT_MS);
	}

	async #post(path: string, body: unknown): Promise<unknown> {
		return this.#send(path, body, WRITE_TIMEOUT_MS);
	}

	async #send(path: string, body: unknown, timeoutMs: number, accept?: string): Promise<unknown> {
		const url = this.#url();
		if (!url) throw new Error("Memory is not running");
		const token = await this.token();
		const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
		if (body !== undefined) headers["content-type"] = "application/json";
		if (accept) headers.accept = accept;
		let response: Response;
		try {
			response = await this.#fetch(`${url}${path}`, {
				...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
				headers,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			throw new Error("Memory is not running");
		}
		if (!response.ok) {
			const detail = record(await response.json().catch(() => null)).error;
			throw new Error(typeof detail === "string" && detail ? detail : `Memory answered ${response.status}`);
		}
		return response.json();
	}

	/** A tool the REST surface has no route for (`memory_feedback`, `memory_handoff_cancel`): MCP `tools/call`, one request, no session. */
	async #tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const body = record(
			await this.#send(
				"/mcp",
				{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
				WRITE_TIMEOUT_MS,
				"application/json, text/event-stream",
			),
		);
		const error = record(body.error).message;
		if (typeof error === "string") throw new Error(error);
		const result = record(body.result);
		const text = rows(result.content)
			.map(part => str(part.text))
			.join("");
		if (result.isError === true) throw new Error(text || `${name} failed`);
		try {
			return record(JSON.parse(text));
		} catch {
			return {};
		}
	}

	async status(): Promise<ServerStatus | null> {
		try {
			const body = (await this.#get("/admin/status")) as Record<string, unknown>;
			const counts = (body.counts ?? {}) as Record<string, unknown>;
			const storage = (body.storage ?? {}) as Record<string, unknown>;
			return {
				version: str(body.version) || null,
				pages: num(counts.pages_latest),
				sessions: num(counts.sessions),
				observations: num(counts.observations),
				diskBytes: num(storage.database_bytes),
			};
		} catch {
			return null;
		}
	}

	async projects(): Promise<AiMemoryProject[]> {
		const projects = rows(await this.#get("/api/v1/projects")).map(row => ({
			workspace: str(row.workspace_name),
			project: str(row.project_name),
			pages: num(row.page_count),
			lastUpdated: str(row.last_updated) || null,
		}));
		return projects.sort((a, b) => ((a.lastUpdated ?? "") < (b.lastUpdated ?? "") ? 1 : -1));
	}

	async search(query: string, project?: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		const text = query.trim();
		if (!text) return [];
		const params = new URLSearchParams({ q: text, limit: String(SEARCH_LIMIT) });
		if (project) {
			params.set("workspace", project.workspace);
			params.set("project", project.project);
		}
		const hits = rows(await this.#get(`/api/v1/search?${params}`)).map(row => ({
			workspace: str(row.workspace),
			project: str(row.project),
			path: str(row.path),
			title: str(row.title),
			kind: str(row.kind) || undefined,
			updatedAt: str(row.updated_at) || null,
			snippet: plainSnippet(str(row.snippet)),
		}));
		// A hit carries no tier and no time: they come from the page lists of the projects the hits sit in.
		const lists = new Map<string, Promise<AiMemoryPageRef[]>>();
		for (const hit of hits) {
			const key = `${hit.workspace}\u0000${hit.project}`;
			if (!lists.has(key))
				lists.set(
					key,
					this.pages(hit).catch(() => []),
				);
		}
		const known = new Map<string, AiMemoryPageRef>();
		for (const [key, list] of lists) for (const page of await list) known.set(`${key}\u0000${page.path}`, page);
		return hits.map(hit => {
			const page = known.get(`${hit.workspace}\u0000${hit.project}\u0000${hit.path}`);
			return {
				...hit,
				kind: hit.kind ?? page?.kind,
				tier: page?.tier ?? null,
				updatedAt: hit.updatedAt ?? page?.updatedAt ?? null,
			};
		});
	}

	/** Every page of a project, newest first, with kind and tier. */
	async pages(project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return rows(await this.#get(`${this.#projectPath(project)}/pages`))
			.map(row => ({
				...project,
				path: str(row.path),
				title: str(row.title),
				kind: str(row.kind) || undefined,
				tier: str(row.tier) || null,
				updatedAt: str(row.updated_at) || null,
			}))
			.sort(byNewest);
	}

	/** Counts, last capture, activity and health of one project. */
	async overview(project: AiMemoryProjectRef): Promise<AiMemoryOverview> {
		const body = record(await this.#get(`${this.#projectPath(project)}/overview?limit=1`));
		const briefing = record(body.briefing);
		const counts = record(briefing.counts);
		const activity = record(briefing.activity_7d);
		const health = record(body.health);
		return {
			pages: num(counts.pages_latest),
			sessions: num(counts.sessions),
			observations: num(counts.observations),
			lastCaptureAt: str(briefing.last_observation_at) || null,
			openHandoffs: num(briefing.pending_handoff_count),
			activity7d: {
				sessions: num(activity.sessions),
				observations: num(activity.observations),
				pagesUpdated: num(activity.pages_updated),
			},
			health: {
				stale: num(health.stale),
				duplicates: num(health.duplicates),
				contradictions: num(health.contradictions),
				orphans: num(health.orphans),
			},
		};
	}

	/** The project's sessions, newest first (`limit` more than the page shows, for a job that walks them all). */
	async sessions(project: AiMemoryProjectRef, limit = SESSION_LIMIT): Promise<AiMemorySession[]> {
		const body = record(await this.#get(`${this.#projectPath(project)}/sessions?limit=${limit}&include_open=true`));
		return rows(body.sessions).map(sessionRow);
	}

	/** One session's raw observations, in capture order, read-only; `kinds` keeps only those kinds (`["user-prompt"]`). */
	async observations(
		project: AiMemoryProjectRef,
		sessionId: string,
		offset = 0,
		kinds?: readonly string[],
	): Promise<AiMemoryObservations> {
		const id = encodeURIComponent(sessionId);
		const only = kinds?.length ? `&kinds=${encodeURIComponent(kinds.join(","))}` : "";
		const body = record(
			await this.#get(
				`${this.#projectPath(project)}/sessions/${id}/observations?limit=${OBSERVATION_LIMIT}&offset=${Math.max(0, Math.floor(offset))}&body_max_chars=2000${only}`,
			),
		);
		return {
			session: sessionRow(record(body.session)),
			observations: rows(body.observations).map(row => ({
				id: str(row.id),
				kind: str(row.kind),
				title: str(row.title),
				body: str(row.body),
				createdAt: str(row.created_at) || null,
			})),
			total: num(body.total),
			offset: num(body.offset),
		};
	}

	/** The cross-project profile: whether it is injected and its entries. */
	async profile(): Promise<AiMemoryProfile> {
		const [status, list] = await Promise.all([
			this.#get("/admin/profile/status").then(record),
			this.#get("/admin/profile/list").then(record),
		]);
		const scope = record(list.scope);
		const entries = rows(list.entries).map(row => ({
			path: str(row.path),
			category: str(row.category),
			statement: str(row.statement),
			appliesTo: strings(row.applies_to),
			enforcedBy: str(row.enforced_by) || null,
		}));
		return {
			enabled: status.effective_share !== "off" && status.enabled !== "off" && status.enabled !== false,
			injected: status.inject_on_session_start === true,
			digestBytes: num(status.digest_bytes),
			scope:
				str(scope.workspace) && str(scope.project)
					? { workspace: str(scope.workspace), project: str(scope.project) }
					: null,
			entries,
		};
	}

	/** The rule-based audit (no report page is written, no LLM pass). */
	async lint(project: AiMemoryProjectRef): Promise<AiMemoryLintFinding[]> {
		const body = record(await this.#post("/admin/lint", { ...project, dry_run: true, no_llm: true }));
		return rows(body.findings).map(row => ({
			kind: str(row.kind),
			severity: str(row.severity),
			message: str(row.message),
			pages: strings(row.pages),
		}));
	}

	/** The retention sweep; `dryRun` reports what it would evict and changes nothing. */
	async sweep(project: AiMemoryProjectRef, dryRun: boolean): Promise<AiMemorySweep> {
		const body = record(await this.#post("/admin/forget-sweep", { ...project, dry_run: dryRun }));
		const count = (value: unknown): number => (Array.isArray(value) ? value.length : num(value));
		return {
			dryRun: body.dry_run === true,
			evaluated: num(body.candidates_evaluated),
			evicted: count(body.evicted),
			compacted: count(body.compacted),
			merged: count(body.merged),
			expired: count(body.expired),
			observationsPruned: dryRun ? num(body.observations_prunable) : num(body.observations_pruned),
		};
	}

	/** Saves a page through ai-memory's write path (a new version; the old one stays in history). */
	async writePage(input: AiMemoryWriteInput): Promise<void> {
		const body: Record<string, unknown> = {
			workspace: input.workspace,
			project: input.project,
			path: input.path,
			body: input.body,
		};
		if (input.title) body.title = input.title;
		if (input.kind) body.kind = input.kind;
		if (input.tier) body.tier = input.tier;
		if (input.tags) body.tags = input.tags;
		if (input.pinned !== undefined) body.pinned = input.pinned;
		await this.#post("/admin/write-page", body);
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
		await this.#tool("memory_write_page", {
			...projectOf(input),
			path: input.path,
			body: input.body,
			tier: input.tier ?? "episodic",
			session_id: input.sessionId,
			expected_page_id: input.expectedPageId,
			...(input.abstract ? { abstract: input.abstract } : {}),
		});
	}

	/**
	 * Writes a page that does not exist yet (`create_only`), recording the session it was learned in as evidence when
	 * the page is in that session's project (the server refuses a session of another project, so a `_global` page has
	 * none). False when something already lives at the path: the page is never overwritten.
	 */
	async createPage(
		input: AiMemoryProjectRef & { path: string; body: string; tier: string; kind: string; sessionId?: string },
	): Promise<boolean> {
		try {
			await this.#tool("memory_write_page", {
				...projectOf(input),
				path: input.path,
				body: input.body,
				tier: input.tier,
				kind: input.kind,
				...(input.sessionId ? { session_id: input.sessionId } : {}),
				create_only: true,
			});
			return true;
		} catch (error) {
			if (error instanceof Error && /precondition/i.test(error.message)) return false;
			throw error;
		}
	}

	/**
	 * Deletes a page and returns what Restore needs: the checkpoint that still holds it (the one the server saved just
	 * before the delete when the tree had unsaved changes, else the newest one, read before the call).
	 */
	async deletePage(ref: AiMemoryProjectRef & { path: string; title?: string }): Promise<AiMemoryDeleted> {
		const head = str(rows(await this.#get("/admin/checkpoints?limit=1"))[0]?.oid);
		const body = record(await this.#post("/admin/delete-page", { ...projectOf(ref), path: ref.path }));
		const rev = str(body.pre_checkpoint) || head;
		if (!rev) throw new Error("Memory kept no checkpoint of this page");
		return {
			...projectOf(ref),
			path: ref.path,
			title: ref.title ?? ref.path,
			rev,
			deletedAt: new Date().toISOString(),
		};
	}

	async restorePage(ref: AiMemoryProjectRef & { path: string }, rev: string): Promise<void> {
		await this.#post("/admin/restore-page", { ...projectOf(ref), path: ref.path, rev });
	}

	async feedback(ref: AiMemoryProjectRef & { path: string }, signal: AiMemoryFeedback): Promise<void> {
		await this.#tool("memory_feedback", { ...projectOf(ref), path: ref.path, signal });
	}

	/** Discards an open handoff (the next session in that folder no longer starts with it). */
	async cancelHandoff(project: AiMemoryProjectRef, id: string): Promise<void> {
		const result = await this.#tool("memory_handoff_cancel", { ...projectOf(project), handoff_id: id });
		if (result.cancelled === false && result.state !== "expired") throw new Error("The handoff is no longer open");
	}

	#projectPath(project: AiMemoryProjectRef): string {
		return `/api/v1/workspaces/${encodeURIComponent(project.workspace)}/projects/${encodeURIComponent(project.project)}`;
	}

	async recent(project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		const list = rows(await this.#get(`${this.#projectPath(project)}/recent`));
		return list.slice(0, LIST_LIMIT).map(row => ({
			...project,
			path: str(row.path),
			title: str(row.title),
			kind: str(row.kind) || undefined,
			tier: str(row.tier) || null,
			updatedAt: str(row.updated_at) || null,
		}));
	}

	/** Recent pages of the most recently updated projects, merged newest first. */
	async recentEverywhere(): Promise<AiMemoryPageRef[]> {
		const projects = (await this.projects()).slice(0, MERGE_PROJECTS);
		const lists = await Promise.all(projects.map(project => this.recent(project).catch(() => [])));
		return lists.flat().sort(byNewest).slice(0, LIST_LIMIT);
	}

	async handoffs(project?: AiMemoryProjectRef): Promise<AiMemoryHandoff[]> {
		const targets = project ? [project] : (await this.projects()).slice(0, MERGE_PROJECTS);
		const lists = await Promise.all(
			targets.map(async target => {
				const body = (await this.#get(`${this.#projectPath(target)}/handoffs`).catch(() => null)) as {
					handoffs?: unknown;
				} | null;
				return rows(body?.handoffs).map(row => ({
					...target,
					id: str(row.id),
					agent: str(row.agent),
					createdAt: str(row.at) || null,
					summary: str(row.summary),
					openQuestions: strings(row.open_questions),
					nextSteps: strings(row.next_steps),
					state: str(row.state),
				}));
			}),
		);
		return lists
			.flat()
			.sort(byNewest)
			.slice(0, LIST_LIMIT * 2);
	}

	async page(ref: AiMemoryProjectRef & { path: string }): Promise<AiMemoryPage> {
		const path = ref.path.split("/").map(encodeURIComponent).join("/");
		const row = (await this.#get(`${this.#projectPath(ref)}/pages/${path}`)) as Record<string, unknown>;
		return {
			workspace: ref.workspace,
			project: ref.project,
			path: ref.path,
			title: str(row.title) || ref.path,
			updatedAt: str(row.updated_at) || null,
			kind: str(row.kind) || undefined,
			tier: str(row.tier) || null,
			markdown: str(row.body_markdown),
			id: str(row.id),
			pinned: row.pinned === true,
			createdAt: str(row.created_at) || null,
			tags: strings(record(row.frontmatter).tags),
			summary: str(record(row.frontmatter).summary) || undefined,
		};
	}

	/**
	 * Takes a page out of default recall, because a newer page replaces it: the same page again through
	 * `memory_write_page` with `expires_at` now. The server keeps that frontmatter key as the page's TTL (wiki.rs
	 * `parse_expires_at`) and hides an expired page from `memory_query`, search, recent and the page list by default
	 * (`not_expired`, reader.rs:51; `include_expired` is false unless asked, server.rs:2721; api.rs:178), while an exact
	 * read still answers. The write replaces all metadata, so what the write path takes of the page's own goes back
	 * (title, kind, abstract, entities, relations, tags; not `summary` or profile keys), plus the tag `superseded` and a
	 * closing line naming the successor (the write path takes no free frontmatter key, so no `superseded_by:`).
	 * ai-memory's daily forget sweep later hard-deletes an expired page (sweep.rs:11-15); only the wiki's git
	 * checkpoints keep it then. A pinned page is the owner's and is never retired. `changed` when the page is no longer
	 * the version `expectedPageId` names (the one the caller judged), or moved on during the write.
	 */
	async retirePage(
		ref: AiMemoryProjectRef & { path: string; successor: string; at: Date; expectedPageId?: string },
	): Promise<"retired" | "pinned" | "changed"> {
		const path = ref.path.split("/").map(encodeURIComponent).join("/");
		const row = record(await this.#get(`${this.#projectPath(ref)}/pages/${path}`));
		const frontmatter = record(row.frontmatter);
		if (row.pinned === true || frontmatter.pinned === true) return "pinned";
		const id = str(row.id);
		if (!id || (ref.expectedPageId && id !== ref.expectedPageId)) return "changed";
		// The server refuses the whole write over metadata outside its bounds (`PageWriteMetadata::into_frontmatter`):
		// three relation kinds, 10 entities, a 1024-character abstract. Anything else stays behind with the old version.
		const relations = Object.fromEntries(
			["causes", "fixes", "contradicts"]
				.map(kind => [kind, strings(record(frontmatter.relations)[kind])] as const)
				.filter(([, targets]) => targets.length > 0),
		);
		const abstract = str(frontmatter.abstract);
		const note = `_Superseded by [[${ref.successor}]] on ${ref.at.toISOString().slice(0, 10)} (memory upkeep)._`;
		try {
			await this.#tool("memory_write_page", {
				...projectOf(ref),
				path: ref.path,
				body: `${str(row.body_markdown).trimEnd()}\n\n${note}\n`,
				...(str(row.tier) ? { tier: str(row.tier) } : {}),
				...(str(frontmatter.title) ? { title: str(frontmatter.title) } : {}),
				...(str(frontmatter.kind) ? { kind: str(frontmatter.kind) } : {}),
				...(abstract && abstract.length <= 1024 ? { abstract } : {}),
				...(strings(frontmatter.entities).length ? { entities: strings(frontmatter.entities).slice(0, 10) } : {}),
				...(Object.keys(relations).length ? { relations } : {}),
				tags: [...new Set([...strings(frontmatter.tags), "superseded"])],
				expires_at: ref.at.toISOString(),
				expected_page_id: id,
			});
			return "retired";
		} catch (error) {
			if (error instanceof Error && /precondition/i.test(error.message)) return "changed";
			throw error;
		}
	}

	/** One page whole, as a copy on another of the person's computers needs it (sync.ts). */
	async pageCopy(ref: AiMemoryProjectRef & { path: string }): Promise<MemoryPageCopy> {
		const path = ref.path.split("/").map(encodeURIComponent).join("/");
		const row = record(await this.#get(`${this.#projectPath(ref)}/pages/${path}`));
		const frontmatter = record(row.frontmatter);
		const metadata: MemoryPageMetadata = {};
		const entities = strings(frontmatter.entities);
		if (entities.length) metadata.entities = entities;
		if (str(frontmatter.abstract)) metadata.abstract = str(frontmatter.abstract);
		const relations: Record<string, string[]> = {};
		for (const [relation, targets] of Object.entries(record(frontmatter.relations))) {
			if (strings(targets).length) relations[relation] = strings(targets);
		}
		if (Object.keys(relations).length) metadata.relations = relations;
		const appliesTo = strings(frontmatter.applies_to);
		if (appliesTo.length) metadata.applies_to = appliesTo;
		if (str(frontmatter.enforced_by)) metadata.enforced_by = str(frontmatter.enforced_by);
		const kind = str(row.kind) || str(frontmatter.kind);
		const origin = str(frontmatter.origin_device).trim();
		const expiresAt = str(frontmatter.expires_at).trim();
		return {
			...projectOf(ref),
			path: ref.path,
			title: str(row.title) || ref.path,
			...(kind ? { kind } : {}),
			tier: str(row.tier) || "semantic",
			body: str(row.body_markdown),
			tags: strings(frontmatter.tags),
			pinned: row.pinned === true,
			metadata,
			...(origin ? { origin } : {}),
			...(expiresAt ? { expiresAt } : {}),
			...(str(row.id) ? { id: str(row.id) } : {}),
			updatedAt: str(row.updated_at) || null,
		};
	}

	/**
	 * Writes a copy of a page another computer holds, through the server's write path: a new version here with the
	 * same title, kind, tier, tags, pin and metadata, marked `origin_device` with the computer it came from (omitted:
	 * the page is this computer's own). Only over the version `expected` names (the id `pageCopy` read), or, with
	 * `null`, only where nothing is yet; false when the page moved on meanwhile and nothing was written.
	 */
	async writePageCopy(copy: MemoryPageCopy, origin: string | undefined, expected: string | null): Promise<boolean> {
		try {
			await this.#post("/admin/write-page", {
				...projectOf(copy),
				path: copy.path,
				body: copy.body,
				title: copy.title,
				...(copy.kind ? { kind: copy.kind } : {}),
				tier: copy.tier,
				tags: copy.tags,
				pinned: copy.pinned,
				...copy.metadata,
				...(origin ? { origin_device: origin } : {}),
				...(copy.expiresAt ? { expires_at: copy.expiresAt } : {}),
				...(expected === null ? { create_only: true } : { expected_page_id: expected }),
			});
			return true;
		} catch (error) {
			if (error instanceof Error && /precondition/i.test(error.message)) return false;
			throw error;
		}
	}

	/** Every latest page of a project, expired (retired) ones too, which the page list hides: for sync.ts. */
	async allPages(project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return rows(await this.#get(`${this.#projectPath(project)}/pages?include_expired=true`)).map(row => ({
			...project,
			path: str(row.path),
			title: str(row.title),
			kind: str(row.kind) || undefined,
			tier: str(row.tier) || null,
			updatedAt: str(row.updated_at) || null,
		}));
	}

	/**
	 * One stream of session conclusions (Stop observations with a body) in `seq` order, for sync.ts: `native` is what
	 * this server captured, `synced` what it holds from the person's other computers (each row names its origin).
	 * `next` is the seq of the last row returned (`after` when none); `more`: rows are left after it.
	 */
	async conclusions(
		source: "native" | "synced",
		after: number,
		limit: number,
	): Promise<{ rows: MemoryConclusionCopy[]; next: number; more: boolean }> {
		const body = record(await this.#get(`/admin/conclusions?source=${source}&after=${after}&limit=${limit}`));
		return {
			rows: rows(body.conclusions).map(row => ({
				seq: num(row.seq),
				workspace: str(row.workspace),
				project: str(row.project),
				id: str(row.id),
				sessionId: str(row.session_id),
				title: str(row.title),
				body: str(row.body),
				at: str(row.created_at),
				...(str(row.origin_device) ? { origin: str(row.origin_device) } : {}),
			})),
			next: typeof body.next === "number" ? body.next : after,
			more: body.more === true,
		};
	}

	/**
	 * Inserts conclusions captured on the computer `origin`, each only where this server holds none with that id
	 * (never overwritten): `written`, `same` (held already) or `skipped` (nothing left of it after the server's own
	 * scrubbing). Results are in the order of `items`.
	 */
	async writeConclusions(
		project: AiMemoryProjectRef,
		origin: string,
		items: Pick<MemoryConclusionCopy, "id" | "sessionId" | "title" | "body" | "at">[],
	): Promise<("written" | "same" | "skipped")[]> {
		const reply = record(
			await this.#post("/admin/write-conclusions", {
				...projectOf(project),
				origin_device: origin,
				conclusions: items.map(item => ({
					id: item.id,
					session_id: item.sessionId,
					title: item.title,
					body: item.body,
					created_at: item.at,
				})),
			}),
		);
		const results = rows(reply.results);
		return items.map((_, index) => {
			const status = results[index]?.status;
			if (status !== "written" && status !== "same" && status !== "skipped")
				throw new Error("Memory answered an unknown conclusion status");
			return status;
		});
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
	updatedAt: string | null;
}
