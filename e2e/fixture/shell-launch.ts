/**
 * Playwright's launcher for the Rust shell (`crates/shell`, CEF), standing in for `_electron.launch`.
 *
 * The app is `ompdesk-shell` (packaged: `OMPdesk(.exe)`), which starts Node on `out/main/index.js` (the shim
 * `src/main/shell-host/electron` speaks to the shell). A test reaches it through two doors:
 *  - the pages: `chromium.connectOverCDP` on the shell's `--remote-debugging-port`, whose port CEF's context writes
 *    to `<userData>/shell-webview/DevToolsActivePort`;
 *  - main: Node's inspector (`OMP_GUI_TEST_NODE_INSPECT=1` makes the shell start Node with `--inspect=127.0.0.1:0`
 *    and pass its stderr `Debugger listening on ws://…` line through), where `evaluate(fn, arg)` runs
 *    `fn(globalThis.__ompdeskElectron, arg)`: the shim's module, as Playwright runs `fn(require("electron"), arg)`
 *    in Electron's main.
 *
 * {@link ShellApplication} has the surface the specs use of Playwright's `ElectronApplication`: `evaluate`,
 * `firstWindow`, `windows`, `waitForEvent("window")`, `process`, `context`, `close` and the `close` event.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

/** How long a running main process gets to act on a quit before it is killed. */
export const EXIT_GRACE_MS = 10_000;
/** Default bound on a launch: the shell, CEF's context, Node's inspector and the CDP connection. */
const LAUNCH_TIMEOUT_MS = 60_000;
/**
 * The process-tree helpers, loaded where they are used: `launch-then-die.ts` runs this file under plain Node, which
 * cannot resolve an extensionless TypeScript import, and never reaches a place that needs them.
 */
const processTree = () => import("../process-tree");
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** `resources/ompdesk-shell/<platform>-<arch>/ompdesk-shell(.exe)`, where `bun run build:shell` stages it. */
export function stagedShell(platform = process.platform, arch = process.arch, root = REPO_ROOT): string {
	return path.join(
		root,
		"resources",
		"ompdesk-shell",
		`${platform}-${arch}`,
		platform === "win32" ? "ompdesk-shell.exe" : "ompdesk-shell",
	);
}

/**
 * The macOS dev bundle (`shell-bundle.ts`): the staged shell only runs from an `.app`, which `e2e/global-setup.ts`
 * assembles under the checkout's `node_modules/.cache`. Its product name is `scripts/mac-bundle-info.cjs`'s.
 */
export const DEV_BUNDLE_PRODUCT = "OMPdesk";

export function devBundleApp(root = REPO_ROOT, arch = process.arch): string {
	return path.join(root, "node_modules", ".cache", "ompdesk-e2e", `darwin-${arch}`, `${DEV_BUNDLE_PRODUCT}.app`);
}

export function devBundleExecutable(root = REPO_ROOT, arch = process.arch): string {
	return path.join(devBundleApp(root, arch), "Contents", "MacOS", DEV_BUNDLE_PRODUCT);
}

/**
 * The shell a test runs: `OMP_GUI_E2E_SHELL` (a packaged `OMPdesk(.exe)`, or on macOS the executable inside a
 * bundle), else the staged build (Windows) or the dev bundle made from it (macOS).
 */
export function shellExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
	if (env.OMP_GUI_E2E_SHELL) return path.resolve(env.OMP_GUI_E2E_SHELL);
	return platform === "darwin" ? devBundleExecutable() : stagedShell();
}

/** Throws, naming the missing file and how to build it, when the shell is not there. Returns its path. */
export function assertShellBuilt(env: NodeJS.ProcessEnv = process.env): string {
	const exe = shellExecutable(env);
	if (!fs.existsSync(exe)) {
		throw new Error(
			process.platform === "darwin" && !env.OMP_GUI_E2E_SHELL
				? `No shell bundle: ${exe} does not exist. Run \`bun run build:shell\`; Playwright's global setup (e2e/global-setup.ts) assembles the bundle from it (or point OMP_GUI_E2E_SHELL at an OMPdesk.app's Contents/MacOS/OMPdesk).`
				: `No shell: ${exe} does not exist. Run \`bun run build:shell\` (or point OMP_GUI_E2E_SHELL at a built ompdesk-shell).`,
		);
	}
	return exe;
}

/** The `--user-data-dir` of `args` (`--user-data-dir=<dir>` or `--user-data-dir <dir>`). */
export function userDataFromArgs(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg.startsWith("--user-data-dir=")) return arg.slice("--user-data-dir=".length);
		if (arg === "--user-data-dir") return args[i + 1];
	}
	return undefined;
}

/** `<checkout>/out(-<hash>)/main/index.js` → the checkout (the folder holding `package.json`). */
export function appDirOfEntry(entry: string): string {
	return path.dirname(path.dirname(path.dirname(path.resolve(entry))));
}

/** The URL of Node's inspector from the shell's stderr (`Debugger listening on ws://127.0.0.1:9229/<id>`). */
export function inspectorUrl(text: string): string | undefined {
	return /Debugger listening on (ws:\/\/\S+)/.exec(text)?.[1];
}

/** The port line of a Chromium `DevToolsActivePort` file; undefined while it is empty or half written. */
export function devToolsPort(file: string): number | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const [line, rest] = text.split(/\r?\n/);
	const port = Number(line);
	return Number.isInteger(port) && port > 0 && rest !== undefined ? port : undefined;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** What `evaluate` runs in main: `fn(<the shim's electron module>, arg)`, awaited. */
export function evaluateExpression(fn: ((...args: never[]) => unknown) | string, arg: unknown): string {
	const source = typeof fn === "function" ? fn.toString() : fn;
	return (
		"(async () => {\n" +
		"const electron = globalThis.__ompdeskElectron;\n" +
		'if (!electron) throw new Error("main exposes no globalThis.__ompdeskElectron (OMP_GUI_TEST_NODE_INSPECT=1 not honoured)");\n' +
		`return await (${source})(electron, ${arg === undefined ? "undefined" : JSON.stringify(arg)});\n` +
		"})()"
	);
}

interface InspectorResult {
	result?: { type: string; subtype?: string; value?: unknown; description?: string };
	exceptionDetails?: { text: string; exception?: { description?: string; value?: unknown } };
}

/** The Error an evaluation that threw in main reports: its message without the `Error: ` prefix. */
function mainError(details: NonNullable<InspectorResult["exceptionDetails"]>): Error {
	const description = details.exception?.description ?? String(details.exception?.value ?? details.text);
	const lines = description.split("\n");
	const first = lines[0] ?? description;
	const named = /^(\w*Error): ([\s\S]*)$/.exec(first);
	const error = new Error(named ? named[2] : first);
	if (named?.[1]) error.name = named[1];
	error.stack = description;
	return error;
}

/** A client of Node's inspector: `Runtime.evaluate` only. */
class Inspector {
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
	#next = 1;
	#closed = false;

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", event => this.#onMessage(String(event.data)));
		socket.addEventListener("close", () => this.#onClose());
		socket.addEventListener("error", () => this.#onClose());
	}

	static async connect(url: string, timeoutMs: number): Promise<Inspector> {
		const socket = new WebSocket(url);
		const opened = Promise.withResolvers<void>();
		socket.addEventListener("open", () => opened.resolve(), { once: true });
		socket.addEventListener("error", () => opened.reject(new Error(`could not reach Node's inspector at ${url}`)), {
			once: true,
		});
		const timer = setTimeout(
			() => opened.reject(new Error(`Node's inspector at ${url} did not open in ${timeoutMs} ms`)),
			timeoutMs,
		);
		try {
			await opened.promise;
		} finally {
			clearTimeout(timer);
		}
		return new Inspector(socket);
	}

	get closed(): boolean {
		return this.#closed;
	}

	#onMessage(raw: string): void {
		const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string } };
		if (message.id === undefined) return;
		const waiter = this.#pending.get(message.id);
		if (!waiter) return;
		this.#pending.delete(message.id);
		if (message.error) waiter.reject(new Error(message.error.message));
		else waiter.resolve(message.result);
	}

	#onClose(): void {
		this.#closed = true;
		for (const waiter of this.#pending.values())
			waiter.reject(new Error("The app's main process (Node's inspector connection) has been closed"));
		this.#pending.clear();
	}

	send(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.#closed)
			return Promise.reject(new Error("The app's main process (Node's inspector connection) has been closed"));
		const id = this.#next++;
		const waiter = Promise.withResolvers<unknown>();
		this.#pending.set(id, waiter);
		this.#socket.send(JSON.stringify({ id, method, params }));
		return waiter.promise;
	}

	async evaluate<R>(expression: string): Promise<R> {
		const answer = (await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			allowUnsafeEvalBlockedByCSP: true,
		})) as InspectorResult;
		if (answer.exceptionDetails) throw mainError(answer.exceptionDetails);
		return answer.result?.value as R;
	}

	close(): void {
		try {
			this.#socket.close();
		} catch {
			// already closed
		}
	}
}

/** Options of {@link launchShell}: Playwright's `electron.launch` options the specs pass. */
export interface ShellLaunchOptions {
	/**
	 * Unpackaged: `[<checkout>/out(-<hash>)/main/index.js, ...app arguments]` as `electron.launch` took them. With
	 * `executablePath` (a packaged app) they are the app's arguments alone.
	 */
	args?: string[];
	env?: Record<string, string | undefined>;
	/** A packaged `OMPdesk(.exe)`; else the staged shell. */
	executablePath?: string;
	cwd?: string;
	timeout?: number;
}

/** Process, inspector and CDP connection of one running shell: the stand-in for Playwright's `ElectronApplication`. */
export class ShellApplication extends EventEmitter {
	readonly #child: ChildProcess;
	readonly #inspector: Inspector;
	readonly #browser: Browser;

	constructor(child: ChildProcess, inspector: Inspector, browser: Browser) {
		super();
		this.#child = child;
		this.#inspector = inspector;
		this.#browser = browser;
		child.once("close", () => this.emit("close"));
	}

	/** The shell process (its stdout and stderr carry Node's). */
	process(): ChildProcess {
		return this.#child;
	}

	/** The pages' default CDP browser context. */
	context(): BrowserContext {
		const [context] = this.#browser.contexts();
		if (!context) throw new Error("The shell's CDP connection has no browser context");
		return context;
	}

	/** Every page the shell has open: the app's windows first, then views and other targets. */
	windows(): Page[] {
		const pages = this.#browser
			.contexts()
			.flatMap(context => context.pages())
			.filter(page => !page.isClosed() && !page.url().startsWith("devtools://"));
		return [...pages.filter(isAppPage), ...pages.filter(page => !isAppPage(page))];
	}

	async firstWindow(options: { timeout?: number } = {}): Promise<Page> {
		const timeout = options.timeout ?? 30_000;
		const deadline = Date.now() + timeout;
		for (;;) {
			const [first] = this.windows();
			if (first) return first;
			if (this.#inspector.closed && this.#child.exitCode !== null)
				throw new Error("app.firstWindow: the app has exited");
			if (timeout > 0 && Date.now() > deadline) throw new Error(`app.firstWindow: Timeout ${timeout}ms exceeded.`);
			await sleep(50);
		}
	}

	/** The next window the shell opens (only `"window"` exists on a shell). */
	async waitForEvent(
		event: "window",
		options:
			| { timeout?: number; predicate?: (page: Page) => boolean | Promise<boolean> }
			| ((page: Page) => boolean) = {},
	): Promise<Page> {
		if (event !== "window") throw new Error(`app.waitForEvent("${event}") is not supported on the shell`);
		const { timeout = 30_000, predicate } = typeof options === "function" ? { predicate: options } : options;
		const known = new Set(this.windows());
		const deadline = Date.now() + timeout;
		for (;;) {
			for (const page of this.windows()) {
				if (known.has(page)) continue;
				known.add(page);
				if (!predicate || (await predicate(page))) return page;
			}
			if (timeout > 0 && Date.now() > deadline) throw new Error(`app.waitForEvent: Timeout ${timeout}ms exceeded.`);
			await sleep(50);
		}
	}

	/** Runs `fn(electron, arg)` in the app's Node main; `electron` is the shim's module. */
	evaluate<R, Arg = undefined>(fn: (electron: never, arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
		return this.#inspector.evaluate<R>(evaluateExpression(fn as (...args: never[]) => unknown, arg));
	}

	/** Ends the app through its own exit and waits for the process tree ({@link exitShellApp}). */
	async close(): Promise<void> {
		await exitShellApp(this);
	}

	/**
	 * Drops the inspector and CDP connections. Node, started with `--inspect`, waits at its exit for an attached
	 * debugger to disconnect ("Waiting for the debugger to disconnect…"), so the quit lets go of it before it waits.
	 */
	async disconnect(): Promise<void> {
		this.#inspector.close();
		await this.#browser.close().catch(() => undefined);
	}
}

const isAppPage = (page: Page) => page.url().startsWith("app://ompdesk/");

/**
 * Exit the app, bypassing the production quit confirmation, and wait until the
 * process is gone so Chromium stops writing the profile before it is removed.
 * The exit is scheduled after `evaluate` returns: exiting inside it races the
 * reply ("Resulting promise was garbage collected") and can mask a test's error.
 * It is main's own `app.exit` (Node tears down and tells the shell), never CDP `Browser.close`, which quits CEF
 * without main's teardown. A main process whose thread is stuck never runs the evaluate; it is killed
 * after a grace period, so the test reports its own failure instead of the
 * worker teardown timing out.
 *
 * On Windows a process keeps the folder it works in from being removed, and the launcher exits before the app
 * under it has: main, Chromium's helpers, the omp it started, that omp's MCP servers and the git it ran wind
 * down for another ~0.1 s (measured: the omp and its `npx` chain were alive when `exitApp` returned, and the
 * spec's `fs.rm(profile)` failed `EBUSY` on `project`, 5 of 24 runs of `real-core.e2e.ts`). So the processes
 * below the launcher are listed before the exit and waited for after it; one still running after the grace
 * period is killed.
 */
export async function exitShellApp(app: Pick<ShellApplication, "process" | "evaluate" | "disconnect">): Promise<void> {
	// A killed app (a spec's crash) has closed its connections: `process()` then throws, and a `finally`
	// that cleans up after it would replace the test's own error with that one (nightly 39510409009).
	let child: ChildProcess;
	try {
		child = app.process();
	} catch {
		return;
	}
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const { processesBelow, waitForProcessesToExit } = await processTree();
	const owned = child.pid === undefined ? [] : processesBelow(child.pid);
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	const quit = app.evaluate(({ app }: { app: { exit(code: number): void } }) => {
		setImmediate(() => app.exit(0));
	});
	const stuck = Promise.withResolvers<"stuck">();
	const timer = setTimeout(() => stuck.resolve("stuck"), EXIT_GRACE_MS);
	try {
		if ((await Promise.race([quit, stuck.promise])) === "stuck") {
			quit.catch(() => undefined);
			child.kill("SIGKILL");
		}
	} catch (error) {
		// A spec that killed the app (SIGKILL) and then failed ends here with the app gone: wait for the launcher below
		// rather than let "Target closed" replace the spec's own failure in the report.
		if (!String(error).includes("has been closed")) throw error;
	} finally {
		clearTimeout(timer);
	}
	await app.disconnect();
	// `app.exit(0)` was asked and answered, yet the app can stay: nightly 41931516185's judge-preview-check finished every
	// assertion in 2.3 s and then waited here until the 90 s test timeout (its trace ends at exitApp's evaluate). The wait
	// is bounded like the ask above: a late app is killed and the spec goes on, with a line saying so.
	const late = Promise.withResolvers<"late">();
	const lateTimer = setTimeout(() => late.resolve("late"), EXIT_GRACE_MS);
	if ((await Promise.race([exited.promise.then(() => "exited" as const), late.promise])) === "late") {
		console.warn(`[exitApp] the app did not exit ${EXIT_GRACE_MS} ms after app.exit(0); killed it`);
		child.kill("SIGKILL");
		await exited.promise;
	}
	clearTimeout(lateTimer);
	await waitForProcessesToExit(owned, EXIT_GRACE_MS);
}

/** With `OMP_GUI_E2E_SHELL_LOG=1`: every page that opens, crashes or closes, so a "Target closed" has a cause on record. */
function traceTargets(browser: Browser, pid: number | undefined): void {
	const say = (what: string, page: Page) => console.error(`[shell ${pid}] page ${what}: ${page.url()}`);
	const watch = (page: Page) => {
		say("opened", page);
		page.on("close", () => say("closed", page));
		page.on("crash", () => say("crashed", page));
	};
	for (const context of browser.contexts()) {
		context.pages().forEach(watch);
		context.on("page", watch);
	}
}

/** The last bytes of what the shell wrote, for the message of a launch that failed. */
const TAIL_BYTES = 16 * 1024;

/**
 * Start the shell and connect to it, as `electron.launch` did for Electron. `args[0]` is the built app's entry
 * (`<checkout>/out(-<hash>)/main/index.js`) unless `executablePath` names a packaged app. The userData folder
 * (`--user-data-dir`, else `OMP_GUI_TEST_USER_DATA_DIR`) is required: a launch without one would work in the
 * person's real profile.
 */
export async function launchShell(options: ShellLaunchOptions = {}): Promise<ShellApplication> {
	const timeout = options.timeout || LAUNCH_TIMEOUT_MS;
	const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
	// An Electron-hosted runner exports it; it would make a Node-based child run as plain Node.
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	let args = [...(options.args ?? [])];
	let executable: string;
	if (options.executablePath) {
		executable = options.executablePath;
	} else {
		executable = assertShellBuilt(env);
		const entry = args.shift();
		if (!entry)
			throw new Error("launchShell: args[0] must be the built app's main/index.js (or give executablePath)");
		env.OMPDESK_APP_DIR = appDirOfEntry(entry);
		env.OMPDESK_APP_ENTRY = path.resolve(entry);
	}
	// The pinned Node the packaged app runs (`bun run build:node`), else `node` on PATH.
	const pinnedNode = path.join(
		REPO_ROOT,
		"resources",
		"node",
		`${process.platform}-${process.arch}`,
		process.platform === "win32" ? "node.exe" : "node",
	);
	if (!env.OMPDESK_NODE && fs.existsSync(pinnedNode)) env.OMPDESK_NODE = pinnedNode;
	const userData = userDataFromArgs(args) ?? env.OMP_GUI_TEST_USER_DATA_DIR;
	if (!userData)
		throw new Error("launchShell: pass --user-data-dir=<private dir>; the shell would use the real profile");
	args = ["--remote-debugging-port=0", ...args];
	env.OMP_GUI_TEST_NODE_INSPECT = "1";

	// A relaunch on the same userData must not read the previous run's port.
	const portFile = path.join(userData, "shell-webview", "DevToolsActivePort");
	fs.rmSync(portFile, { force: true });

	const child = spawn(executable, args, { env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
	let tail = "";
	let stderr = "";
	let inspector: Inspector | undefined;
	const remember = (chunk: Buffer, isStderr: boolean) => {
		const text = chunk.toString();
		tail = (tail + text).slice(-TAIL_BYTES);
		if (env.OMP_GUI_E2E_SHELL_LOG === "1") process.stderr.write(`[shell ${child.pid}] ${text}`);
		if (!isStderr) return;
		stderr = (stderr + text).slice(-TAIL_BYTES);
		// The app quit by itself (its own `app.quit()`): Node now waits for the attached debugger, so let go of it.
		if (inspector && stderr.includes("Waiting for the debugger to disconnect")) inspector.close();
	};
	child.stdout?.on("data", (chunk: Buffer) => remember(chunk, false));
	child.stderr?.on("data", (chunk: Buffer) => remember(chunk, true));
	const spawnFailed = Promise.withResolvers<never>();
	child.once("error", error => spawnFailed.reject(error));
	const exitedEarly = Promise.withResolvers<never>();
	child.once("exit", (code, signal) =>
		exitedEarly.reject(new Error(`the shell exited during launch (${signal ?? code}); output:\n${tail}`)),
	);
	exitedEarly.promise.catch(() => undefined);
	spawnFailed.promise.catch(() => undefined);

	const deadline = Date.now() + timeout;
	const until = async <T>(what: string, probe: () => T | undefined): Promise<T> => {
		for (;;) {
			const value = probe();
			if (value !== undefined) return value;
			if (Date.now() > deadline) throw new Error(`launchShell: ${what} within ${timeout} ms; output:\n${tail}`);
			await Promise.race([sleep(50), spawnFailed.promise, exitedEarly.promise]);
		}
	};

	let browser: Browser | undefined;
	try {
		const url = await until("Node's inspector did not report its URL", () => inspectorUrl(stderr));
		inspector = await Inspector.connect(url, Math.max(1_000, deadline - Date.now()));
		const port = await until("CEF wrote no DevToolsActivePort", () => devToolsPort(portFile));
		for (let attempt = 0; ; attempt++) {
			try {
				browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
					timeout: Math.max(1_000, deadline - Date.now()),
				});
				break;
			} catch (error) {
				if (attempt >= 20 || Date.now() > deadline) throw error;
				await Promise.race([sleep(100), exitedEarly.promise]);
			}
		}
		if (env.OMP_GUI_E2E_SHELL_LOG === "1") traceTargets(browser, child.pid);
		return new ShellApplication(child, inspector, browser);
	} catch (error) {
		inspector?.close();
		await browser?.close().catch(() => undefined);
		const { processesBelow, waitForProcessesToExit } = await processTree();
		const owned = child.pid === undefined ? [] : processesBelow(child.pid);
		child.kill("SIGKILL");
		await waitForProcessesToExit(owned, EXIT_GRACE_MS);
		throw error;
	}
}
