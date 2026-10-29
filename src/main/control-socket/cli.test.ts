import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlDir, type Io, main, parse, type RunCommand } from "../../../resources/cli/ompdesk";
import type { ControlRequest, ControlResponse } from "../../../resources/cli/protocol";

function run(argv: string[]): RunCommand {
	const parsed = parse(argv);
	if (parsed.kind !== "run") throw new Error(`not a run: ${JSON.stringify(parsed)}`);
	return parsed;
}

describe("parse", () => {
	const tool = (name: string, args: unknown) => ({ method: "tool", tool: name, args });
	const table: [string[], unknown][] = [
		[["sessions"], tool("ompdesk_sessions", {})],
		[
			["sessions", "--scope", "app", "--mine", "--limit", "5"],
			tool("ompdesk_sessions", { scope: "app", mine: true, limit: 5 }),
		],
		[
			["open", "do it", "--folder", "/x", "--mode", "goal", "--worktree", "--branch", "b"],
			tool("ompdesk_session_open", { message: "do it", folder: "/x", mode: "goal", worktree: { branch: "b" } }),
		],
		[["open", "--reopen", "abc", "--restore"], tool("ompdesk_session_open", { reopen: "abc", restore: true })],
		[
			["send", "s1", "hi", "--steer", "--request-id", "r1", "--force"],
			{ method: "send", session: "s1", message: "hi", delivery: "steer", requestId: "r1", force: true },
		],
		[
			["send", "s1", "hi", "--wait", "--until", "done", "--timeout", "30"],
			{ method: "send", session: "s1", message: "hi", wait: { until: "done", timeoutMs: 30_000 } },
		],
		[["wait", "s1", "--until", "blocked"], { method: "wait", session: "s1", until: "blocked" }],
		[["state", "s1"], { method: "state", session: "s1" }],
		[["result", "a"], tool("ompdesk_session_result", { session: "a" })],
		[
			["result", "a", "b", "--wait", "--until", "any", "--timeout", "9"],
			tool("ompdesk_session_result", { sessions: ["a", "b"], wait: true, until: "any", timeout_seconds: 9 }),
		],
		[["read", "a", "--limit", "3"], tool("ompdesk_session_read", { session: "a", limit: 3 })],
		[
			["answer", "a", "--deny", "--request", "q"],
			tool("ompdesk_session_answer", { session: "a", request: "q", approve: false }),
		],
		[["stop", "a", "--close"], tool("ompdesk_session_stop", { session: "a", close: true })],
		[["show", "a", "--how", "split-right"], tool("ompdesk_tab_focus", { session: "a", how: "split-right" })],
		[["notify", "T", "--body", "B"], tool("ompdesk_notify", { title: "T", body: "B" })],
		[["compare", "a", "b", "--criteria", "x"], tool("ompdesk_compare", { sessions: ["a", "b"], criteria: ["x"] })],
		[["merge", "a"], tool("ompdesk_merge", { session: "a" })],
		[
			["report", "done", "ok", "--file", "f.ts", "--pass", "bun test", "--to", "p"],
			tool("ompdesk_report", {
				kind: "done",
				to: "p",
				files: ["f.ts"],
				checks: [{ command: "bun test", passed: true }],
				text: "ok",
			}),
		],
		[
			["schedule", "create", "--name", "n", "--prompt", "p", "--every-minutes", "60", "--days", "1,2"],
			tool("ompdesk_schedule", { action: "create", name: "n", prompt: "p", every_minutes: 60, days: [1, 2] }),
		],
		[
			["autopilot", "start", "--folder", "/r", "--ship", "push", "--branch", "x", "--new-branch"],
			tool("ompdesk_autopilot", { action: "start", folder: "/r", ship: "push", branch: { kind: "new", name: "x" } }),
		],
		[["autopilot", "stop", "s", "--now"], tool("ompdesk_autopilot", { action: "stop", now: true, session: "s" })],
		[["app", "list", "--area", "theme"], tool("ompdesk_app_list", { area: "theme" })],
		[["app", "theme.set", '{"name":"dark"}'], tool("ompdesk_app", { action: "theme.set", args: { name: "dark" } })],
		[["call", "ompdesk_merge", '{"session":"a"}'], tool("ompdesk_merge", { session: "a" })],
		[["events"], { method: "subscribe" }],
	];
	it.each(table)("%j", (argv, body) => {
		expect(run(argv).body).toEqual(body);
	});

	it("marks `-` for stdin", () => {
		expect(run(["open", "-"]).stdin).toEqual({ path: ["args", "message"], json: false });
		expect(run(["send", "s", "-"]).stdin).toEqual({ path: ["message"], json: false });
		expect(run(["call", "ompdesk_merge", "-"]).stdin).toEqual({ path: ["args"], json: true });
	});

	it("reads the global flags", () => {
		const command = run(["state", "s", "--json", "--socket", "/p", "--caller", "ci"]);
		expect(command).toMatchObject({ json: true, socket: "/p", caller: "ci" });
	});

	it.each([
		[[], "help"],
		[["--help"], "help"],
		[["help", "send"], "help"],
		[["send", "--help"], "help"],
	])("%j is help", (argv, kind) => {
		expect(parse(argv).kind).toBe(kind);
	});

	it.each([
		["nope"],
		["sessions", "--bogus"],
		["send", "only-session"],
		["state"],
		["state", "a", "b"],
		["wait", "s", "--until", "never"],
		["sessions", "--limit", "many"],
		["sessions", "--scope", "galaxy"],
		["call", "t", "{bad"],
		["schedule", "explode"],
	])("%j is a usage error", (...argv) => {
		expect(parse(argv).kind).toBe("usage");
	});
});

describe("controlDir", () => {
	it("follows the platform", () => {
		expect(controlDir({ OMPDESK_CONTROL_DIR: "/c" }, "darwin", "/h")).toBe("/c");
		expect(controlDir({}, "darwin", "/h")).toBe(join("/h", "Library", "Application Support", "ompdesk", "control"));
		expect(controlDir({ APPDATA: "/a" }, "win32", "/h")).toBe(join("/a", "ompdesk", "control"));
		expect(controlDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/h")).toBe(join("/x", "ompdesk", "control"));
		expect(controlDir({}, "linux", "/h")).toBe(join("/h", ".config", "ompdesk", "control"));
	});
});

describe("main", () => {
	let dir: string;
	let server: Server | undefined;
	let sockets: Socket[];
	let seen: ControlRequest[];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-cli-"));
		sockets = [];
		seen = [];
	});
	afterEach(() => {
		for (const socket of sockets) socket.destroy();
		server?.close();
		server = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	const socketPath = () =>
		process.platform === "win32" ? `\\\\.\\pipe\\ompdesk-cli-test-${process.pid}-${Date.now()}` : join(dir, "s.sock");

	/** A server speaking the protocol: `reply` answers every request after `hello`. */
	async function serve(
		reply: (request: ControlRequest, socket: Socket) => ControlResponse | undefined,
		token = "tok",
	): Promise<string> {
		const path = socketPath();
		server = createServer(socket => {
			sockets.push(socket);
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
					const request = JSON.parse(buffer.slice(0, at)) as ControlRequest;
					buffer = buffer.slice(at + 1);
					seen.push(request);
					const response: ControlResponse | undefined =
						request.method === "hello"
							? request.token === token
								? { id: request.id, ok: true, result: {} }
								: { id: request.id, ok: false, error: { code: "unauthorized", message: "bad token" } }
							: reply(request, socket);
					if (response) socket.write(`${JSON.stringify(response)}\n`);
				}
			});
		});
		await new Promise<void>(resolve => server?.listen(path, resolve));
		// OMPdesk makes its socket owner-only; the CLI checks that before it hands over the token.
		if (process.platform !== "win32") chmodSync(path, 0o600);
		writeFileSync(join(dir, "endpoint.json"), JSON.stringify({ version: 1, socket: path, pid: process.pid }));
		writeFileSync(join(dir, "token"), "tok\n", { mode: 0o600 });
		return path;
	}

	function io(extra: Partial<Io> = {}): Io & { out: string[]; err: string[] } {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			stdout: text => void out.push(text),
			stderr: text => void err.push(text),
			readStdin: async () => "from stdin\n",
			env: { OMPDESK_CONTROL_DIR: dir },
			platform: process.platform,
			home: dir,
			cwd: dir,
			...extra,
		};
	}

	it("prints a tool's text and sends the caller and cwd", async () => {
		await serve(request => ({ id: request.id, ok: true, result: { text: "two sessions", isError: false } }));
		const sink = io({ env: { OMPDESK_CONTROL_DIR: dir, OMPDESK_CALLER: "ci" } });
		expect(await main(["sessions"], sink)).toBe(0);
		expect(sink.out.join("")).toBe("two sessions\n");
		expect(seen[0]).toMatchObject({ method: "hello", caller: "ci", cwd: dir, token: "tok" });
		expect(seen[1]).toMatchObject({ method: "tool", tool: "ompdesk_sessions" });
	});

	it.skipIf(process.platform === "win32")(
		"never sends the token to a socket that is not this user's alone",
		async () => {
			const reply = (request: ControlRequest): ControlResponse => ({
				id: request.id,
				ok: true,
				result: { text: "ok", isError: false },
			});
			const path = await serve(reply);
			const uid = process.getuid?.() ?? 0;
			const cases: [string, () => void, Partial<Io>][] = [
				["socket open to others", () => chmodSync(path, 0o666), {}],
				["folder open to others", () => chmodSync(dir, 0o755), {}],
				["owned by another user", () => undefined, { getuid: () => uid + 1 }],
			];
			for (const [what, loosen, extra] of cases) {
				chmodSync(path, 0o600);
				chmodSync(dir, 0o700);
				loosen();
				const sink = io(extra);
				expect(await main(["sessions"], sink), what).toBe(3);
				expect(sink.err.join(""), what).toContain("refused");
				expect(seen, what).toEqual([]);
			}
			chmodSync(dir, 0o700);
		},
	);

	it("refuses to run in a session OMPdesk hosts for another device", async () => {
		await serve(request => ({ id: request.id, ok: true, result: { text: "ok", isError: false } }));
		const sink = io({ env: { OMPDESK_CONTROL_DIR: dir, OMPDESK_CONTROL_OFF: "1" } });
		expect(await main(["sessions"], sink)).toBe(3);
		expect(sink.err.join("")).toContain("another device");
		expect(seen).toEqual([]);
	});

	it("reads a message from stdin for `-`", async () => {
		await serve(request => ({ id: request.id, ok: true, result: { receipt: "queued" } }));
		const sink = io();
		expect(await main(["send", "s1", "-"], sink)).toBe(0);
		expect(seen[1]).toMatchObject({ method: "send", session: "s1", message: "from stdin" });
		expect(sink.out.join("")).toBe("queued\n");
	});

	it("prints the raw result with --json", async () => {
		await serve(request => ({ id: request.id, ok: true, result: { session: "s", title: "T", state: "idle" } }));
		const sink = io();
		expect(await main(["state", "s", "--json"], sink)).toBe(0);
		expect(JSON.parse(sink.out.join(""))).toEqual({ session: "s", title: "T", state: "idle" });
	});

	it("exits 1 when the tool reports a failure", async () => {
		await serve(request => ({ id: request.id, ok: true, result: { text: "no such session", isError: true } }));
		const sink = io();
		expect(await main(["merge", "x"], sink)).toBe(1);
		expect(sink.err.join("")).toContain("no such session");
	});

	it("exits 1 on an error response, with --json showing it", async () => {
		await serve(request => ({
			id: request.id,
			ok: false,
			error: { code: "agent_blocked", message: "waits on the person" },
		}));
		const sink = io();
		expect(await main(["send", "s", "hi", "--json"], sink)).toBe(1);
		expect(sink.err.join("")).toContain("agent_blocked");
		expect(JSON.parse(sink.out.join(""))).toEqual({
			ok: false,
			error: { code: "agent_blocked", message: "waits on the person" },
		});
	});

	it("exits 3 when the token is refused", async () => {
		await serve(() => undefined, "other");
		const sink = io();
		expect(await main(["sessions"], sink)).toBe(3);
		expect(sink.err.join("")).toContain("unauthorized");
	});

	it("exits 3 when OMPdesk is not running", async () => {
		const sink = io();
		expect(await main(["sessions"], sink)).toBe(3);
		expect(sink.err.join("")).toContain("not running");
	});

	it("exits 3 when the socket refuses", async () => {
		writeFileSync(join(dir, "endpoint.json"), JSON.stringify({ version: 1, socket: socketPath(), pid: 1 }));
		writeFileSync(join(dir, "token"), "tok");
		expect(await main(["sessions"], io())).toBe(3);
	});

	it("exits 2 on a usage error without connecting", async () => {
		const sink = io();
		expect(await main(["send", "s"], sink)).toBe(2);
		expect(await main(["help", "bogus"], io())).toBe(2);
	});

	it("streams events and exits 1 on events_lost", async () => {
		await serve((request, socket) => {
			setTimeout(() => {
				socket.write(
					`${JSON.stringify({ sub: request.id, seq: 1, event: { type: "turn_finished", session: "s", title: "T", stopReason: "stop" } })}\n`,
				);
				socket.write(
					`${JSON.stringify({ sub: request.id, error: { code: "events_lost", message: "too slow", lost: 4 } })}\n`,
				);
			}, 10);
			return { id: request.id, ok: true, result: {} };
		});
		const sink = io();
		expect(await main(["events"], sink)).toBe(1);
		expect(sink.out.join("")).toContain("turn_finished s stop");
		expect(sink.err.join("")).toContain("events_lost");
	});

	it("ends events with 0 when interrupted", async () => {
		await serve(request => ({ id: request.id, ok: true, result: {} }));
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 50);
		expect(await main(["events"], io({ signal: abort.signal }))).toBe(0);
	});
});

const hasBun = spawnSync("bun", ["--version"]).status === 0;
describe.skipIf(!hasBun)("bun smoke", () => {
	it("prints help and exits 0", () => {
		const cli = join(__dirname, "..", "..", "..", "resources", "cli", "ompdesk.ts");
		const result = spawnSync("bun", [cli, "help"], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Exit codes");
	});
});
