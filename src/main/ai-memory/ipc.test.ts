import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiMemoryState } from "../../shared/ai-memory";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { type IpcCaller, IpcRegistry } from "../web/ipc-registry";
import { type AiMemoryIpcDeps, registerAiMemoryIpc } from "./ipc";
import type { AiMemoryService } from "./service";

const CALLER: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };

type Service = Parameters<typeof registerAiMemoryIpc>[1];

function setup(webUrl: string | null = "http://127.0.0.1:49374/web") {
	const service = {
		state: vi.fn(() => ({ webUrl, dataDir: "/data/ai-memory" }) as AiMemoryState),
		refresh: vi.fn(async () => {}),
		setEnabled: vi.fn(async (_enabled: boolean) => {}),
		retry: vi.fn(async () => {}),
		purge: vi.fn(async () => {}),
		setTerminal: vi.fn(async (_enabled: boolean) => {}),
		projects: vi.fn(async () => []),
		search: vi.fn(async (_query: string, _project?: unknown) => []),
		recent: vi.fn(async (_project?: unknown) => []),
		handoffs: vi.fn(async (_project?: unknown) => []),
		readPage: vi.fn(async (_ref: unknown) => ({}) as never),
		pages: vi.fn(async (_project: unknown) => []),
		overview: vi.fn(async (_project: unknown) => ({}) as never),
		sessions: vi.fn(async (_project: unknown) => []),
		observations: vi.fn(async (_project: unknown, _id: string, _offset?: number) => ({}) as never),
		profile: vi.fn(async () => ({}) as never),
		lint: vi.fn(async (_project: unknown) => []),
		sweep: vi.fn(async (_project: unknown, _dryRun: boolean) => ({}) as never),
		writePage: vi.fn(async (_input: unknown) => {}),
		deletePage: vi.fn(async (_ref: unknown) => ({}) as never),
		restorePage: vi.fn(async (_ref: unknown, _rev: string) => {}),
		feedback: vi.fn(async (_ref: unknown, _signal: string) => {}),
		cancelHandoff: vi.fn(async (_project: unknown, _id: string) => {}),
		token: vi.fn(async () => "tok" as string | null),
	} satisfies Service;
	let clipboard = "";
	const deps = {
		openExternal: vi.fn(async (_url: string) => {}),
		openPath: vi.fn(async (_path: string) => ""),
		readClipboard: () => clipboard,
		writeClipboard: (text: string) => {
			clipboard = text;
		},
		care: () => null,
	} satisfies AiMemoryIpcDeps;
	const ipc = new IpcRegistry({ handle: () => {}, on: () => {} });
	registerAiMemoryIpc(ipc, service as unknown as AiMemoryService, deps);
	const call = (channel: string, ...args: unknown[]) => ipc.invoke(channel, CALLER, args);
	return { service, deps, call, clipboard: () => clipboard, setClipboard: (text: string) => (clipboard = text) };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ai-memory IPC", () => {
	it("get-state refreshes in the background and returns the snapshot", async () => {
		const { service, call } = setup();
		expect(await call(IPC_COMMANDS.AI_MEMORY_GET_STATE)).toMatchObject({ dataDir: "/data/ai-memory" });
		expect(service.refresh).toHaveBeenCalledOnce();
	});

	it("a failing background refresh never fails get-state", async () => {
		const { service, call } = setup();
		service.refresh.mockRejectedValueOnce(new Error("down"));
		await expect(call(IPC_COMMANDS.AI_MEMORY_GET_STATE)).resolves.toBeDefined();
	});

	it("set-enabled takes only a boolean", async () => {
		const { service, call } = setup();
		for (const bad of ["true", 1, null, undefined, {}]) {
			await expect(call(IPC_COMMANDS.AI_MEMORY_SET_ENABLED, bad)).rejects.toThrow("Invalid argument: enabled");
		}
		expect(service.setEnabled).not.toHaveBeenCalled();
		await call(IPC_COMMANDS.AI_MEMORY_SET_ENABLED, false);
		await call(IPC_COMMANDS.AI_MEMORY_SET_ENABLED, true);
		expect(service.setEnabled.mock.calls).toEqual([[false], [true]]);
	});

	it("set-enabled and retry return before the work ends and swallow its failure", async () => {
		const { service, call } = setup();
		service.setEnabled.mockRejectedValueOnce(new Error("boom"));
		service.retry.mockRejectedValueOnce(new Error("boom"));
		await expect(call(IPC_COMMANDS.AI_MEMORY_SET_ENABLED, true)).resolves.toBeUndefined();
		await expect(call(IPC_COMMANDS.AI_MEMORY_RETRY)).resolves.toBeUndefined();
	});

	it("set-terminal takes only a boolean and passes the service's refusal through", async () => {
		const { service, call } = setup();
		for (const bad of ["true", 1, null, undefined, {}]) {
			await expect(call(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, bad)).rejects.toThrow("Invalid argument: enabled");
		}
		expect(service.setTerminal).not.toHaveBeenCalled();
		await call(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, true);
		await call(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, false);
		expect(service.setTerminal.mock.calls).toEqual([[true], [false]]);
		service.setTerminal.mockRejectedValueOnce(new Error("Turn memory on first."));
		await expect(call(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, true)).rejects.toThrow("Turn memory on first.");
	});

	it("purge passes the service's refusal through to the caller", async () => {
		const { service, call } = setup();
		service.purge.mockRejectedValueOnce(new Error("Purge failed: refusing"));
		await expect(call(IPC_COMMANDS.AI_MEMORY_PURGE)).rejects.toThrow("Purge failed: refusing");
		await expect(call(IPC_COMMANDS.AI_MEMORY_PURGE)).resolves.toBeUndefined();
	});

	describe("open-web", () => {
		it("opens the loopback console", async () => {
			const { deps, call } = setup("http://127.0.0.1:49374/web");
			await call(IPC_COMMANDS.AI_MEMORY_OPEN_WEB);
			expect(deps.openExternal).toHaveBeenCalledWith("http://127.0.0.1:49374/web");
			const localhost = setup("http://localhost:1/web");
			await localhost.call(IPC_COMMANDS.AI_MEMORY_OPEN_WEB);
			expect(localhost.deps.openExternal).toHaveBeenCalledOnce();
		});

		it("refuses a non-loopback host, a non-http scheme, and a missing URL", async () => {
			for (const url of [
				"http://192.168.1.5:49374/web",
				"http://example.com/web",
				"https://127.0.0.1:49374/web",
				"file:///etc/passwd",
				"http://127.0.0.1.evil.test/web",
			]) {
				const { deps, call } = setup(url);
				await expect(call(IPC_COMMANDS.AI_MEMORY_OPEN_WEB)).rejects.toThrow("Refusing to open a non-local address");
				expect(deps.openExternal).not.toHaveBeenCalled();
			}
			await expect(setup(null).call(IPC_COMMANDS.AI_MEMORY_OPEN_WEB)).rejects.toThrow("Memory is not running");
		});
	});

	describe("copy-web-password", () => {
		it("puts the token on the clipboard and clears it after the timeout when unchanged", async () => {
			vi.useFakeTimers();
			const { call, clipboard } = setup();
			await call(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD);
			expect(clipboard()).toBe("tok");
			vi.advanceTimersByTime(59_000);
			expect(clipboard()).toBe("tok");
			vi.advanceTimersByTime(1_000);
			expect(clipboard()).toBe("");
		});

		it("leaves the clipboard alone when something else replaced the password", async () => {
			vi.useFakeTimers();
			const { call, clipboard, setClipboard } = setup();
			await call(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD);
			setClipboard("something the user copied");
			vi.advanceTimersByTime(120_000);
			expect(clipboard()).toBe("something the user copied");
		});

		it("refuses while there is no token yet and writes nothing", async () => {
			const { service, call, clipboard } = setup();
			service.token.mockResolvedValueOnce(null);
			await expect(call(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD)).rejects.toThrow("Memory has no token yet");
			expect(clipboard()).toBe("");
		});
	});

	describe("reveal-data", () => {
		it("opens the data dir and turns a failure string into an error", async () => {
			const { deps, call } = setup();
			await call(IPC_COMMANDS.AI_MEMORY_REVEAL_DATA);
			expect(deps.openPath).toHaveBeenCalledWith("/data/ai-memory");
			deps.openPath.mockResolvedValueOnce("no such folder");
			await expect(call(IPC_COMMANDS.AI_MEMORY_REVEAL_DATA)).rejects.toThrow("no such folder");
		});
	});

	describe("reads", () => {
		const PROJECT = { workspace: "w", project: "p" };

		it("search needs a string query and an optional well-formed project", async () => {
			const { service, call } = setup();
			await expect(call(IPC_COMMANDS.AI_MEMORY_SEARCH, 5)).rejects.toThrow("Invalid argument: query");
			await call(IPC_COMMANDS.AI_MEMORY_SEARCH, "x");
			await call(IPC_COMMANDS.AI_MEMORY_SEARCH, "x", null);
			await call(IPC_COMMANDS.AI_MEMORY_SEARCH, "x", PROJECT);
			expect(service.search.mock.calls).toEqual([
				["x", undefined],
				["x", undefined],
				["x", PROJECT],
			]);
		});

		it("rejects malformed project refs everywhere", async () => {
			const { service, call } = setup();
			const bad = ["p", 3, { workspace: "w" }, { workspace: "", project: "p" }, { workspace: "w", project: 2 }, []];
			for (const channel of [IPC_COMMANDS.AI_MEMORY_RECENT, IPC_COMMANDS.AI_MEMORY_HANDOFFS]) {
				for (const value of bad) await expect(call(channel, value)).rejects.toThrow("Invalid project");
			}
			for (const value of bad) {
				await expect(call(IPC_COMMANDS.AI_MEMORY_SEARCH, "x", value)).rejects.toThrow("Invalid project");
			}
			expect(service.recent).not.toHaveBeenCalled();
			expect(service.handoffs).not.toHaveBeenCalled();
			expect(service.search).not.toHaveBeenCalled();
		});

		it("recent and handoffs take no project or a good one", async () => {
			const { service, call } = setup();
			await call(IPC_COMMANDS.AI_MEMORY_RECENT);
			await call(IPC_COMMANDS.AI_MEMORY_RECENT, PROJECT);
			await call(IPC_COMMANDS.AI_MEMORY_HANDOFFS, PROJECT);
			expect(service.recent.mock.calls).toEqual([[undefined], [PROJECT]]);
			expect(service.handoffs.mock.calls).toEqual([[PROJECT]]);
		});

		it("read-page needs a project and a non-empty path, and passes only those fields", async () => {
			const { service, call } = setup();
			for (const bad of [
				undefined,
				null,
				PROJECT,
				{ ...PROJECT, path: "" },
				{ ...PROJECT, path: 3 },
				{ workspace: "w", path: "a.md" },
			]) {
				await expect(call(IPC_COMMANDS.AI_MEMORY_READ_PAGE, bad)).rejects.toThrow(/Invalid (page|project)/);
			}
			await call(IPC_COMMANDS.AI_MEMORY_READ_PAGE, { ...PROJECT, path: "sessions/a.md", extra: "dropped" });
			expect(service.readPage).toHaveBeenCalledOnce();
			expect(service.readPage).toHaveBeenCalledWith({ ...PROJECT, path: "sessions/a.md" });
		});
	});

	describe("memory page", () => {
		const PROJECT = { workspace: "w", project: "p" };
		const PAGE = { ...PROJECT, path: "notes/a.md" };

		it("project reads need a project and pass it on", async () => {
			const { service, call } = setup();
			const reads = [
				[IPC_COMMANDS.AI_MEMORY_OVERVIEW, service.overview],
				[IPC_COMMANDS.AI_MEMORY_PAGES, service.pages],
				[IPC_COMMANDS.AI_MEMORY_SESSIONS, service.sessions],
				[IPC_COMMANDS.AI_MEMORY_LINT, service.lint],
			] as const;
			for (const [channel, method] of reads) {
				await expect(call(channel)).rejects.toThrow("Invalid project");
				await expect(call(channel, { workspace: "w" })).rejects.toThrow("Invalid project");
				await call(channel, PROJECT);
				expect(method).toHaveBeenCalledWith(PROJECT);
			}
			await call(IPC_COMMANDS.AI_MEMORY_PROFILE);
			expect(service.profile).toHaveBeenCalledOnce();
		});

		it("observations take a session id and a numeric offset", async () => {
			const { service, call } = setup();
			await expect(call(IPC_COMMANDS.AI_MEMORY_OBSERVATIONS, PROJECT, "")).rejects.toThrow(
				"Invalid argument: sessionId",
			);
			await expect(call(IPC_COMMANDS.AI_MEMORY_OBSERVATIONS, PROJECT, "s1", "5")).rejects.toThrow(
				"Invalid argument: offset",
			);
			await call(IPC_COMMANDS.AI_MEMORY_OBSERVATIONS, PROJECT, "s1", 50);
			await call(IPC_COMMANDS.AI_MEMORY_OBSERVATIONS, PROJECT, "s1");
			expect(service.observations.mock.calls).toEqual([
				[PROJECT, "s1", 50],
				[PROJECT, "s1", 0],
			]);
		});

		it("sweep needs a boolean dryRun", async () => {
			const { service, call } = setup();
			for (const bad of ["true", 1, null, undefined]) {
				await expect(call(IPC_COMMANDS.AI_MEMORY_SWEEP, PROJECT, bad)).rejects.toThrow("Invalid argument: dryRun");
			}
			await call(IPC_COMMANDS.AI_MEMORY_SWEEP, PROJECT, true);
			await call(IPC_COMMANDS.AI_MEMORY_SWEEP, PROJECT, false);
			expect(service.sweep.mock.calls).toEqual([
				[PROJECT, true],
				[PROJECT, false],
			]);
		});

		it("page refs refuse an absolute path and a parent segment", async () => {
			const { service, call } = setup();
			for (const path of ["/etc/passwd", "../x.md", "a/../../x.md", ""]) {
				await expect(call(IPC_COMMANDS.AI_MEMORY_DELETE_PAGE, { ...PROJECT, path })).rejects.toThrow(
					"Invalid page",
				);
				await expect(call(IPC_COMMANDS.AI_MEMORY_RESTORE_PAGE, { ...PROJECT, path }, "rev")).rejects.toThrow(
					"Invalid page",
				);
			}
			expect(service.deletePage).not.toHaveBeenCalled();
			expect(service.restorePage).not.toHaveBeenCalled();
		});

		it("write-page validates its fields and passes only the known ones", async () => {
			const { service, call } = setup();
			await expect(call(IPC_COMMANDS.AI_MEMORY_WRITE_PAGE, { ...PAGE })).rejects.toThrow("Invalid argument: body");
			await expect(call(IPC_COMMANDS.AI_MEMORY_WRITE_PAGE, { ...PAGE, body: "x", tags: "a" })).rejects.toThrow(
				"Invalid argument: tags",
			);
			await expect(call(IPC_COMMANDS.AI_MEMORY_WRITE_PAGE, { ...PAGE, body: "x", pinned: "yes" })).rejects.toThrow(
				"Invalid argument: pinned",
			);
			await call(IPC_COMMANDS.AI_MEMORY_WRITE_PAGE, {
				...PAGE,
				body: "hi",
				title: "T",
				kind: "note",
				tier: "semantic",
				tags: ["a"],
				pinned: true,
				extra: 1,
			});
			expect(service.writePage).toHaveBeenCalledOnce();
			expect(service.writePage).toHaveBeenCalledWith({
				...PAGE,
				body: "hi",
				title: "T",
				kind: "note",
				tier: "semantic",
				tags: ["a"],
				pinned: true,
			});
		});

		it("delete, restore, feedback and cancel pass their arguments", async () => {
			const { service, call } = setup();
			await call(IPC_COMMANDS.AI_MEMORY_DELETE_PAGE, { ...PAGE, title: "T", extra: 1 });
			expect(service.deletePage).toHaveBeenCalledWith({ ...PAGE, title: "T" });
			await expect(call(IPC_COMMANDS.AI_MEMORY_RESTORE_PAGE, PAGE, "")).rejects.toThrow("Invalid argument: rev");
			await call(IPC_COMMANDS.AI_MEMORY_RESTORE_PAGE, PAGE, "abc");
			expect(service.restorePage).toHaveBeenCalledWith(PAGE, "abc");
			await expect(call(IPC_COMMANDS.AI_MEMORY_FEEDBACK, PAGE, "stale")).rejects.toThrow("Invalid argument: signal");
			await call(IPC_COMMANDS.AI_MEMORY_FEEDBACK, PAGE, "not_helpful");
			expect(service.feedback).toHaveBeenCalledWith(PAGE, "not_helpful");
			await expect(call(IPC_COMMANDS.AI_MEMORY_CANCEL_HANDOFF, PROJECT, "")).rejects.toThrow("Invalid argument: id");
			await call(IPC_COMMANDS.AI_MEMORY_CANCEL_HANDOFF, PROJECT, "h-1");
			expect(service.cancelHandoff).toHaveBeenCalledWith(PROJECT, "h-1");
		});
	});
});
