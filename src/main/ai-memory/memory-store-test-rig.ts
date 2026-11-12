/**
 * A memory server for the sync's tests: a test's in-memory store answers the routes the core's client asks when it
 * syncs (`native/ompdesk/crates/core/src/memsync` through `aimemory/ops.rs`), so the sync runs in the real core
 * against the store the test drives. The store's interface is what the sync read and wrote when it ran in main.
 */
import type { AiMemoryPageRef, AiMemoryProject, AiMemoryProjectRef } from "../../shared/ai-memory";
import type { AiMemoryServer, MemoryConclusionCopy, MemoryPageCopy, MemoryRepository } from "./client";
import { fakeMemoryServer } from "./fake-server-test-rig";
import type { ConclusionPage } from "./sync";

export interface MemoryStore {
	/** Each project with the repository identity it was claimed by, when one was. */
	projects(): Promise<Pick<AiMemoryProject, "workspace" | "project" | "identity" | "identitySource">[]>;
	/** Every latest page, expired ones too. */
	allPages(
		project: AiMemoryProjectRef,
	): Promise<Pick<AiMemoryPageRef, "workspace" | "project" | "path" | "updatedAt">[]>;
	pageCopy(ref: AiMemoryProjectRef & { path: string }): Promise<MemoryPageCopy>;
	/** Only over the version `expected` (a `pageCopy` id) or, with `null`, only where nothing is; false: it moved on. */
	writePageCopy(copy: MemoryPageCopy, origin: string | undefined, expected: string | null): Promise<boolean>;
	conclusions(source: "native" | "synced", after: number, limit: number): Promise<ConclusionPage>;
	writeConclusions(
		project: AiMemoryProjectRef,
		origin: string,
		items: Pick<MemoryConclusionCopy, "id" | "sessionId" | "title" | "body" | "at">[],
		repository?: MemoryRepository,
	): Promise<("written" | "same" | "skipped")[]>;
}

export interface ServedStore {
	server: AiMemoryServer;
	close(): Promise<void>;
}

const METADATA = ["entities", "abstract", "relations", "applies_to", "enforced_by"] as const;

/** Serves `store()` (read at each request, so a test may swap the store) on 127.0.0.1. */
export async function serveMemoryStore(store: () => Partial<MemoryStore>): Promise<ServedStore> {
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const served = await fakeMemoryServer(async (url, request) => {
		const { pathname, searchParams } = new URL(url);
		const body = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : {};
		const fake = store();
		try {
			if (pathname === "/api/v1/projects" && fake.projects) {
				const projects = await fake.projects();
				return json(
					projects.map(project => ({
						workspace_name: project.workspace,
						project_name: project.project,
						page_count: 0,
						last_updated: null,
						...(project.identity ? { identity: project.identity, identity_source: project.identitySource } : {}),
					})),
				);
			}
			const place = /^\/api\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/pages(?:\/(.+))?$/.exec(pathname);
			if (place) {
				const ref = { workspace: decodeURIComponent(place[1] ?? ""), project: decodeURIComponent(place[2] ?? "") };
				if (!place[3] && fake.allPages) {
					const pages = await fake.allPages(ref);
					return json(pages.map(page => ({ path: page.path, title: page.path, updated_at: page.updatedAt })));
				}
				if (place[3] && fake.pageCopy) {
					const path = place[3].split("/").map(decodeURIComponent).join("/");
					const copy = await fake.pageCopy({ ...ref, path });
					return json({
						title: copy.title,
						kind: copy.kind,
						tier: copy.tier,
						body_markdown: copy.body,
						pinned: copy.pinned,
						id: copy.id,
						updated_at: copy.updatedAt,
						frontmatter: {
							tags: copy.tags,
							...copy.metadata,
							origin_device: copy.origin,
							expires_at: copy.expiresAt,
						},
					});
				}
			}
			if (pathname === "/admin/write-page" && fake.writePageCopy) {
				const text = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : undefined);
				const metadata = Object.fromEntries(METADATA.filter(name => name in body).map(name => [name, body[name]]));
				const identity = text("identity");
				const copy: MemoryPageCopy = {
					workspace: text("workspace") ?? "",
					project: text("project") ?? "",
					path: text("path") ?? "",
					title: text("title") ?? "",
					...(text("kind") ? { kind: text("kind") } : {}),
					tier: text("tier") ?? "",
					body: text("body") ?? "",
					tags: body.tags as string[],
					pinned: body.pinned === true,
					metadata,
					...(text("expires_at") ? { expiresAt: text("expires_at") } : {}),
					...(identity ? { repository: { identity, source: text("identity_source") ?? "" } } : {}),
					updatedAt: null,
				};
				const expected = body.create_only === true ? null : (text("expected_page_id") ?? null);
				if (await fake.writePageCopy(copy, text("origin_device"), expected)) return json({ ok: true });
				return json({ error: "precondition failed: the page moved on" }, 409);
			}
			if (pathname === "/admin/conclusions" && fake.conclusions) {
				const source = searchParams.get("source") === "synced" ? "synced" : "native";
				const page = await fake.conclusions(
					source,
					Number(searchParams.get("after")),
					Number(searchParams.get("limit")),
				);
				return json({
					conclusions: page.rows.map(row => ({
						seq: row.seq,
						workspace: row.workspace,
						project: row.project,
						id: row.id,
						session_id: row.sessionId,
						title: row.title,
						body: row.body,
						created_at: row.at,
						origin_device: row.origin,
					})),
					next: page.next,
					more: page.more,
					store: page.store,
					last: page.last,
				});
			}
			if (pathname === "/admin/write-conclusions" && fake.writeConclusions) {
				const rows = body.conclusions as {
					id: string;
					session_id: string;
					title: string;
					body: string;
					created_at: string;
				}[];
				const identity = typeof body.identity === "string" ? body.identity : undefined;
				const statuses = await fake.writeConclusions(
					{ workspace: String(body.workspace), project: String(body.project) },
					String(body.origin_device),
					rows.map(row => ({
						id: row.id,
						sessionId: row.session_id,
						title: row.title,
						body: row.body,
						at: row.created_at,
					})),
					identity ? { identity, source: String(body.identity_source ?? "") } : undefined,
				);
				return json({ results: statuses.map(status => ({ status })) });
			}
			return json({ error: `no route ${pathname}` }, 404);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 500);
		}
	});
	return { server: { url: served.url, dataDir: null }, close: served.close };
}
