import { describe, expect, it, vi } from "vitest";
import {
	type Pty,
	type PtyOptions,
	TerminalService,
} from "../../../resources/gui-bridge/stock-helper/terminal-service";

const options: PtyOptions = {
	application: "/bin/zsh",
	args: ["-l"],
	cwd: "/project",
	env: { PATH: "/bin" },
	cols: 80,
	rows: 24,
};
function fixture() {
	const processes: Array<{
		pty: Pty;
		done: { resolve: (value: { exitCode?: number }) => void };
		chunk: (error: Error | null, text: string) => void;
	}> = [];
	const service = new TerminalService(() => {
		const done = Promise.withResolvers<{ exitCode?: number }>();
		const entry = {
			pty: {
				startArgv: vi.fn((_options: PtyOptions, chunk: (error: Error | null, text: string) => void) => {
					entry.chunk = chunk;
					return done.promise;
				}),
				write: vi.fn(),
				resize: vi.fn(),
				kill: vi.fn(),
			},
			done,
			chunk: (_error: Error | null, _text: string) => {},
		};
		processes.push(entry);
		return entry.pty;
	});
	return { service, processes };
}
describe("stock terminal lifecycle", () => {
	it("spawns the login shell in the tab cwd, streams, writes, resizes and reports exit", async () => {
		const { service, processes } = fixture();
		const [session] = service.request("tab", { action: "create", cols: 90, rows: 30 }, options);
		expect(processes[0].pty.startArgv).toHaveBeenCalledWith({ ...options, cols: 90, rows: 30 }, expect.any(Function));
		processes[0].chunk(null, "ompdesk-term\r\n");
		const [snapshot] = service.request("tab", { action: "list" }, options);
		expect(snapshot.output).toBe("ompdesk-term\r\n");
		expect(
			service.request("tab", { action: "list", offsets: { [session.id]: snapshot.offset } }, options)[0].output,
		).toBe("");
		service.request("tab", { action: "write", id: session.id, data: "echo hello\r" }, options);
		expect(processes[0].pty.write).toHaveBeenCalledWith("echo hello\r");
		service.request("tab", { action: "resize", id: session.id, cols: 100, rows: 40 }, options);
		expect(processes[0].pty.resize).toHaveBeenCalledWith(100, 40);
		processes[0].done.resolve({ exitCode: 3 });
		await Promise.resolve();
		expect(service.request("tab", { action: "list" }, options)[0]).toMatchObject({ exited: true, exitCode: 3 });
	});
	it("kills on close, tab disposal and app disposal, and isolates owners", () => {
		const { service, processes } = fixture();
		const [one] = service.request("one", { action: "create", cols: 80, rows: 24 }, options);
		service.request("two", { action: "create", cols: 80, rows: 24 }, options);
		expect(() => service.request("two", { action: "write", id: one.id, data: "x" }, options)).toThrow(
			"Terminal not found",
		);
		service.request("one", { action: "close", id: one.id }, options);
		expect(processes[0].pty.kill).toHaveBeenCalledOnce();
		service.dispose("two");
		expect(processes[1].pty.kill).toHaveBeenCalledOnce();
		service.request("three", { action: "create", cols: 80, rows: 24 }, options);
		service.dispose();
		expect(processes[2].pty.kill).toHaveBeenCalledOnce();
	});
	it("restarts with the resized geometry and ignores stale exit callbacks", async () => {
		const { service, processes } = fixture();
		const [one] = service.request("one", { action: "create", cols: 80, rows: 24 }, options);
		service.request("one", { action: "resize", id: one.id, cols: 110, rows: 50 }, options);
		service.request("one", { action: "restart", id: one.id }, options);
		processes[0].done.resolve({ exitCode: 9 });
		await Promise.resolve();
		expect(service.request("one", { action: "list" }, options)[0].exited).toBe(false);
		expect(processes[1].pty.startArgv).toHaveBeenCalledWith(
			{ ...options, cols: 110, rows: 50 },
			expect.any(Function),
		);
		processes[1].chunk(null, "hello");
		service.request("one", { action: "clear", id: one.id }, options);
		expect(service.request("one", { action: "list" }, options)[0].output).toBe("");
	});
	it("restarts and closes an exited stock PTY without calling its invalid kill operation", async () => {
		const { service, processes } = fixture();
		const [one] = service.request("one", { action: "create", cols: 80, rows: 24 }, options);
		processes[0].done.resolve({ exitCode: 0 });
		await Promise.resolve();
		vi.mocked(processes[0].pty.kill).mockImplementation(() => {
			throw new Error("PTY session is not running");
		});
		service.request("one", { action: "restart", id: one.id }, options);
		expect(processes[0].pty.kill).not.toHaveBeenCalled();
		processes[1].done.resolve({ exitCode: 0 });
		await Promise.resolve();
		vi.mocked(processes[1].pty.kill).mockImplementation(() => {
			throw new Error("PTY session is not running");
		});
		expect(service.request("one", { action: "close", id: one.id }, options)).toEqual([]);
		expect(processes[1].pty.kill).not.toHaveBeenCalled();
	});
});
