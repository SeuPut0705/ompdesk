import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONTROL_DIR_ENV,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SOCKET_ENV,
	ENDPOINT_FILE,
	MAX_FRAME_BYTES,
	TOKEN_FILE,
} from "../../../resources/cli/protocol";
import type { ToolOutcome } from "../agent-control/service";
import type { TabActivity } from "../sidecar-pool";
import type { ControlBackend, OutsideCaller, SessionView } from "./backend";
import {
	ControlDirRefused,
	controlEndpoint,
	prepareControlDir,
	readOrCreateToken,
	removeEndpoint,
	writeEndpoint,
} from "./endpoint";
import { EventHub } from "./events";
import { startControlSocket } from "./index";
import { ControlRouter } from "./router";
import { ControlServer } from "./server";

const posix = process.platform !== "win32";

class FakeBackend implements ControlBackend {
	readonly calls: { caller: OutsideCaller; tool: string; args: unknown }[] = [];

	async run(caller: OutsideCaller, tool: string, args: unknown): Promise<ToolOutcome> {
		this.calls.push({ caller, tool, args });
		return { text: `ran ${tool} ${JSON.stringify(args)}`, isError: false };
	}

	async resolve(): Promise<SessionView> {
		throw new Error("no such session");
	}

	view(): SessionView | null {
		return null;
	}

	views(): SessionView[] {
		return [];
	}

	observe(_listener: (activity: TabActivity) => void): () => void {
		return () => undefined;
	}

	onOutsideMail(): () => void {
		return () => undefined;
	}
}

class Client {
	readonly socket: Socket;
	readonly closed: Promise<void>;
	#buffer = "";
	readonly #lines: unknown[] = [];
	#waiting: ((line: unknown) => void) | undefined;

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (text: string) => {
			this.#buffer += text;
			for (let end = this.#buffer.indexOf("\n"); end >= 0; end = this.#buffer.indexOf("\n")) {
				this.#lines.push(JSON.parse(this.#buffer.slice(0, end)));
				this.#buffer = this.#buffer.slice(end + 1);
			}
			this.#flush();
		});
		socket.on("error", () => undefined);
		this.closed = new Promise<void>(resolve => socket.on("close", () => resolve()));
	}

	static async open(path: string): Promise<Client> {
		const socket = connect(path);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new Client(socket);
	}

	#flush(): void {
		const waiting = this.#waiting;
		if (waiting && this.#lines.length > 0) {
			this.#waiting = undefined;
			waiting(this.#lines.shift());
		}
	}

	send(frame: unknown): void {
		this.socket.write(`${JSON.stringify(frame)}\n`);
	}

	next(): Promise<unknown> {
		return new Promise(resolve => {
			this.#waiting = resolve;
			this.#flush();
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

describe("control socket", () => {
	let userData: string;
	const clients: Client[] = [];
	const open = async (path: string): Promise<Client> => {
		const client = await Client.open(path);
		clients.push(client);
		return client;
	};

	beforeEach(() => {
		userData = mkdtempSync(join(tmpdir(), "ompdesk-ctl-"));
	});
	afterEach(() => {
		for (const client of clients.splice(0)) client.close();
		delete process.env[CONTROL_SOCKET_ENV];
		delete process.env[CONTROL_DIR_ENV];
		rmSync(userData, { recursive: true, force: true });
	});

	async function start(backend = new FakeBackend()) {
		const handle = await startControlSocket({ userData, backend });
		if (handle === null) throw new Error("control socket did not start");
		const token = readFileSync(join(handle.dir, TOKEN_FILE), "utf8").trim();
		return { handle, token, backend };
	}

	describe("requests", () => {
		it("answers hello and a tool call over a real connection, naming the caller", async () => {
			const { handle, token, backend } = await start();
			try {
				const client = await open(handle.socket);
				client.send({
					id: 1,
					method: "hello",
					token,
					protocol: CONTROL_PROTOCOL_VERSION,
					caller: "my-script",
					cwd: userData,
				});
				expect(await client.next()).toEqual({
					id: 1,
					ok: true,
					result: { protocol: CONTROL_PROTOCOL_VERSION, caller: "outside:my-script" },
				});
				client.send({ id: 2, method: "tool", tool: "ompdesk_sessions", args: { scope: "app" } });
				expect(await client.next()).toEqual({
					id: 2,
					ok: true,
					result: { text: 'ran ompdesk_sessions {"scope":"app"}', isError: false },
				});
				expect(backend.calls).toEqual([
					{
						caller: { id: "outside:my-script", title: 'outside agent "my-script"', cwd: userData },
						tool: "ompdesk_sessions",
						args: { scope: "app" },
					},
				]);
			} finally {
				await handle.close();
			}
		});

		it("falls back to the default caller name and the home folder for a bad name or folder", async () => {
			const { handle, token, backend } = await start();
			try {
				const client = await open(handle.socket);
				client.send({
					id: 1,
					method: "hello",
					token,
					protocol: CONTROL_PROTOCOL_VERSION,
					caller: "Not Allowed!",
					cwd: "relative/dir",
				});
				await client.next();
				client.send({ id: 2, method: "tool", tool: "ompdesk_sessions" });
				await client.next();
				expect(backend.calls[0]?.caller.id).toBe("outside:cli");
				expect(backend.calls[0]?.caller.cwd).toBe(homedir());
			} finally {
				await handle.close();
			}
		});

		it("answers a second hello with bad_request and keeps the connection", async () => {
			const { handle, token } = await start();
			try {
				const client = await open(handle.socket);
				const hello = { method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION };
				client.send({ id: 1, ...hello });
				await client.next();
				client.send({ id: 2, ...hello });
				expect(await client.next()).toMatchObject({ id: 2, ok: false, error: { code: "bad_request" } });
				client.send({ id: 3, method: "tool", tool: "ompdesk_sessions" });
				expect(await client.next()).toMatchObject({ id: 3, ok: true });
			} finally {
				await handle.close();
			}
		});

		it("answers later requests concurrently, each with its own id", async () => {
			const { handle, token } = await start();
			try {
				const client = await open(handle.socket);
				client.send({ id: 1, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION });
				await client.next();
				client.send({ id: 5, method: "state", session: "nope" });
				expect(await client.next()).toMatchObject({ id: 5, ok: false, error: { code: "session_not_found" } });
				client.send({ id: 6, method: "no-such-method" });
				expect(await client.next()).toMatchObject({ id: 6, ok: false, error: { code: "unknown_method" } });
			} finally {
				await handle.close();
			}
		});
	});

	describe("authentication", () => {
		it("refuses a wrong token, a missing token and a first request that is not hello, then closes", async () => {
			const { handle, token } = await start();
			try {
				const wrong = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
				const first: unknown[] = [
					{ id: 1, method: "hello", token: wrong, protocol: CONTROL_PROTOCOL_VERSION },
					{ id: 2, method: "hello", protocol: CONTROL_PROTOCOL_VERSION },
					{ id: 3, method: "hello", token: "short", protocol: CONTROL_PROTOCOL_VERSION },
					{ id: 4, method: "tool", tool: "ompdesk_sessions" },
				];
				for (const frame of first) {
					const client = await open(handle.socket);
					client.send(frame);
					expect(await client.next()).toMatchObject({
						id: (frame as { id: number }).id,
						ok: false,
						error: { code: "unauthorized" },
					});
					await client.closed;
				}
				const garbage = await open(handle.socket);
				garbage.socket.write("this is not json\n");
				expect(await garbage.next()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
				await garbage.closed;
			} finally {
				await handle.close();
			}
		});

		it("answers a protocol mismatch and closes", async () => {
			const { handle, token } = await start();
			try {
				const client = await open(handle.socket);
				client.send({ id: 1, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION + 1 });
				expect(await client.next()).toMatchObject({ id: 1, ok: false, error: { code: "protocol_mismatch" } });
				await client.closed;
			} finally {
				await handle.close();
			}
		});

		it("ends a connection that sends no hello in time", async () => {
			const server = new ControlServer({
				token: randomBytes(32).toString("hex"),
				router: new ControlRouter(new FakeBackend(), new EventHub(new FakeBackend())),
				helloTimeoutMs: 1,
			});
			const path = posix ? join(userData, "s.sock") : `\\\\.\\pipe\\ompdesk-test-${randomBytes(8).toString("hex")}`;
			await server.listen(path);
			try {
				const client = await open(path);
				await client.closed;
			} finally {
				await server.close();
			}
		});

		it("refuses a request line over the frame limit and closes", async () => {
			const { handle, token } = await start();
			try {
				const client = await open(handle.socket);
				client.send({ id: 1, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION });
				await client.next();
				client.socket.write("x".repeat(MAX_FRAME_BYTES + 1));
				expect(await client.next()).toMatchObject({ ok: false, error: { code: "bad_request" } });
				await client.closed;
			} finally {
				await handle.close();
			}
		});
	});

	describe("lifecycle", () => {
		it("sets the environment before the socket is up and clears it on close", async () => {
			const starting = startControlSocket({ userData, backend: new FakeBackend() });
			const socket = process.env[CONTROL_SOCKET_ENV];
			const dir = process.env[CONTROL_DIR_ENV];
			expect(socket).toBeTruthy();
			expect(dir).toBeTruthy();
			const handle = await starting;
			if (handle === null) throw new Error("did not start");
			expect(handle.socket).toBe(socket);
			expect(handle.dir).toBe(dir);
			await handle.close();
			expect(process.env[CONTROL_SOCKET_ENV]).toBeUndefined();
			expect(process.env[CONTROL_DIR_ENV]).toBeUndefined();
		});

		it("publishes endpoint.json and removes it, and the socket, on close", async () => {
			const { handle } = await start();
			const endpointFile = join(handle.dir, ENDPOINT_FILE);
			expect(JSON.parse(readFileSync(endpointFile, "utf8"))).toEqual({
				version: CONTROL_PROTOCOL_VERSION,
				socket: handle.socket,
				pid: process.pid,
			});
			if (posix) expect(existsSync(handle.socket)).toBe(true);
			await handle.close();
			expect(existsSync(endpointFile)).toBe(false);
			if (posix) expect(existsSync(handle.socket)).toBe(false);
		});

		it("starts without the socket, clears the environment and logs once when the folder cannot be made", async () => {
			const blocker = join(userData, "file");
			writeFileSync(blocker, "not a folder");
			const lines: string[] = [];
			const handle = await startControlSocket({
				userData: blocker,
				backend: new FakeBackend(),
				log: line => lines.push(line),
			});
			expect(handle).toBeNull();
			expect(lines).toHaveLength(1);
			expect(process.env[CONTROL_SOCKET_ENV]).toBeUndefined();
			expect(process.env[CONTROL_DIR_ENV]).toBeUndefined();
		});
	});

	describe.skipIf(!posix)("owner-only access", () => {
		it("makes the socket, folder, token and endpoint readable by this user only", async () => {
			const { handle } = await start();
			try {
				const mode = (path: string): number => statSync(path).mode & 0o777;
				expect(mode(handle.socket)).toBe(0o600);
				expect(mode(handle.dir)).toBe(0o700);
				expect(mode(join(handle.dir, TOKEN_FILE))).toBe(0o600);
				expect(mode(join(handle.dir, ENDPOINT_FILE))).toBe(0o600);
			} finally {
				await handle.close();
			}
		});

		it("repairs a folder and a token that are open to others", async () => {
			const dir = join(userData, "control");
			mkdirSync(dir);
			chmodSync(dir, 0o755);
			const token = randomBytes(32).toString("hex");
			writeFileSync(join(dir, TOKEN_FILE), token, { mode: 0o644 });
			chmodSync(join(dir, TOKEN_FILE), 0o644);
			const { handle, token: used } = await start();
			try {
				expect(handle.dir).toBe(dir);
				expect(used).toBe(token);
				expect(statSync(dir).mode & 0o777).toBe(0o700);
				expect(statSync(join(dir, TOKEN_FILE)).mode & 0o777).toBe(0o600);
			} finally {
				await handle.close();
			}
		});

		it("replaces a damaged token with a fresh one", () => {
			const dir = join(userData, "control");
			prepareControlDir(dir);
			writeFileSync(join(dir, TOKEN_FILE), "garbage");
			const token = readOrCreateToken(dir);
			expect(token).toMatch(/^[0-9a-f]{64}$/);
			expect(readOrCreateToken(dir)).toBe(token);
		});

		it("refuses a folder owned by another user and one that is a link", () => {
			const dir = join(userData, "control");
			expect(() => prepareControlDir(dir, { getuid: () => (process.getuid?.() ?? 0) + 1 })).toThrow(
				ControlDirRefused,
			);
			const real = join(userData, "real");
			mkdirSync(real);
			const link = join(userData, "link");
			symlinkSync(real, link);
			expect(() => prepareControlDir(link)).toThrow(ControlDirRefused);
		});

		it("replaces the socket file a dead OMPdesk left behind", async () => {
			const { dir, socket } = controlEndpoint(userData);
			prepareControlDir(dir);
			const dead = spawn(
				process.execPath,
				[
					"-e",
					"require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('up'))",
					socket,
				],
				{ stdio: ["ignore", "pipe", "inherit"] },
			);
			await new Promise<void>(resolve => dead.stdout.once("data", () => resolve()));
			const exited = new Promise<void>(resolve => dead.once("exit", () => resolve()));
			dead.kill("SIGKILL");
			await exited;
			expect(existsSync(socket)).toBe(true);

			const { handle, token } = await start();
			try {
				expect(handle.socket).toBe(socket);
				const client = await open(socket);
				client.send({ id: 1, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION });
				expect(await client.next()).toMatchObject({ id: 1, ok: true });
			} finally {
				await handle.close();
			}
		});

		it("moves the socket under the temp folder when the path would not fit a socket address", () => {
			const long = join(userData, "p".repeat(100));
			const { dir, socket } = controlEndpoint(long);
			expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
			expect(dir.startsWith(tmpdir())).toBe(true);
			expect(controlEndpoint(long).dir).toBe(dir);
			expect(controlEndpoint(join(userData, "q".repeat(100))).dir).not.toBe(dir);
		});
	});

	describe("endpoint files", () => {
		it("names a different unguessable pipe on every call on Windows", () => {
			const first = controlEndpoint(userData, "win32");
			const second = controlEndpoint(userData, "win32");
			expect(first.socket).toMatch(/^\\\\\.\\pipe\\ompdesk-[0-9a-f]{32}$/);
			expect(second.socket).not.toBe(first.socket);
			expect(first.dir).toBe(join(userData, "control"));
		});

		it("removes endpoint.json only while it still names that socket", () => {
			const dir = join(userData, "control");
			prepareControlDir(dir);
			writeEndpoint(dir, { version: CONTROL_PROTOCOL_VERSION, socket: "/new/socket", pid: 1 });
			removeEndpoint(dir, "/old/socket");
			expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(true);
			removeEndpoint(dir, "/new/socket");
			expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(false);
		});
	});
});
