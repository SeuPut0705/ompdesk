/**
 * The typed client of the core's ssh methods (`native/ompdesk/crates/core/src/ssh`): the rules of a saved host and
 * its arguments, the config every run reads, the questions an ssh asks (`SSH_ASKPASS`) and every ssh, ssh-keygen and
 * ssh-add process run there. This side hands each request how to run, as `exec.ts` does for git and gh: the three
 * programs, the whole environment, the home folder and OMPdesk's own ssh folder, read when the request is made.
 *
 * A forward or a watch is a run: `ssh.forward` / `ssh.watch` answer once the ssh started, the core then reports it by
 * events (`ssh.up`, `ssh.ports`, `ssh.exit`) and `ssh.stop` asks it to end. A core that ended took its runs with it
 * (its job object, its process group): they are reported as dropped when the next core starts or a stop finds none.
 */
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
	SSH_PORT_POLL_SECONDS,
	SSH_PROMPT_TIMEOUT_MS,
	type SshAgentStatus,
	type SshPrompt,
	type SshTarget,
} from "../../shared/ssh-tools";
import { CoreError, core } from "../core/process";

/** How long one short run (`ssh -G`, `ssh-keygen`, `ssh-add`) may take; the TypeScript waited without a bound. */
const TOOL_TIMEOUT_MS = 30_000;
/** Room past a request's processes for the core round trip and the end of one that ran past its time. */
const SLACK_MS = 10_000;
/** `ssh-add` once per key file. */
const LOAD_KEYS_TIMEOUT_MS = 5 * 60_000;
/** `ssh -G`, then `ssh-keygen -R` for the host and each ProxyJump hop. */
const FORGET_TIMEOUT_MS = 2 * 60_000;

/** `ssh`, `ssh-add`, `ssh-keygen`: from PATH, or beside `OMP_GUI_SSH` (tests point it at a fake ssh). */
export function sshTool(name: "ssh" | "ssh-add" | "ssh-keygen"): string {
	const override = process.env.OMP_GUI_SSH;
	if (!override) return name;
	return name === "ssh" ? override : path.join(path.dirname(override), `${name}${path.extname(override)}`);
}

/** Why an ssh ended, as the core read its stderr: retrying cannot help with a changed key or a refused login. */
export interface SshFailure {
	kind: "hostKeyChanged" | "refused" | "dropped";
	message: string;
}

/** What a run reports once its owner listens. */
export interface SshRunEvents {
	/** A forward's local port accepts connections. */
	up?(): void;
	/** A watch's listing differs from the one before; `opened` are the ports the first listing did not have. */
	ports?(ports: number[], opened: number[]): void;
	/** The ssh is gone. */
	exit(failure: SshFailure): void;
}

/** One ssh that stays, started in the core. */
export interface SshRun {
	/** Resolves once the ssh is gone (it holds its local port until then). */
	readonly exited: Promise<void>;
	/** Delivers what the run reported since it started, then what it reports from now on. */
	listen(events: SshRunEvents): void;
	/** Asks the ssh to end; `exited` says when it has. */
	stop(): void;
}

interface Live {
	/** The core that runs it. */
	core: number | null;
	events: SshRunEvents | null;
	/** What it reported before its owner listened. */
	held: Array<(events: SshRunEvents) => void>;
	gone: () => void;
}

const CORE_GONE: SshFailure = { kind: "dropped", message: "ompdesk-core exited" };

export class SshCore {
	/** Named once: the core refuses a request that arrives after this service's close. */
	readonly #service = randomBytes(6).toString("hex");
	readonly #dir: string;
	readonly #onPrompts: (prompts: SshPrompt[]) => void;
	readonly #runs = new Map<string, Live>();
	readonly #unsubscribe: Array<() => void>;
	#prompts: SshPrompt[] = [];
	#sequence = 0;
	#closed = false;

	/** `dir` is OMPdesk's own ssh folder (`<userData>/ssh`); `onPrompts` hears the waiting questions after every change. */
	constructor(dir: string, onPrompts: (prompts: SshPrompt[]) => void) {
		this.#dir = dir;
		this.#onPrompts = onPrompts;
		const mine =
			<T extends { service: string }>(handle: (data: T) => void) =>
			(data: unknown) => {
				if ((data as T).service === this.#service) handle(data as T);
			};
		const events = core();
		this.#unsubscribe = [
			events.on(
				"ssh.up",
				mine<{ service: string; run: string }>(data => this.#deliver(data.run, run => run.up?.())),
			),
			events.on(
				"ssh.ports",
				mine<{ service: string; run: string; ports: number[]; opened: number[] }>(data =>
					this.#deliver(data.run, run => run.ports?.(data.ports, data.opened)),
				),
			),
			events.on(
				"ssh.exit",
				mine<{ service: string; run: string; failure: SshFailure }>(data => this.#exit(data.run, data.failure)),
			),
			events.on(
				"ssh.prompts",
				mine<{ service: string; prompts: SshPrompt[] }>(data => this.#asked(data.prompts)),
			),
			// A core that started after the one a run was started on holds nothing of it.
			events.on("ready", () => this.#coreStarted()),
		];
	}

	/** The questions waiting now. */
	prompts(): SshPrompt[] {
		return this.#prompts;
	}

	/**
	 * Before a forward connects: the core checks what the page sent (host, user, key path, ports) and answers the
	 * local port to use, `localPort` when it is free, else one the system picks.
	 */
	async plan(target: SshTarget, remotePort: number, localPort: number): Promise<number> {
		const { result } = await core().call<{ localPort: number }>("ssh.plan", { target, remotePort, localPort });
		return result.localPort;
	}

	/** `ssh -N -L`: this computer's `localPort` to the server's `remotePort`. Resolves once the ssh started. */
	forward(target: SshTarget, localPort: number, remotePort: number): Promise<SshRun> {
		return this.#start("ssh.forward", { target, localPort, remotePort });
	}

	/** The server's listening ports, listed again every `SSH_PORT_POLL_SECONDS`. Resolves once the ssh started. */
	watch(target: SshTarget): Promise<SshRun> {
		return this.#start("ssh.watch", { target, pollSeconds: SSH_PORT_POLL_SECONDS });
	}

	/** The person's answer to a waiting question (`null` cancels it); an unknown or expired id does nothing. */
	async answer(id: string, value: string | null): Promise<void> {
		await core().call("ssh.answer", { service: this.#service, id, value });
	}

	async agent(): Promise<SshAgentStatus> {
		const { result } = await core().call<SshAgentStatus>(
			"ssh.agent",
			{ how: this.#how() },
			{ timeoutMs: TOOL_TIMEOUT_MS + SLACK_MS },
		);
		return result;
	}

	/** `ssh-keygen`: `~/.ssh/id_ed25519` without a passphrase, never over a key that is there. */
	async createKey(): Promise<void> {
		await core().call("ssh.createKey", { how: this.#how() }, { timeoutMs: TOOL_TIMEOUT_MS + SLACK_MS });
	}

	/** `ssh-add` for every private key in `~/.ssh` that has its `.pub` beside it. */
	async loadKeys(): Promise<void> {
		await core().call("ssh.loadKeys", { how: this.#how() }, { timeoutMs: LOAD_KEYS_TIMEOUT_MS });
	}

	/** Drops the saved key of `target` and of every ProxyJump hop from OMPdesk's known_hosts. */
	async forgetHostKey(target: SshTarget): Promise<void> {
		await core().call("ssh.forgetHostKey", { how: this.#how(), target }, { timeoutMs: FORGET_TIMEOUT_MS });
	}

	/** Ends everything this service has in the core, for good. Runs still report their end. */
	close(): void {
		this.#closed = true;
		// Only a running core holds anything: none is started to close nothing.
		if (core().pid === null) for (const run of [...this.#runs.keys()]) this.#exit(run, CORE_GONE);
		else
			core()
				.call("ssh.close", { service: this.#service })
				.catch(() => {
					// A core that ended has ended them already.
				});
		this.#settle();
	}

	#how() {
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
		return {
			ssh: sshTool("ssh"),
			sshAdd: sshTool("ssh-add"),
			sshKeygen: sshTool("ssh-keygen"),
			env,
			home: os.homedir(),
			dir: this.#dir,
			timeoutMs: TOOL_TIMEOUT_MS,
		};
	}

	async #start(method: string, params: object): Promise<SshRun> {
		const id = String(++this.#sequence);
		const gone = Promise.withResolvers<void>();
		const live: Live = { core: null, events: null, held: [], gone: gone.resolve };
		// Listed before the request is sent: an ssh that ends at once may report its end before the answer comes.
		this.#runs.set(id, live);
		const stop = () => {
			if (!this.#runs.has(id)) return;
			if (core().pid !== live.core) return this.#exit(id, CORE_GONE);
			core()
				.call("ssh.stop", { service: this.#service, run: id })
				.catch(() => this.#exit(id, CORE_GONE));
		};
		const started = core().call(method, {
			service: this.#service,
			run: id,
			how: this.#how(),
			promptTimeoutMs: SSH_PROMPT_TIMEOUT_MS,
			...params,
		});
		live.core = core().pid;
		try {
			await started;
		} catch (error) {
			// A late answer may have started it after all: nothing of a failed start stays.
			if (error instanceof CoreError && error.code === "timeout") stop();
			this.#runs.delete(id);
			this.#settle();
			throw error;
		}
		return {
			exited: gone.promise,
			listen: events => {
				live.events = events;
				for (const report of live.held.splice(0)) report(events);
			},
			stop,
		};
	}

	#deliver(id: string, report: (events: SshRunEvents) => void): void {
		const live = this.#runs.get(id);
		if (!live) return;
		if (live.events) report(live.events);
		else live.held.push(report);
	}

	#exit(id: string, failure: SshFailure): void {
		const live = this.#runs.get(id);
		if (!live) return;
		this.#deliver(id, run => run.exit(failure));
		this.#runs.delete(id);
		live.gone();
		this.#settle();
	}

	#asked(prompts: SshPrompt[]): void {
		this.#prompts = prompts;
		this.#onPrompts(prompts);
	}

	#coreStarted(): void {
		const running = core().pid;
		for (const [id, live] of [...this.#runs]) if (live.core !== running) this.#exit(id, CORE_GONE);
		if (this.#prompts.length > 0) this.#asked([]);
	}

	/** A closed service with no run left hears nothing more. */
	#settle(): void {
		if (!this.#closed || this.#runs.size > 0) return;
		for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
	}
}
