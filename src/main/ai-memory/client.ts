/**
 * Read-only access to the local ai-memory server (`/healthz`, `/admin/status` and the `/api/v1` REST surface the
 * server mounts with `--enable-web`). The bearer token is the root token `init` wrote into
 * `<data dir>/auth-tokens/default` (owner-only); it is read here in main and never reaches the renderer.
 * Nothing here writes to the server.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	AiMemoryHandoff,
	AiMemoryPage,
	AiMemoryPageRef,
	AiMemoryProject,
	AiMemoryProjectRef,
} from "../../shared/ai-memory";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:49374";
const HEALTH_TIMEOUT_MS = 2_000;
const READ_TIMEOUT_MS = 10_000;
/** How many projects a merged (all projects) list reads, newest first. */
const MERGE_PROJECTS = 12;
const LIST_LIMIT = 20;

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

function rows(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
		: [];
}

/** ai-memory marks search hits with `<mark>`; the panel shows plain text. */
export function plainSnippet(snippet: string): string {
	return snippet.replace(/<\/?mark>/g, "");
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
		const url = this.#url();
		if (!url) throw new Error("ai-memory is not running");
		const token = await this.token();
		let response: Response;
		try {
			response = await this.#fetch(`${url}${path}`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
				signal: AbortSignal.timeout(READ_TIMEOUT_MS),
			});
		} catch {
			throw new Error("ai-memory is not running");
		}
		if (!response.ok) throw new Error(`ai-memory answered ${response.status}`);
		return response.json();
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
		const params = new URLSearchParams({ q: text, limit: String(LIST_LIMIT) });
		if (project) {
			params.set("workspace", project.workspace);
			params.set("project", project.project);
		}
		return rows(await this.#get(`/api/v1/search?${params}`)).map(row => ({
			workspace: str(row.workspace),
			project: str(row.project),
			path: str(row.path),
			title: str(row.title),
			updatedAt: str(row.updated_at) || null,
			snippet: plainSnippet(str(row.snippet)),
		}));
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
			markdown: str(row.body_markdown),
		};
	}
}
