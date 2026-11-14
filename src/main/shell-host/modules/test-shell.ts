/**
 * A real `ompdesk-shell` for a vitest suite (PROTOCOL.md §15.3): the parity suites of a moved subsystem run their cases
 * through its typed client against the built shell, as the core's units run theirs against the built core. The shell
 * starts a stand-in "main" (a relay script under Node) that hands its host connection to the test, so the test is
 * Node's side of the protocol: `hello`, `app.init`, then `shellModule(ns, () => shell.client)`.
 *
 * The shell is the e2e one (`e2e/fixture/shell-launch.ts`: the staged build; on macOS the dev bundle made from it). Where
 * none is built (Linux, a checkout without `bun run build:shell`) `testShellExecutable()` is null and the suite skips,
 * unless `OMPDESK_TEST_SHELL_REQUIRED=1` (CI: `ci.yml`'s `shell-parity`, `mac-checks.yml`'s `mac-smoke`), which makes
 * a missing shell a failure.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureDevBundle } from "../../../../e2e/fixture/shell-bundle";
import { assertShellBuilt } from "../../../../e2e/fixture/shell-launch";
import { ShellClient } from "../client";
import type { HostFacts } from "../facts";

const START_TIMEOUT_MS = 60_000;
const EXIT_GRACE_MS = 10_000;

/** Connects to the shell's socket and to the test's, sends the shell's token first, then pipes both ways. */
const RELAY = `import { connect } from "node:net";
const test = connect(process.env.OMPDESK_TEST_RELAY);
test.write(process.env.OMPDESK_SHELL_TOKEN + "\\n");
const shell = connect(process.env.OMPDESK_SHELL_SOCKET);
shell.pipe(test);
test.pipe(shell);
for (const end of [shell, test]) for (const event of ["close", "error"]) end.on(event, () => process.exit(0));
`;

/** The shell to run, or null when none is built here (a failure instead under `OMPDESK_TEST_SHELL_REQUIRED=1`). */
export function testShellExecutable(): string | null {
	try {
		return process.platform === "darwin" && !process.env.OMP_GUI_E2E_SHELL ? ensureDevBundle() : assertShellBuilt();
	} catch (error) {
		if (process.env.OMPDESK_TEST_SHELL_REQUIRED === "1") throw error;
		return null;
	}
}

export interface TestShellOptions {
	/** Added to the shell's environment (e.g. `OMP_GUI_HEADLESS`, a test seam). */
	env?: Record<string, string>;
	/** More arguments after `--user-data-dir` (Chromium switches, a launch path or URL). */
	args?: string[];
	/** Runs before the shell starts, with the empty profile folder: a case seeds the files a launch reads. */
	prepare?(userData: string): void;
}

export interface TestShell {
	/** The profile folder the shell runs on (removed by `close`). */
	readonly userData: string;
	/** Node's side of the host protocol, after `app.ready`. */
	readonly client: ShellClient;
	readonly facts: HostFacts;
	readonly process: ChildProcess;
	/** `app.exit`, then the shell's exit (killed after 10 s); removes the profile. */
	close(): Promise<void>;
}

async function within<T>(promise: Promise<T>, what: string, stderr: () => string): Promise<T> {
	const late = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => late.reject(new Error(`test shell: no ${what} within ${START_TIMEOUT_MS} ms\n${stderr()}`)),
		START_TIMEOUT_MS,
	);
	try {
		return await Promise.race([promise, late.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** Reads the relay's first line (the shell's token) and leaves the socket paused at the shell's first byte. */
function readToken(socket: Socket): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let head = Buffer.alloc(0);
	const onData = (chunk: Buffer) => {
		head = Buffer.concat([head, chunk]);
		const newline = head.indexOf(0x0a);
		if (newline < 0) return;
		socket.off("data", onData);
		socket.pause();
		const rest = head.subarray(newline + 1);
		if (rest.length > 0) socket.unshift(rest);
		resolve(head.subarray(0, newline).toString("utf8"));
	};
	socket.on("data", onData);
	socket.once("error", reject);
	return promise;
}

/** Starts the shell on a private profile with CEF up (`app.ready`), as main would see it. */
export async function startTestShell(executable: string, options: TestShellOptions = {}): Promise<TestShell> {
	const dir = mkdtempSync(path.join(tmpdir(), "osh-"));
	const userData = path.join(dir, "profile");
	const relayScript = path.join(dir, "relay.mjs");
	writeFileSync(relayScript, RELAY);
	const relayPath =
		process.platform === "win32" ? `\\\\.\\pipe\\ompdesk-test-shell-${path.basename(dir)}` : path.join(dir, "r.sock");

	const server = createServer();
	const accepted = Promise.withResolvers<Socket>();
	server.once("connection", accepted.resolve);
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(relayPath, listening.resolve);
	await listening.promise;

	const env: NodeJS.ProcessEnv = {
		...process.env,
		OMPDESK_APP_ENTRY: relayScript,
		OMPDESK_APP_DIR: dir,
		OMPDESK_NODE: process.execPath,
		OMPDESK_TEST_RELAY: relayPath,
		OMP_GUI_TEST_USER_DATA_DIR: userData,
		...options.env,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	mkdirSync(userData, { recursive: true });
	options.prepare?.(userData);
	const child = spawn(executable, [`--user-data-dir=${userData}`, ...(options.args ?? [])], {
		env,
		stdio: ["pipe", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-8_000);
	});
	const exited = Promise.withResolvers<void>();
	child.once("exit", code => {
		exited.resolve();
		accepted.reject(new Error(`test shell: the shell exited (${code}) before its Node connected\n${stderr}`));
	});
	const cleanup = () => {
		server.close();
		// On Windows CEF's helpers end a moment after the shell and hold `cef.log` until then (EBUSY): Node's own
		// retry waits them out instead of failing the test that is already done.
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	};

	try {
		const socket = await within(accepted.promise, "connection from the shell's Node", () => stderr);
		const token = await within(readToken(socket), "token", () => stderr);
		const client = new ShellClient(socket);
		socket.resume();
		const ready = Promise.withResolvers<void>();
		client.on("app.ready", () => ready.resolve());
		const hello = await client.call<{ protocol: number; facts: HostFacts }>("hello", {
			token,
			pid: process.pid,
			protocol: 1,
		});
		await client.call("app.init", { name: "ompdesk", switches: [], schemes: [] });
		await within(ready.promise, "app.ready", () => stderr);
		return {
			userData,
			client,
			facts: hello.facts,
			process: child,
			async close() {
				await client.event("app.exit", { code: 0 });
				const killed = setTimeout(() => child.kill("SIGKILL"), EXIT_GRACE_MS);
				await exited.promise;
				clearTimeout(killed);
				client.close();
				cleanup();
			},
		};
	} catch (error) {
		child.kill("SIGKILL");
		await exited.promise;
		cleanup();
		throw error;
	}
}
