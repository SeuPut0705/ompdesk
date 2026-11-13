/**
 * `app`: Electron's lifecycle over the host protocol (PROTOCOL.md §2). Everything main does before `whenReady`
 * (switches, privileged schemes, "no hardware acceleration") is collected and sent as `app.init` on the first
 * macrotask after main's top-level code ran; the shell answers, starts CEF and sends `app.ready`. The quit sequence
 * is Electron's, run here: `before-quit`, every window's `close`, `will-quit`, `quit`, then `app.exit`.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostFacts, PathName, SchemeFact } from "../facts";
import { emitPreventable, type Host, makeEvent } from "./host";

export interface InitState {
	schemes: SchemeFact[];
}

export interface AppDeps {
	/** Closes every window, each through its `close` listeners; false when one was kept open. */
	closeWindows(): Promise<boolean>;
	/** Ends the process; tests replace it. */
	exitProcess?(code: number): void;
	/** The connection is already past `app.init` and `app.ready` (a parity suite's shell): ready now, no init sent. */
	attached?: boolean;
}

class CommandLine {
	readonly #switches = new Map<string, string | null>();

	constructor(args: readonly string[]) {
		for (const arg of args) {
			const match = /^--([^=]+)(?:=(.*))?$/s.exec(arg);
			if (match) this.#switches.set(match[1], match[2] ?? null);
		}
	}

	appendSwitch(name: string, value?: string): void {
		this.#switches.set(name.replace(/^--/, ""), value === undefined ? null : value);
	}

	appendArgument(_value: string): void {}

	hasSwitch(name: string): boolean {
		return this.#switches.has(name.replace(/^--/, ""));
	}

	getSwitchValue(name: string): string {
		return this.#switches.get(name.replace(/^--/, "")) ?? "";
	}

	removeSwitch(name: string): void {
		this.#switches.delete(name.replace(/^--/, ""));
	}

	entries(): Array<[string, string | null]> {
		return [...this.#switches.entries()];
	}
}

function readPackage(appPath: string): { name: string; version: string } {
	try {
		const pkg = JSON.parse(readFileSync(join(appPath, "package.json"), "utf8")) as Record<string, unknown>;
		const name = typeof pkg.productName === "string" ? pkg.productName : typeof pkg.name === "string" ? pkg.name : "";
		return { name, version: typeof pkg.version === "string" ? pkg.version : "0.0.0" };
	} catch {
		return { name: "", version: "0.0.0" };
	}
}

export class App extends EventEmitter {
	readonly commandLine: CommandLine;
	readonly isPackaged: boolean;
	readonly dock: { setBadge(text: string): void; setIcon(image: { bytes(): Buffer | null }): void } | undefined;
	readonly #host: Host;
	readonly #facts: HostFacts;
	readonly #initState: InitState;
	readonly #deps: AppDeps;
	readonly #paths = new Map<string, string>();
	readonly #package: { name: string; version: string };
	#name: string;
	#ready = false;
	#readyWaiters: Array<() => void> = [];
	#appUserModelId: string | undefined;
	#activationPolicy: string | undefined;
	#aboutPanel: Record<string, unknown> | undefined;
	#quitting = false;
	#quitRunning = false;
	#quitEmitted = false;
	#gpuFeatures: Record<string, string> = {};
	#initSent = false;

	constructor(host: Host, initState: InitState, deps: AppDeps) {
		super();
		this.#host = host;
		this.#facts = host.facts;
		this.#initState = initState;
		this.#deps = deps;
		this.isPackaged = host.facts.isPackaged;
		this.commandLine = new CommandLine(host.facts.argv.slice(1));
		for (const [name, path] of Object.entries(host.facts.paths)) this.#paths.set(name, path);
		this.#package = readPackage(host.facts.appPath);
		this.#name = this.#package.name;
		this.dock =
			process.platform === "darwin"
				? {
						setBadge: text => host.post("app.setBadge", { text }),
						setIcon: image => {
							const bytes = image.bytes();
							if (bytes) host.post("app.setDockIcon", {}, bytes);
						},
					}
				: undefined;
		this.#serve();
		if (deps.attached) {
			this.#ready = true;
			this.#initSent = true;
		} else setImmediate(() => this.#sendInit());
	}

	#serve(): void {
		const { client } = this.#host;
		client.on("app.ready", () => {
			this.#ready = true;
			this.emit("ready");
			for (const waiter of this.#readyWaiters.splice(0)) waiter();
		});
		client.on("app.childProcessGone", (details: Record<string, unknown>) => {
			this.emit("child-process-gone", makeEvent(), details);
		});
	}

	#sendInit(): void {
		if (this.#initSent) return;
		this.#initSent = true;
		this.#host.client
			.call("app.init", {
				name: this.#name,
				switches: this.commandLine.entries(),
				schemes: this.#initState.schemes,
				...(this.#appUserModelId === undefined ? {} : { appUserModelId: this.#appUserModelId }),
				...(this.#activationPolicy === undefined ? {} : { activationPolicy: this.#activationPolicy }),
				...(this.#aboutPanel === undefined ? {} : { aboutPanel: this.#aboutPanel }),
			})
			.catch((error: unknown) =>
				this.#host.warn(`app.init failed: ${error instanceof Error ? error.message : String(error)}`),
			);
	}

	// --- identity and paths ---

	get name(): string {
		return this.#name;
	}

	set name(name: string) {
		this.#name = name;
	}

	getName(): string {
		return this.#name;
	}

	setName(name: string): void {
		this.#name = name;
	}

	getVersion(): string {
		return this.#package.version;
	}

	getAppPath(): string {
		return this.#facts.appPath;
	}

	getPath(name: string): string {
		const path = this.#paths.get(name);
		if (path === undefined) throw new Error(`Failed to get '${name}' path`);
		return path;
	}

	setPath(name: PathName | string, path: string): void {
		this.#paths.set(name, path);
	}

	getLocale(): string {
		return this.#facts.locale.appLocale;
	}

	getSystemLocale(): string {
		return this.#facts.locale.systemLocale;
	}

	getPreferredSystemLanguages(): string[] {
		return [...this.#facts.locale.preferredLanguages];
	}

	// --- lifecycle ---

	isReady(): boolean {
		return this.#ready;
	}

	whenReady(): Promise<void> {
		if (this.#ready) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#readyWaiters.push(resolve);
		return promise;
	}

	requestSingleInstanceLock(): boolean {
		return true;
	}

	hasSingleInstanceLock(): boolean {
		return true;
	}

	releaseSingleInstanceLock(): void {}

	setAppUserModelId(id: string): void {
		this.#appUserModelId = id;
		if (this.#initSent) this.#host.post("app.setAppUserModelId", { id });
	}

	setActivationPolicy(policy: string): void {
		this.#activationPolicy = policy;
	}

	setAboutPanelOptions(options: Record<string, unknown>): void {
		this.#aboutPanel = options;
	}

	showAboutPanel(): void {
		this.#host.post("app.showAboutPanel");
	}

	focus(options?: { steal?: boolean }): void {
		this.#host.post("app.focus", { ...options });
	}

	hide(): void {
		this.#host.post("app.hide");
	}

	show(): void {
		this.#host.post("app.show");
	}

	async getGPUInfo(kind: "basic" | "complete"): Promise<unknown> {
		const answer = await this.#host.client.call<{ info: unknown; features: Record<string, string> }>(
			"app.getGPUInfo",
			{ kind },
		);
		this.#gpuFeatures = answer.features ?? {};
		return answer.info;
	}

	getGPUFeatureStatus(): Record<string, string> {
		return { ...this.#gpuFeatures };
	}

	relaunch(options?: { args?: string[] }): void {
		void this.#host.client.event("app.relaunch", { args: options?.args ?? null });
	}

	/**
	 * Ends the process without asking (no `before-quit`, no `will-quit`, windows closed by the shell). `quit` is
	 * emitted, once, with the exit code, as Electron's `Browser::Shutdown` does for `exit()` and for a quit that ran
	 * its course alike: electron-updater installs a downloaded update on it (`autoInstallOnAppQuit`, code 0 only).
	 */
	exit(code = 0): void {
		if (!this.#quitEmitted) {
			this.#quitEmitted = true;
			try {
				this.emit("quit", makeEvent(), code);
			} catch (error) {
				this.#host.warn(`app quit listener: ${String(error)}`);
			}
		}
		void this.#host.client.event("app.exit", { code });
		const exit = this.#deps.exitProcess ?? ((status: number) => process.exit(status));
		this.#host.client.flush().then(
			() => exit(code),
			() => exit(code),
		);
	}

	quit(): void {
		void this.#runQuit();
	}

	async #runQuit(): Promise<void> {
		if (this.#quitRunning) return;
		this.#quitRunning = true;
		try {
			if (!emitPreventable(this, "before-quit")) return;
			this.#quitting = true;
			if (!(await this.#deps.closeWindows())) return;
			if (!emitPreventable(this, "will-quit")) return;
			this.exit(0);
		} finally {
			this.#quitting = false;
			this.#quitRunning = false;
		}
	}

	/** `window-all-closed` is not emitted while a quit closes the windows, as in Electron. */
	override emit(name: string | symbol, ...args: unknown[]): boolean {
		if (name === "window-all-closed" && this.#quitting) return false;
		return super.emit(name, ...args);
	}
}
