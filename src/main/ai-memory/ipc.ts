/** IPC for `window.omp.aiMemory`; every handler is a thin call into `AiMemoryService`. */
import type { AiMemoryProjectRef } from "../../shared/ai-memory";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { IpcRegistry } from "../web/ipc-registry";
import type { MemoryCare } from "./care";
import type { AiMemoryService } from "./service";

/** The password the /web console asks for stays on the clipboard this long, unless something else replaced it. */
const CLIPBOARD_CLEAR_MS = 60_000;

export interface AiMemoryIpcDeps {
	/** http(s) only; main checks the host before calling. */
	openExternal: (url: string) => Promise<void>;
	openPath: (path: string) => Promise<string>;
	readClipboard: () => string;
	writeClipboard: (text: string) => void;
	/** Memory's own upkeep (care.ts): its Maintenance line and undo; null until created. */
	care: () => Pick<MemoryCare, "summary" | "undo"> | null;
}

function requireProject(value: unknown): AiMemoryProjectRef {
	const project = projectRef(value);
	if (!project) throw new Error("Invalid project");
	return project;
}

function pageRef(value: unknown): AiMemoryProjectRef & { path: string } {
	const project = requireProject(value);
	const path = (value as { path?: unknown }).path;
	if (typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..")) {
		throw new Error("Invalid page");
	}
	return { ...project, path };
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Invalid argument: ${name}`);
	return value;
}

function optionalText(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`Invalid argument: ${name}`);
	return value;
}

function projectRef(value: unknown): AiMemoryProjectRef | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object") throw new Error("Invalid project");
	const { workspace, project } = value as Record<string, unknown>;
	if (typeof workspace !== "string" || typeof project !== "string" || !workspace || !project) {
		throw new Error("Invalid project");
	}
	return { workspace, project };
}

export function registerAiMemoryIpc(
	ipc: IpcRegistry,
	service: Pick<
		AiMemoryService,
		| "state"
		| "refresh"
		| "retry"
		| "purge"
		| "setTerminal"
		| "projects"
		| "search"
		| "recent"
		| "handoffs"
		| "readPage"
		| "pages"
		| "overview"
		| "sessions"
		| "observations"
		| "profile"
		| "lint"
		| "sweep"
		| "writePage"
		| "deletePage"
		| "restorePage"
		| "feedback"
		| "cancelHandoff"
		| "token"
	>,
	deps: AiMemoryIpcDeps,
): void {
	ipc.handle(IPC_COMMANDS.AI_MEMORY_GET_STATE, () => {
		void service.refresh().catch(() => undefined);
		return service.state();
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_RETRY, () => {
		void service.retry().catch(() => undefined);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_PURGE, () => service.purge());
	ipc.handle(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, (_caller, enabled: unknown) => {
		if (typeof enabled !== "boolean") throw new Error("Invalid argument: enabled");
		return service.setTerminal(enabled);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_OPEN_WEB, async () => {
		const { webUrl } = service.state();
		if (!webUrl) throw new Error("Memory is not running");
		const url = new URL(webUrl);
		if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
			throw new Error("Refusing to open a non-local address");
		}
		await deps.openExternal(url.href);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD, async () => {
		const token = await service.token();
		if (!token) throw new Error("Memory has no token yet");
		deps.writeClipboard(token);
		setTimeout(() => {
			if (deps.readClipboard() === token) deps.writeClipboard("");
		}, CLIPBOARD_CLEAR_MS).unref();
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_REVEAL_DATA, async () => {
		const { dataDir } = service.state();
		if (!dataDir) throw new Error("The data folder is not known yet");
		const failure = await deps.openPath(dataDir);
		if (failure) throw new Error(failure);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_PROJECTS, () => service.projects());
	ipc.handle(IPC_COMMANDS.AI_MEMORY_SEARCH, (_caller, query: unknown, project: unknown) => {
		if (typeof query !== "string") throw new Error("Invalid argument: query");
		return service.search(query, projectRef(project));
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_RECENT, (_caller, project: unknown) => service.recent(projectRef(project)));
	ipc.handle(IPC_COMMANDS.AI_MEMORY_HANDOFFS, (_caller, project: unknown) => service.handoffs(projectRef(project)));
	ipc.handle(IPC_COMMANDS.AI_MEMORY_READ_PAGE, (_caller, ref: unknown) => {
		const project = projectRef(ref);
		const path = (ref as { path?: unknown } | null)?.path;
		if (!project || typeof path !== "string" || !path) throw new Error("Invalid page");
		return service.readPage({ ...project, path });
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_OVERVIEW, (_caller, project: unknown) =>
		service.overview(requireProject(project)),
	);
	ipc.handle(IPC_COMMANDS.AI_MEMORY_PAGES, (_caller, project: unknown) => service.pages(requireProject(project)));
	ipc.handle(IPC_COMMANDS.AI_MEMORY_SESSIONS, (_caller, project: unknown) =>
		service.sessions(requireProject(project)),
	);
	ipc.handle(IPC_COMMANDS.AI_MEMORY_OBSERVATIONS, (_caller, project: unknown, sessionId: unknown, offset: unknown) => {
		if (offset !== undefined && offset !== null && typeof offset !== "number") {
			throw new Error("Invalid argument: offset");
		}
		return service.observations(requireProject(project), text(sessionId, "sessionId"), offset ?? 0);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_PROFILE, () => service.profile());
	ipc.handle(IPC_COMMANDS.AI_MEMORY_LINT, (_caller, project: unknown) => service.lint(requireProject(project)));
	ipc.handle(IPC_COMMANDS.AI_MEMORY_SWEEP, (_caller, project: unknown, dryRun: unknown) => {
		if (typeof dryRun !== "boolean") throw new Error("Invalid argument: dryRun");
		return service.sweep(requireProject(project), dryRun);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_WRITE_PAGE, (_caller, input: unknown) => {
		const ref = pageRef(input);
		const record = input as Record<string, unknown>;
		const body = record.body;
		if (typeof body !== "string") throw new Error("Invalid argument: body");
		if (
			record.tags !== undefined &&
			(!Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== "string"))
		) {
			throw new Error("Invalid argument: tags");
		}
		if (record.pinned !== undefined && typeof record.pinned !== "boolean")
			throw new Error("Invalid argument: pinned");
		return service.writePage({
			...ref,
			body,
			title: optionalText(record.title, "title"),
			kind: optionalText(record.kind, "kind"),
			tier: optionalText(record.tier, "tier"),
			tags: record.tags as string[] | undefined,
			pinned: record.pinned as boolean | undefined,
		});
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_DELETE_PAGE, (_caller, ref: unknown) =>
		service.deletePage({ ...pageRef(ref), title: optionalText((ref as { title?: unknown }).title, "title") }),
	);
	ipc.handle(IPC_COMMANDS.AI_MEMORY_RESTORE_PAGE, (_caller, ref: unknown, rev: unknown) =>
		service.restorePage(pageRef(ref), text(rev, "rev")),
	);
	ipc.handle(IPC_COMMANDS.AI_MEMORY_FEEDBACK, (_caller, ref: unknown, signal: unknown) => {
		if (signal !== "helpful" && signal !== "not_helpful") throw new Error("Invalid argument: signal");
		return service.feedback(pageRef(ref), signal);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_CANCEL_HANDOFF, (_caller, project: unknown, id: unknown) =>
		service.cancelHandoff(requireProject(project), text(id, "id")),
	);
	ipc.handle(IPC_COMMANDS.AI_MEMORY_CARE, () => deps.care()?.summary() ?? null);
	ipc.handle(IPC_COMMANDS.AI_MEMORY_CARE_UNDO, () => deps.care()?.undo() ?? 0);
}
