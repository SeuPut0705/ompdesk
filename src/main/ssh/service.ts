/**
 * Settings › SSH tools on this computer (contract `src/shared/ssh-tools.ts`), main's side: what the person wants
 * running. C151 port forwards, saved per server in `<userData>/ssh-forwards.json` and started again at launch, and a
 * watch of the server's listening ports; C152 a dropped forward reconnects with a growing delay until the grace time
 * runs out ("Reconnect now" skips the wait); C149 the ssh-agent and key state.
 *
 * Every ssh itself runs in the core process (`./client.ts`, `native/ompdesk/crates/core/src/ssh`): what a host, a
 * user, a key path and a port may be and the arguments they become, OMPdesk's own known_hosts on every hop, the
 * questions ssh asks, and why an ssh ended. It ends with the app as every process of the core does.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
	SSH_GRACE_DEFAULT_MS,
	SSH_GRACE_MAX_MS,
	SSH_GRACE_MIN_MS,
	type SshAgentStatus,
	type SshForward,
	type SshPortWatch,
	type SshPrompt,
	type SshTarget,
	type SshToolsRequest,
	type SshToolsState,
} from "../../shared/ssh-tools";
import { writeFileAtomic } from "../atomic-file";
import { CoreError } from "../core/process";
import { SshCore, type SshFailure, type SshRun } from "./client";

/** Waits before reconnect attempt 1, 2, 3, …; the last repeats. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

// The shape only. What a host, a user, a key path and a port may be is the core's rule, checked where the arguments
// are built (`ssh/rules.rs`): a forward's plan, a watch's start and a forgotten key each refuse what is none.
const targetSchema = z.object({
	name: z.string(),
	host: z.string(),
	username: z.string().optional(),
	port: z.number().optional(),
	keyPath: z.string().optional(),
});
const requestSchema: z.ZodType<SshToolsRequest> = z.discriminatedUnion("action", [
	z.object({ action: z.literal("state") }),
	z.object({ action: z.literal("watch"), target: targetSchema, on: z.boolean() }),
	z.object({
		action: z.literal("forward"),
		target: targetSchema,
		remotePort: z.number(),
		localPort: z.number().optional(),
	}),
	z.object({ action: z.enum(["stop", "remove", "reconnect"]), id: z.string() }),
	z.object({ action: z.literal("setGrace"), ms: z.number().int().min(SSH_GRACE_MIN_MS).max(SSH_GRACE_MAX_MS) }),
	z.object({ action: z.literal("forgetHostKey"), target: targetSchema }),
	z.object({ action: z.literal("answer"), id: z.string(), value: z.string().nullable() }),
	z.object({ action: z.literal("createKey") }),
	z.object({ action: z.literal("loadKeys") }),
]);
const storeSchema = z.object({
	graceMs: z.number().int().min(SSH_GRACE_MIN_MS).max(SSH_GRACE_MAX_MS),
	forwards: z.array(
		z.object({
			id: z.string(),
			server: z.string(),
			target: targetSchema,
			localPort: z.number(),
			remotePort: z.number(),
			active: z.boolean(),
		}),
	),
});

interface ForwardRuntime {
	forward: SshForward;
	/** The user wants it running (saved; restored at launch). */
	active: boolean;
	child: SshRun | null;
	attempt: number;
	/** When the forward last dropped while running; reconnecting stops `graceMs` after it. */
	droppedAt: number | null;
	timer: NodeJS.Timeout | null;
	/** Bumped by every halt (stop, remove, reconnect, dispose): a connect that sees it changed is stale and ends. */
	generation: number;
	/** The generation whose connect is in flight (before its ssh exists), else null: one connect per generation. */
	connecting: number | null;
	/** Every ssh of this forward that has not closed yet, halted ones included: they still hold the local port. */
	exits: Set<Promise<void>>;
}
interface WatchRuntime {
	watch: SshPortWatch;
	target: SshTarget;
	/** Null while the ssh is being started; the entry is in the map from the toggle on, so a toggle off finds it. */
	child: SshRun | null;
	stopped: boolean;
}

function forwardRuntime(forward: SshForward, active: boolean): ForwardRuntime {
	return {
		forward,
		active,
		child: null,
		attempt: 0,
		droppedAt: null,
		timer: null,
		generation: 0,
		connecting: null,
		exits: new Set(),
	};
}

export interface SshToolsDeps {
	userData: string;
	broadcast: (channel: "state" | "prompt", data: SshToolsState | SshPrompt[]) => void;
}

export class SshTools {
	readonly #deps: SshToolsDeps;
	readonly #storeFile: string;
	readonly #core: SshCore;
	readonly #forwards = new Map<string, ForwardRuntime>();
	readonly #watches = new Map<string, WatchRuntime>();
	#graceMs = SSH_GRACE_DEFAULT_MS;
	#loaded: Promise<void> | null = null;
	/** Saves run one after another, so an older snapshot never lands after a newer one. */
	#saving: Promise<void> = Promise.resolve();
	#disposed = false;
	/** Connects in flight and halted ssh processes that have not closed yet: what `settled()` waits for. */
	readonly #inFlight = new Set<Promise<unknown>>();

	constructor(deps: SshToolsDeps) {
		this.#deps = deps;
		this.#storeFile = path.join(deps.userData, "ssh-forwards.json");
		this.#core = new SshCore(path.join(deps.userData, "ssh"), prompts => deps.broadcast("prompt", prompts));
	}

	/** Load the saved forwards and start the ones that were running (launch restore). */
	start(): Promise<void> {
		this.#loaded ??= (async () => {
			const text = await fs.readFile(this.#storeFile, "utf8").catch(() => null);
			if (text === null) return;
			let data: z.infer<typeof storeSchema> | null = null;
			try {
				const parsed = storeSchema.safeParse(JSON.parse(text));
				if (parsed.success) data = parsed.data;
			} catch {}
			if (!data) {
				// Keep an unreadable store aside: the next save would otherwise overwrite the user's forwards.
				await fs.rename(this.#storeFile, `${this.#storeFile}.corrupt`).catch(() => {});
				return;
			}
			this.#graceMs = data.graceMs;
			for (const saved of data.forwards) {
				const runtime = forwardRuntime({ ...saved, status: { kind: "stopped", error: null } }, saved.active);
				this.#forwards.set(saved.id, runtime);
				if (saved.active) this.#background(this.#connect(runtime));
			}
			this.#changed();
		})().catch(() => {});
		return this.#loaded;
	}

	state(): SshToolsState {
		return {
			forwards: [...this.#forwards.values()].map(entry => entry.forward),
			watches: [...this.#watches.values()].map(entry => entry.watch),
			graceMs: this.#graceMs,
		};
	}

	prompts(): SshPrompt[] {
		return this.#core.prompts();
	}

	async command(raw: unknown): Promise<SshToolsState> {
		await this.start();
		const request = requestSchema.parse(raw);
		if (request.action === "watch") {
			if (request.on) await this.#watch(request.target);
			else this.#unwatch(request.target.name);
		} else if (request.action === "forward") {
			await this.#forward(request.target, request.remotePort, request.localPort);
		} else if (request.action === "stop" || request.action === "remove" || request.action === "reconnect") {
			const runtime = this.#forwards.get(request.id);
			if (!runtime) throw new Error("Unknown forward");
			if (request.action === "reconnect") {
				runtime.active = true;
				runtime.droppedAt = null;
				runtime.attempt = 0;
				this.#halt(runtime);
				this.#background(this.#connect(runtime));
			} else {
				runtime.active = false;
				this.#halt(runtime);
				this.#status(runtime, { kind: "stopped", error: null });
				if (request.action === "remove") this.#forwards.delete(request.id);
			}
			await this.#save();
		} else if (request.action === "setGrace") {
			this.#graceMs = request.ms;
			await this.#save();
		} else if (request.action === "forgetHostKey") await this.#forgetHostKey(request.target);
		else if (request.action === "answer") await this.#core.answer(request.id, request.value);
		// The Settings buttons "Create a key" and "Add keys to the agent": the app runs ssh-keygen and ssh-add.
		else if (request.action === "createKey") await this.#core.createKey();
		else if (request.action === "loadKeys") await this.#core.loadKeys();
		this.#changed();
		return this.state();
	}

	/** C149: does an ssh-agent answer, which keys it holds, which key files exist. */
	agent(): Promise<SshAgentStatus> {
		return this.#core.agent();
	}

	dispose(): void {
		this.#disposed = true;
		for (const runtime of this.#forwards.values()) this.#halt(runtime);
		for (const server of [...this.#watches.keys()]) this.#unwatch(server);
		this.#core.close();
	}

	/**
	 * Resolves once no connect or watch start is in flight and every ssh this service ended has closed. A
	 * negative claim ("no ssh starts", "no loop keeps running") is then a fact to check, not a wait.
	 */
	async settled(): Promise<void> {
		while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
	}

	#background(work: Promise<unknown>): void {
		this.#inFlight.add(work);
		void work.finally(() => this.#inFlight.delete(work));
	}

	/** Ends an ssh and tracks it until it has closed. */
	#end(child: SshRun): void {
		this.#background(child.exited);
		child.stop();
	}

	#changed(): void {
		this.#deps.broadcast("state", this.state());
	}

	#save(): Promise<void> {
		const write = this.#saving.then(async () => {
			const data = {
				graceMs: this.#graceMs,
				forwards: [...this.#forwards.values()].map(({ forward, active }) => ({
					id: forward.id,
					server: forward.server,
					target: forward.target,
					localPort: forward.localPort,
					remotePort: forward.remotePort,
					active,
				})),
			};
			await writeFileAtomic(this.#storeFile, JSON.stringify(data, null, "\t"));
		});
		this.#saving = write.catch(() => {});
		return write;
	}

	/** For the places nobody awaits (a close handler, a background connect): a failed save is not an unhandled rejection. */
	#saveQuietly(): Promise<void> {
		return this.#save().catch(() => {});
	}

	async #forward(target: SshTarget, remotePort: number, localPort?: number): Promise<void> {
		// The core refuses a host, a user, a key path or a port that is none, and names a free local port.
		const free = await this.#core.plan(target, remotePort, localPort ?? remotePort);
		const existing = [...this.#forwards.values()].find(
			entry => entry.forward.server === target.name && entry.forward.remotePort === remotePort,
		);
		if (existing) {
			existing.forward = { ...existing.forward, target };
			existing.active = true;
			existing.droppedAt = null;
			existing.attempt = 0;
			if (!existing.child && !existing.timer) this.#background(this.#connect(existing));
			await this.#save();
			return;
		}
		const runtime = forwardRuntime(
			{
				id: randomBytes(8).toString("hex"),
				server: target.name,
				target,
				localPort: free,
				remotePort,
				status: { kind: "connecting" },
			},
			true,
		);
		this.#forwards.set(runtime.forward.id, runtime);
		await this.#save();
		this.#background(this.#connect(runtime));
	}

	#status(runtime: ForwardRuntime, status: SshForward["status"]): void {
		runtime.forward = { ...runtime.forward, status };
		this.#changed();
	}

	/** Ends the forward's ssh and voids any connect in flight. */
	#halt(runtime: ForwardRuntime): void {
		runtime.generation += 1;
		clearTimeout(runtime.timer ?? undefined);
		runtime.timer = null;
		const child = runtime.child;
		runtime.child = null;
		if (child) this.#end(child);
	}

	/** Never rejects: a failure becomes the forward's stopped status. */
	async #connect(runtime: ForwardRuntime): Promise<void> {
		const generation = runtime.generation;
		if (runtime.child || runtime.connecting === generation) return;
		runtime.connecting = generation;
		const stale = () => this.#disposed || !runtime.active || runtime.generation !== generation;
		try {
			clearTimeout(runtime.timer ?? undefined);
			runtime.timer = null;
			this.#status(runtime, { kind: "connecting" });
			// A halted ssh still holds the local port until it has closed.
			while (runtime.exits.size > 0) await Promise.all([...runtime.exits]);
			if (stale()) return;
			const { forward } = runtime;
			// The saved local port may have been taken while it was down.
			const free =
				(await this.#core.plan(forward.target, forward.remotePort, forward.localPort)) === forward.localPort;
			if (stale()) return;
			if (!free) {
				runtime.active = false;
				this.#status(runtime, { kind: "stopped", error: `Local port ${forward.localPort} is in use` });
				await this.#saveQuietly();
				return;
			}
			const child = await this.#core.forward(forward.target, forward.localPort, forward.remotePort);
			const exited = child.exited.then(() => {
				runtime.exits.delete(exited);
			});
			runtime.exits.add(exited);
			if (stale()) {
				this.#end(child);
				return;
			}
			runtime.child = child;
			child.listen({
				up: () => {
					if (runtime.child !== child || runtime.forward.status.kind === "up") return;
					runtime.attempt = 0;
					runtime.droppedAt = null;
					this.#status(runtime, { kind: "up" });
				},
				exit: failure => this.#dropped(runtime, child, failure),
			});
		} catch (error) {
			if (stale()) return;
			runtime.active = false;
			this.#status(runtime, { kind: "stopped", error: error instanceof Error ? error.message : String(error) });
			await this.#saveQuietly();
		} finally {
			if (runtime.connecting === generation) runtime.connecting = null;
		}
	}

	/** The forward's ssh ended by itself: stop for good, or try again after the next delay. */
	#dropped(runtime: ForwardRuntime, child: SshRun, failure: SshFailure): void {
		if (runtime.child !== child) return;
		runtime.child = null;
		if (!runtime.active) return;
		if (failure.kind === "hostKeyChanged") {
			runtime.active = false;
			this.#status(runtime, { kind: "hostKeyChanged", detail: failure.message });
			void this.#saveQuietly();
			return;
		}
		if (failure.kind === "refused") {
			runtime.active = false;
			this.#status(runtime, { kind: "stopped", error: failure.message });
			void this.#saveQuietly();
			return;
		}
		const now = Date.now();
		runtime.droppedAt ??= now;
		if (now - runtime.droppedAt >= this.#graceMs) {
			runtime.active = false;
			this.#status(runtime, { kind: "stopped", error: failure.message });
			void this.#saveQuietly();
			return;
		}
		const delay = RETRY_DELAYS_MS[Math.min(runtime.attempt, RETRY_DELAYS_MS.length - 1)] ?? 60_000;
		runtime.attempt += 1;
		this.#status(runtime, {
			kind: "retrying",
			at: now + delay,
			attempt: runtime.attempt,
			error: failure.message,
		});
		runtime.timer = setTimeout(() => this.#background(this.#connect(runtime)), delay);
	}

	async #watch(target: SshTarget): Promise<void> {
		this.#unwatch(target.name);
		// In the map before the first await: a toggle off (or another toggle on) during the start finds this entry.
		const runtime: WatchRuntime = {
			watch: { server: target.name, ports: [], opened: [], error: null, loading: true },
			target,
			child: null,
			stopped: false,
		};
		this.#watches.set(target.name, runtime);
		let child: SshRun;
		try {
			child = await this.#core.watch(target);
		} catch (error) {
			if (runtime.stopped) return;
			if (error instanceof CoreError && error.code === "invalid_request") {
				// What the page sent is no host (the core's refusal): nothing to watch, and the command fails as it always did.
				this.#watches.delete(target.name);
				throw error;
			}
			runtime.watch = {
				...runtime.watch,
				loading: false,
				error: error instanceof Error ? error.message : String(error),
			};
			return;
		}
		if (runtime.stopped) {
			this.#end(child);
			return;
		}
		runtime.child = child;
		child.listen({
			// The core tells a listing only when it differs from the one before.
			ports: (ports, opened) => {
				runtime.watch = { ...runtime.watch, ports, opened, loading: false, error: null };
				this.#changed();
			},
			exit: failure => {
				if (runtime.stopped || this.#watches.get(target.name) !== runtime) return;
				runtime.watch = { ...runtime.watch, loading: false, error: failure.message };
				this.#changed();
			},
		});
	}

	#unwatch(server: string): void {
		const runtime = this.#watches.get(server);
		if (!runtime) return;
		runtime.stopped = true;
		this.#watches.delete(server);
		if (runtime.child) this.#end(runtime.child);
	}

	/** C147: drop the target's and every hop's saved key from OMPdesk's known_hosts. */
	async #forgetHostKey(target: SshTarget): Promise<void> {
		await this.#core.forgetHostKey(target);
		for (const runtime of this.#forwards.values())
			if (runtime.forward.server === target.name && runtime.forward.status.kind === "hostKeyChanged")
				this.#status(runtime, { kind: "stopped", error: null });
	}
}
