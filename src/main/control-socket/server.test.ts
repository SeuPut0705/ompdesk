import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONTROL_DIR_ENV,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SOCKET_ENV,
	ENDPOINT_FILE,
	MAX_FRAME_BYTES,
	TOKEN_FILE,
} from "../../shared/control-protocol";
import { core, stopCore } from "../core/process";
import { ControlRig, LineClient, TestBackend } from "./control-test-rig";
import { ControlDirRefused, controlEndpoint, prepareControlDir, readOrCreateToken } from "./endpoint";
import { controlEnvFor } from "./env";
import { startControlSocket } from "./index";
import { ControlServer } from "./server";

// The listener, connections, auth and limits are the core's (native/ompdesk/crates/core/src/control): every case here
// runs main's `startControlSocket` or `ControlServer` over the real core and a real socket or named pipe.

const posix = process.platform !== "win32";

describe("control socket", () => {
	const rig = new ControlRig();
	let userData: string;

	beforeEach(() => {
		userData = rig.tempDir();
	});
	afterEach(async () => {
		await rig.cleanup();
		delete process.env[CONTROL_SOCKET_ENV];
		delete process.env[CONTROL_DIR_ENV];
	});
	afterAll(() => stopCore());

	async function start(backend = new TestBackend()) {
		const handle = await rig.start({ userData, backend });
		if (handle === null) throw new Error("control socket did not start");
		const token = readFileSync(join(handle.dir, TOKEN_FILE), "utf8").trim();
		return { handle, token, backend };
	}

	describe("requests", () => {
		it("answers hello and a tool call over a real connection, naming the caller", async () => {
			const { handle, token, backend } = await start();
			const client = await rig.open(handle.socket);
			client.send({
				id: 1,
				method: "hello",
				token,
				protocol: CONTROL_PROTOCOL_VERSION,
				caller: "my-script",
				cwd: userData,
			});
			const hello = await client.next();
			expect(hello).toMatchObject({ id: 1, ok: true, result: { protocol: CONTROL_PROTOCOL_VERSION } });
			client.send({ id: 2, method: "tool", tool: "ompdesk_sessions", args: { scope: "app" } });
			expect(await client.next()).toEqual({
				id: 2,
				ok: true,
				result: { text: 'ran ompdesk_sessions {"scope":"app"}', isError: false },
			});
			expect(backend.runs).toEqual([
				{
					caller: {
						id: expect.stringMatching(/^outside:my-script#\d+$/),
						name: "my-script",
						title: 'outside process "my-script" (self-declared)',
						cwd: userData,
					},
					tool: "ompdesk_sessions",
					args: { scope: "app" },
				},
			]);
			expect(hello).toMatchObject({ result: { caller: backend.runs[0]?.caller.id } });
		});

		it("falls back to the default caller name and the home folder for a bad name or folder", async () => {
			const { handle, token, backend } = await start();
			const client = await rig.open(handle.socket);
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
			expect(backend.runs[0]?.caller.id).toMatch(/^outside:cli#\d+$/);
			expect(backend.runs[0]?.caller.cwd).toBe(homedir());
		});

		it("gives every connection its own caller, whatever name it claims, and lets it go when it closes", async () => {
			const { handle, token, backend } = await start();
			const ids: string[] = [];
			const opened = [];
			for (const id of [1, 2]) {
				const client = await rig.open(handle.socket);
				opened.push(client);
				client.send({ id, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION, caller: "ci" });
				await client.next();
				client.send({ id: 10 + id, method: "tool", tool: "ompdesk_sessions" });
				await client.next();
				ids.push(backend.runs.at(-1)?.caller.id ?? "");
			}
			expect(ids[0]).not.toBe(ids[1]);
			opened[0]?.close();
			await backend.until(() => backend.released.length > 0);
			expect(backend.released).toEqual([ids[0]]);
		});

		it("answers a second hello with bad_request and keeps the connection", async () => {
			const { handle, token } = await start();
			const client = await rig.open(handle.socket);
			const hello = { method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION };
			client.send({ id: 1, ...hello });
			await client.next();
			client.send({ id: 2, ...hello });
			expect(await client.next()).toMatchObject({ id: 2, ok: false, error: { code: "bad_request" } });
			client.send({ id: 3, method: "tool", tool: "ompdesk_sessions" });
			expect(await client.next()).toMatchObject({ id: 3, ok: true });
		});

		it("answers later requests concurrently, each with its own id", async () => {
			const { handle, token } = await start();
			const client = await rig.open(handle.socket);
			client.send({ id: 1, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION });
			await client.next();
			client.send({ id: 5, method: "state", session: "nope" });
			expect(await client.next()).toMatchObject({ id: 5, ok: false, error: { code: "session_not_found" } });
			client.send({ id: 6, method: "no-such-method" });
			expect(await client.next()).toMatchObject({ id: 6, ok: false, error: { code: "unknown_method" } });
		});
	});

	describe("authentication", () => {
		it("refuses a wrong token, a missing token and a first request that is not hello, then closes", async () => {
			const { handle, token } = await start();
			const wrong = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
			const first = [
				{ id: 1, method: "hello", token: wrong, protocol: CONTROL_PROTOCOL_VERSION },
				{ id: 2, method: "hello", protocol: CONTROL_PROTOCOL_VERSION },
				{ id: 3, method: "hello", token: "short", protocol: CONTROL_PROTOCOL_VERSION },
				{ id: 4, method: "tool", tool: "ompdesk_sessions" },
			];
			for (const frame of first) {
				const client = await rig.open(handle.socket);
				client.send(frame);
				expect(await client.next()).toMatchObject({ id: frame.id, ok: false, error: { code: "unauthorized" } });
				await client.closed;
			}
			const garbage = await rig.open(handle.socket);
			garbage.socket.write("this is not json\n");
			expect(await garbage.next()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
			await garbage.closed;
		});

		it("answers a protocol mismatch and closes", async () => {
			const { handle, token } = await start();
			const client = await rig.open(handle.socket);
			client.send({ id: 1, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION + 1 });
			expect(await client.next()).toMatchObject({ id: 1, ok: false, error: { code: "protocol_mismatch" } });
			await client.closed;
		});

		it("ends a connection that sends no hello in time", async () => {
			const path = await rig.serve(new TestBackend(), { helloTimeoutMs: 1 });
			const client = await rig.open(path);
			await client.closed;
		});

		it("refuses a request line over the frame limit and closes", async () => {
			const { handle, token } = await start();
			const client = await rig.open(handle.socket);
			client.send({ id: 1, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION });
			await client.next();
			client.socket.write("x".repeat(MAX_FRAME_BYTES + 1));
			expect(await client.next()).toMatchObject({ ok: false, error: { code: "bad_request" } });
			await client.closed;
		});
	});

	describe("limits", () => {
		const hello = { method: "hello", token: rig.token, protocol: CONTROL_PROTOCOL_VERSION };

		it("turns away a connection past the cap and keeps the others", async () => {
			const path = await rig.serve(new TestBackend(), { maxConnections: 2 });
			const kept = [await rig.open(path), await rig.open(path)];
			const third = await rig.open(path);
			expect(await third.next()).toMatchObject({ ok: false, error: { code: "unavailable" } });
			await third.closed;
			kept[0]?.send({ id: 1, ...hello });
			expect(await kept[0]?.next()).toMatchObject({ id: 1, ok: true });
		});

		it("never runs more than its cap of a connection's requests at once, and answers them all", async () => {
			const backend = new TestBackend();
			let running = 0;
			let most = 0;
			const held: PromiseWithResolvers<void>[] = [];
			backend.onRun = async () => {
				most = Math.max(most, ++running);
				const hold = Promise.withResolvers<void>();
				held.push(hold);
				await hold.promise;
				running--;
				return { text: "done", isError: false };
			};
			const path = await rig.serve(backend, { maxInFlight: 2 });
			const client = await rig.open(path);
			client.send({ id: 1, ...hello });
			await client.next();
			for (const id of [2, 3, 4, 5, 6]) client.send({ id, method: "tool", tool: "ompdesk_sessions" });
			const answered: unknown[] = [];
			for (let n = 0; n < 5; n++) {
				// Both slots taken before one is let go: the next request starts only once an answer frees one.
				await backend.until(() => backend.runs.length >= Math.min(n + 2, 5));
				held[n]?.resolve();
				answered.push(await client.next());
			}
			expect(most).toBe(2);
			// Requests on one connection start in the order their lines came, so held answers come back in it.
			expect(answered).toMatchObject([2, 3, 4, 5, 6].map(id => ({ id, ok: true })));
			expect(backend.runs).toHaveLength(5);
		});

		it("refuses an unauthenticated line past a small limit", async () => {
			const path = await rig.serve(new TestBackend());
			const client = await rig.open(path);
			client.socket.write("x".repeat(70 * 1024));
			expect(await client.next()).toMatchObject({ ok: false, error: { code: "bad_request" } });
			await client.closed;
		});
	});

	describe.skipIf(!posix)("the socket file", () => {
		async function listener(path: string) {
			const child = spawn(
				process.execPath,
				[
					"-e",
					"require('node:net').createServer(s=>s.end()).listen(process.argv[1], () => process.stdout.write('up'))",
					path,
				],
				{ stdio: ["ignore", "pipe", "inherit"] },
			);
			const { promise, resolve } = Promise.withResolvers<void>();
			child.stdout.once("data", () => resolve());
			await promise;
			return child;
		}

		it("does not start over a socket another live process listens on, and leaves it", async () => {
			const { dir, socket } = controlEndpoint(userData);
			await prepareControlDir(dir);
			const other = await listener(socket);
			try {
				const lines: string[] = [];
				expect(
					await startControlSocket({ userData, backend: new TestBackend(), log: line => lines.push(line) }),
				).toBeNull();
				expect(lines.join("")).toContain("in use");
				expect(existsSync(socket)).toBe(true);
				const reached = Promise.withResolvers<void>();
				const probe = connect(socket).once("connect", reached.resolve).once("error", reached.reject);
				try {
					await reached.promise;
				} finally {
					probe.destroy();
				}
			} finally {
				other.kill();
			}
		});

		it("removes on close only the socket file it made", async () => {
			const { handle } = await start();
			rmSync(handle.socket);
			const other = await listener(handle.socket);
			try {
				await handle.close();
				expect(existsSync(handle.socket)).toBe(true);
			} finally {
				other.kill();
			}
		});
	});

	describe("lifecycle", () => {
		it("tells this computer's own spawns where it listens, never through process.env, and stops once closed", async () => {
			const starting = rig.start({ userData, backend: new TestBackend() });
			const own = controlEnvFor(false);
			expect(own[CONTROL_SOCKET_ENV]).toBeTruthy();
			expect(own[CONTROL_DIR_ENV]).toBeTruthy();
			expect(process.env[CONTROL_SOCKET_ENV]).toBeUndefined();
			// A session or terminal run for a paired device or the phone page learns nothing of it.
			expect(controlEnvFor(true)).toEqual({ OMPDESK_CONTROL_OFF: "1" });
			const handle = await starting;
			if (handle === null) throw new Error("did not start");
			expect(handle.socket).toBe(own[CONTROL_SOCKET_ENV]);
			expect(handle.dir).toBe(own[CONTROL_DIR_ENV]);
			await handle.close();
			expect(controlEnvFor(false)).toEqual({});
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

		it("leaves endpoint.json on close once it names another socket", async () => {
			const { handle } = await start();
			const endpointFile = join(handle.dir, ENDPOINT_FILE);
			// A newer OMPdesk published its own socket meanwhile: that file is not this one's to delete.
			const newer = `${JSON.stringify({ version: CONTROL_PROTOCOL_VERSION, socket: "/new/socket", pid: 1 })}\n`;
			writeFileSync(endpointFile, newer);
			await handle.close();
			expect(readFileSync(endpointFile, "utf8")).toBe(newer);
		});

		it("starts without the socket, clears the environment and logs once when the folder cannot be made", async () => {
			const blocker = join(userData, "file");
			writeFileSync(blocker, "not a folder");
			const lines: string[] = [];
			const handle = await startControlSocket({
				userData: blocker,
				backend: new TestBackend(),
				log: line => lines.push(line),
			});
			expect(handle).toBeNull();
			expect(lines).toHaveLength(1);
			expect(controlEnvFor(false)).toEqual({});
		});
	});

	describe.skipIf(!posix)("owner-only access", () => {
		it("makes the socket, folder, token and endpoint readable by this user only", async () => {
			const { handle } = await start();
			const mode = (path: string): number => statSync(path).mode & 0o777;
			expect(mode(handle.socket)).toBe(0o600);
			expect(mode(handle.dir)).toBe(0o700);
			expect(mode(join(handle.dir, TOKEN_FILE))).toBe(0o600);
			expect(mode(join(handle.dir, ENDPOINT_FILE))).toBe(0o600);
		});

		it("repairs a folder and a token that were open to others, and replaces the token they may have read", async () => {
			for (const [dirMode, tokenMode] of [
				[0o755, 0o644],
				[0o755, 0o600],
				[0o700, 0o644],
			] as const) {
				const dir = join(userData, "control");
				mkdirSync(dir, { recursive: true });
				chmodSync(dir, dirMode);
				const token = randomBytes(32).toString("hex");
				writeFileSync(join(dir, TOKEN_FILE), token);
				chmodSync(join(dir, TOKEN_FILE), tokenMode);
				const { handle, token: used } = await start();
				try {
					expect(handle.dir).toBe(dir);
					expect(used, `${dirMode.toString(8)} ${tokenMode.toString(8)}`).not.toBe(token);
					expect(used).toMatch(/^[0-9a-f]{64}$/);
					expect(statSync(dir).mode & 0o777).toBe(0o700);
					expect(statSync(join(dir, TOKEN_FILE)).mode & 0o777).toBe(0o600);
				} finally {
					await handle.close();
				}
			}
			// Tight already: the next start keeps the token.
			const first = await start();
			await first.handle.close();
			const second = await start();
			await second.handle.close();
			expect(second.token).toBe(first.token);
		});

		it("replaces a token file another user owns", async () => {
			const dir = join(userData, "control");
			await prepareControlDir(dir);
			const token = randomBytes(32).toString("hex");
			writeFileSync(join(dir, TOKEN_FILE), token, { mode: 0o600 });
			const other = (process.getuid?.() ?? 0) + 1;
			expect(await readOrCreateToken(dir, { getuid: () => other })).not.toBe(token);
		});

		it("replaces a damaged token with a fresh one", async () => {
			const dir = join(userData, "control");
			await prepareControlDir(dir);
			writeFileSync(join(dir, TOKEN_FILE), "garbage");
			const token = await readOrCreateToken(dir);
			expect(token).toMatch(/^[0-9a-f]{64}$/);
			expect(await readOrCreateToken(dir)).toBe(token);
		});

		it("refuses a folder owned by another user and one that is a link", async () => {
			const dir = join(userData, "control");
			await expect(prepareControlDir(dir, { getuid: () => (process.getuid?.() ?? 0) + 1 })).rejects.toThrow(
				ControlDirRefused,
			);
			const real = join(userData, "real");
			mkdirSync(real);
			const link = join(userData, "link");
			symlinkSync(real, link);
			await expect(prepareControlDir(link)).rejects.toThrow(ControlDirRefused);
		});

		it("replaces the socket file a dead OMPdesk left behind", async () => {
			const { dir, socket } = controlEndpoint(userData);
			await prepareControlDir(dir);
			const dead = spawn(
				process.execPath,
				[
					"-e",
					"require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('up'))",
					socket,
				],
				{ stdio: ["ignore", "pipe", "inherit"] },
			);
			const up = Promise.withResolvers<void>();
			dead.stdout.once("data", () => up.resolve());
			await up.promise;
			const exited = Promise.withResolvers<void>();
			dead.once("exit", () => exited.resolve());
			dead.kill("SIGKILL");
			await exited.promise;
			expect(existsSync(socket)).toBe(true);

			const { handle, token } = await start();
			expect(handle.socket).toBe(socket);
			const client = await rig.open(socket);
			client.send({ id: 1, method: "hello", token, protocol: CONTROL_PROTOCOL_VERSION });
			expect(await client.next()).toMatchObject({ id: 1, ok: true });
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

	describe("the core's lifetime", () => {
		it("closes a listener whose bind was still pending when close was called", async () => {
			const path = rig.socketPath();
			const server = new ControlServer({ token: rig.token, backend: new TestBackend() });
			const opening = server.listen(path);
			const closing = server.close();
			await Promise.all([opening, closing]);
			await expect(LineClient.open(path)).rejects.toThrow();
		});
		it("closes the listener when the core's input ends, keeps the token, and does not start the core again on close", async () => {
			const { handle, token } = await start();
			const endpointFile = join(handle.dir, ENDPOINT_FILE);
			expect(existsSync(endpointFile)).toBe(true);
			// Main's quit teardown: the core's stdin ends, it closes what it serves and exits.
			await stopCore();
			expect(existsSync(endpointFile)).toBe(false);
			if (posix) expect(existsSync(handle.socket)).toBe(false);
			await expect(LineClient.open(handle.socket)).rejects.toThrow();
			expect(readFileSync(join(handle.dir, TOKEN_FILE), "utf8").trim()).toBe(token);
			await handle.close();
			expect(core().pid).toBeNull();
		});

		it("listens again at the same address after the core is killed, releasing the callers it had", async () => {
			const { handle, token, backend } = await start();
			const endpointFile = join(handle.dir, ENDPOINT_FILE);
			const old = await rig.connect(handle.socket, { token });
			expect(await old.client.call({ method: "tool", tool: "ompdesk_sessions" })).toMatchObject({ ok: true });
			const pid = core().pid;
			if (pid === null) throw new Error("no core runs");
			const published = Promise.withResolvers<void>();
			const previousFile = statSync(endpointFile).ino;
			const endpointChanged = watch(handle.dir, (_event, file) => {
				if (file !== ENDPOINT_FILE) return;
				const replacement = statSync(endpointFile, { throwIfNoEntry: false });
				if (replacement && replacement.ino !== previousFile) published.resolve();
			});
			endpointChanged.once("error", published.reject);
			try {
				process.kill(pid);
				await Promise.all([old.client.closed, published.promise]);
			} finally {
				endpointChanged.close();
			}
			await backend.until(() => backend.released.length > 0);
			expect(backend.released).toEqual([old.caller.id]);

			// Publishing endpoint.json follows the new bind; wait on that event, not a retry timer.
			const fresh = await rig.connect(handle.socket, { token });
			expect(core().pid).not.toBe(pid);
			expect(fresh.caller.id).toMatch(/^outside:cli#\d+$/);
			expect(fresh.caller.id).not.toBe(old.caller.id);
			expect(await fresh.client.call({ method: "tool", tool: "ompdesk_sessions" })).toMatchObject({ ok: true });
			expect(backend.runs.at(-1)?.caller.id).toBe(fresh.caller.id);
			expect(readFileSync(join(handle.dir, TOKEN_FILE), "utf8").trim()).toBe(token);
			expect(JSON.parse(readFileSync(endpointFile, "utf8"))).toEqual({
				version: CONTROL_PROTOCOL_VERSION,
				socket: handle.socket,
				pid: process.pid,
			});
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
	});
});
