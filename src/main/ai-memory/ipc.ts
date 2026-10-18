/** IPC for `window.omp.aiMemory`; every handler is a thin call into `AiMemoryService`. */
import type { AiMemoryProjectRef } from "../../shared/ai-memory";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { IpcRegistry } from "../web/ipc-registry";
import type { AiMemoryService } from "./service";

/** The password the /web console asks for stays on the clipboard this long, unless something else replaced it. */
const CLIPBOARD_CLEAR_MS = 60_000;

export interface AiMemoryIpcDeps {
	/** http(s) only; main checks the host before calling. */
	openExternal: (url: string) => Promise<void>;
	openPath: (path: string) => Promise<string>;
	readClipboard: () => string;
	writeClipboard: (text: string) => void;
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
		| "setEnabled"
		| "retry"
		| "purge"
		| "projects"
		| "search"
		| "recent"
		| "handoffs"
		| "readPage"
		| "token"
	>,
	deps: AiMemoryIpcDeps,
): void {
	ipc.handle(IPC_COMMANDS.AI_MEMORY_GET_STATE, () => {
		void service.refresh().catch(() => undefined);
		return service.state();
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_SET_ENABLED, (_caller, enabled: unknown) => {
		if (typeof enabled !== "boolean") throw new Error("Invalid argument: enabled");
		// Runs in the background; progress arrives as AI_MEMORY_STATE pushes.
		void service.setEnabled(enabled).catch(() => undefined);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_RETRY, () => {
		void service.retry().catch(() => undefined);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_PURGE, () => service.purge());
	ipc.handle(IPC_COMMANDS.AI_MEMORY_OPEN_WEB, async () => {
		const { webUrl } = service.state();
		if (!webUrl) throw new Error("ai-memory is not running");
		const url = new URL(webUrl);
		if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
			throw new Error("Refusing to open a non-local address");
		}
		await deps.openExternal(url.href);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD, async () => {
		const token = await service.token();
		if (!token) throw new Error("ai-memory has no token yet");
		deps.writeClipboard(token);
		setTimeout(() => {
			if (deps.readClipboard() === token) deps.writeClipboard("");
		}, CLIPBOARD_CLEAR_MS).unref();
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_REVEAL_DATA, async () => {
		const { dataDir } = service.state();
		if (!dataDir) throw new Error("ai-memory's data directory is not known yet");
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
}
