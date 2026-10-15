/**
 * Settings › SSH tools on this computer (contract `src/shared/ssh-tools.ts`):
 * C151 port forwards (`ssh -N -L`, saved per server in
 * `<userData>/ssh-forwards.json` and started again at launch) and a watch of
 * the server's listening ports every `SSH_PORT_POLL_SECONDS`; C152 a dropped
 * forward reconnects with a growing delay until the grace time runs out
 * ("Reconnect now" skips the wait); C149 the ssh-agent and key state.
 * Every ssh runs under the setup supervisor, so it dies with the app, and
 * through main/ssh/options.ts (OMPdesk's known_hosts, every hop checked) and
 * main/ssh/askpass.ts (questions to the window).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
	SSH_GRACE_DEFAULT_MS,
	SSH_GRACE_MAX_MS,
	SSH_GRACE_MIN_MS,
	SSH_PORT_POLL_SECONDS,
	type SshAgentStatus,
	type SshForward,
	type SshPortWatch,
	type SshPrompt,
	type SshTarget,
	type SshToolsRequest,
	type SshToolsState,
} from "../../shared/ssh-tools";
import { spawnSupervised } from "../setup/supervisor";
import { AskpassServer } from "./askpass";
import { classifyFailure, knownHostNames, parseListeningPorts, sshTool, targetArgs, writeSshConfig } from "./options";

/** Waits before reconnect attempt 1, 2, 3, …; the last repeats. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
/** How often a starting forward checks its local port. */
const PROBE_MS = 400;
const STDERR_KEEP = 8_000;
const WATCH_MARKER = "__ompdesk_ports__";

const targetSchema = z.object({
	name: z.string().min(1).max(200),
	host: z
		.string()
		.min(1)
		.max(255)
		.refine(value => !value.startsWith("-"), "Invalid host"),
	username: z
		.string()
		.max(100)
		.refine(value => !value.startsWith("-"), "Invalid user")
		.optional(),
	port: z.number().int().min(1).max(65535).optional(),
	keyPath: z
		.string()
		.max(1000)
		.refine(value => !value.startsWith("-"), "Invalid key path")
		.optional(),
});
const portSchema = z.number().int().min(1).max(65535);
const requestSchema: z.ZodType<SshToolsRequest> = z.discriminatedUnion("action", [
	z.object({ action: z.literal("state") }),
	z.object({ action: z.literal("watch"), target: targetSchema, on: z.boolean() }),
	z.object({
		action: z.literal("forward"),
		target: targetSchema,
		remotePort: portSchema,
		localPort: portSchema.optional(),
	}),
	z.object({ action: z.enum(["stop", "remove", "reconnect"]), id: z.string() }),
	z.object({ action: z.literal("setGrace"), ms: z.number().int().min(SSH_GRACE_MIN_MS).max(SSH_GRACE_MAX_MS) }),
	z.object({ action: z.literal("forgetHostKey"), target: targetSchema }),
	z.object({ action: z.literal("answer"), id: z.string(), value: z.string().max(4000).nullable() }),
]);
const storeSchema = z.object({
	graceMs: z.number().int().min(SSH_GRACE_MIN_MS).max(SSH_GRACE_MAX_MS),
	forwards: z.array(
		z.object({
			id: z.string(),
			server: z.string(),
			target: targetSchema,
			localPort: portSchema,
			remotePort: portSchema,
			active: z.boolean(),
		}),
	),
});

interface ForwardRuntime {
	forward: SshForward;
	/** The user wants it running (saved; restored at launch). */
	active: boolean;
	child: ChildProcess | null;
	attempt: number;
	/** When the forward last dropped while running; reconnecting stops `graceMs` after it. */
	droppedAt: number | null;
	timer: NodeJS.Timeout | null;
}
interface WatchRuntime {
	watch: SshPortWatch;
	target: SshTarget;
	child: ChildProcess;
	initial: number[] | null;
	stopped: boolean;
}

/** Run one short command; never throws (exit code `null` = it could not start). */
function run(file: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string }>();
	let stdout = "";
	const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		stdout += chunk;
	});
	child.on("error", () => resolve({ code: null, stdout }));
	child.on("close", code => resolve({ code, stdout }));
	return promise;
}

/** A free local port: `wanted` when it is free, else one the system picks. */
async function freePort(wanted: number): Promise<number> {
	const attempt = (port: number) => {
		const { promise, resolve } = Promise.withResolvers<number | null>();
		const server = net.createServer();
		server.once("error", () => resolve(null));
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolve(typeof address === "object" && address ? address.port : null));
		});
		return promise;
	};
	const port = (await attempt(wanted)) ?? (await attempt(0));
	if (!port) throw new Error("No free local port");
	return port;
}

function accepts(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect({ host: "127.0.0.1", port });
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	return promise;
}

export interface SshToolsDeps {
	userData: string;
	broadcast: (channel: "state" | "prompt", data: SshToolsState | SshPrompt[]) => void;
}

export class SshTools {
	readonly #deps: SshToolsDeps;
	readonly #dir: string;
	readonly #storeFile: string;
	readonly #askpass: AskpassServer;
	readonly #forwards = new Map<string, ForwardRuntime>();
	readonly #watches = new Map<string, WatchRuntime>();
	#graceMs = SSH_GRACE_DEFAULT_MS;
	#config: Promise<{ config: string; knownHosts: string }> | null = null;
	#loaded: Promise<void> | null = null;

	constructor(deps: SshToolsDeps) {
		this.#deps = deps;
		this.#dir = path.join(deps.userData, "ssh");
		this.#storeFile = path.join(deps.userData, "ssh-forwards.json");
		this.#askpass = new AskpassServer(this.#dir, prompts => deps.broadcast("prompt", prompts));
	}

	/** Load the saved forwards and start the ones that were running (launch restore). */
	start(): Promise<void> {
		this.#loaded ??= (async () => {
			const text = await fs.readFile(this.#storeFile, "utf8").catch(() => null);
			const parsed = text ? storeSchema.safeParse(JSON.parse(text)) : null;
			if (!parsed?.success) return;
			this.#graceMs = parsed.data.graceMs;
			for (const saved of parsed.data.forwards) {
				const runtime: ForwardRuntime = {
					forward: { ...saved, status: { kind: "stopped", error: null } },
					active: saved.active,
					child: null,
					attempt: 0,
					droppedAt: null,
					timer: null,
				};
				this.#forwards.set(saved.id, runtime);
				if (saved.active) void this.#connect(runtime);
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
		return this.#askpass.list();
	}

	async command(raw: unknown): Promise<SshToolsState> {
		await this.start();
		const request = requestSchema.parse(raw);
		if (request.action === "watch")
			await (request.on ? this.#watch(request.target) : this.#unwatch(request.target.name));
		else if (request.action === "forward") await this.#forward(request.target, request.remotePort, request.localPort);
		else if (request.action === "stop" || request.action === "remove" || request.action === "reconnect") {
			const runtime = this.#forwards.get(request.id);
			if (!runtime) throw new Error("Unknown forward");
			if (request.action === "reconnect") {
				runtime.active = true;
				runtime.droppedAt = null;
				runtime.attempt = 0;
				this.#halt(runtime);
				void this.#connect(runtime);
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
		else if (request.action === "answer") this.#askpass.answer(request.id, request.value);
		this.#changed();
		return this.state();
	}

	/** C149: does an ssh-agent answer, which keys it holds, which key files exist. */
	async agent(): Promise<SshAgentStatus> {
		const [listed, keygen, files] = await Promise.all([
			run(sshTool("ssh-add"), ["-l"]),
			run(sshTool("ssh-keygen"), ["-?"]),
			fs.readdir(path.join(os.homedir(), ".ssh")).catch(() => [] as string[]),
		]);
		// ssh-add -l: 0 = keys listed, 1 = an agent without keys, 2 = no agent to talk to.
		const agent = listed.code === 0 || listed.code === 1 ? "available" : listed.code === 2 ? "none" : "error";
		return {
			agent,
			agentKeys:
				listed.code === 0
					? listed.stdout
							.split("\n")
							.map(line => line.trim())
							.filter(Boolean)
					: [],
			keyFiles: files.filter(name => name.endsWith(".pub")).sort(),
			keygen: keygen.code !== null,
		};
	}

	dispose(): void {
		for (const runtime of this.#forwards.values()) this.#halt(runtime);
		for (const watch of this.#watches.values()) {
			watch.stopped = true;
			watch.child.stdin?.end();
		}
		this.#askpass.close();
	}

	#changed(): void {
		this.#deps.broadcast("state", this.state());
	}

	#sshConfig() {
		this.#config ??= writeSshConfig(this.#dir, os.homedir());
		return this.#config;
	}

	async #save(): Promise<void> {
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
		await fs.mkdir(path.dirname(this.#storeFile), { recursive: true });
		await fs.writeFile(`${this.#storeFile}.tmp`, JSON.stringify(data, null, "\t"));
		await fs.rename(`${this.#storeFile}.tmp`, this.#storeFile);
	}

	/** Start an ssh under the supervisor, asking through askpass on behalf of `server`. */
	async #spawn(server: string, args: string[]): Promise<{ child: ChildProcess; release: () => void }> {
		const { config } = await this.#sshConfig();
		const askpass = await this.#askpass.env(server);
		const child = spawnSupervised(
			{ file: sshTool("ssh"), args: ["-F", config, ...args], shell: false },
			{ ...process.env, ...askpass.env },
		);
		return { child, release: askpass.release };
	}

	async #forward(target: SshTarget, remotePort: number, localPort?: number): Promise<void> {
		const existing = [...this.#forwards.values()].find(
			entry => entry.forward.server === target.name && entry.forward.remotePort === remotePort,
		);
		if (existing) {
			existing.forward = { ...existing.forward, target };
			existing.active = true;
			existing.droppedAt = null;
			existing.attempt = 0;
			if (!existing.child && !existing.timer) void this.#connect(existing);
			await this.#save();
			return;
		}
		const runtime: ForwardRuntime = {
			forward: {
				id: randomBytes(8).toString("hex"),
				server: target.name,
				target,
				localPort: await freePort(localPort ?? remotePort),
				remotePort,
				status: { kind: "connecting" },
			},
			active: true,
			child: null,
			attempt: 0,
			droppedAt: null,
			timer: null,
		};
		this.#forwards.set(runtime.forward.id, runtime);
		await this.#save();
		void this.#connect(runtime);
	}

	#status(runtime: ForwardRuntime, status: SshForward["status"]): void {
		runtime.forward = { ...runtime.forward, status };
		this.#changed();
	}

	#halt(runtime: ForwardRuntime): void {
		clearTimeout(runtime.timer ?? undefined);
		runtime.timer = null;
		const child = runtime.child;
		runtime.child = null;
		child?.stdin?.end();
	}

	async #connect(runtime: ForwardRuntime): Promise<void> {
		const { forward } = runtime;
		runtime.timer = null;
		this.#status(runtime, { kind: "connecting" });
		// The saved local port may have been taken while it was down.
		if (!(await freePort(forward.localPort).then(port => port === forward.localPort))) {
			runtime.active = false;
			this.#status(runtime, { kind: "stopped", error: `Local port ${forward.localPort} is in use` });
			await this.#save();
			return;
		}
		const { child, release } = await this.#spawn(forward.server, [
			"-N",
			"-o",
			"ExitOnForwardFailure=yes",
			"-L",
			`127.0.0.1:${forward.localPort}:127.0.0.1:${forward.remotePort}`,
			...targetArgs(forward.target),
		]);
		runtime.child = child;
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", chunk => {
			stderr = (stderr + chunk).slice(-STDERR_KEEP);
		});
		child.stdout?.resume();
		const probe = setInterval(() => {
			if (runtime.child !== child) return clearInterval(probe);
			void accepts(forward.localPort).then(open => {
				if (!open || runtime.child !== child || runtime.forward.status.kind === "up") return;
				clearInterval(probe);
				runtime.attempt = 0;
				runtime.droppedAt = null;
				this.#status(runtime, { kind: "up" });
			});
		}, PROBE_MS);
		child.on("close", () => {
			clearInterval(probe);
			release();
			if (runtime.child !== child) return;
			runtime.child = null;
			if (!runtime.active) return;
			const failure = classifyFailure(stderr);
			if (failure.kind === "hostKeyChanged") {
				runtime.active = false;
				this.#status(runtime, { kind: "hostKeyChanged", detail: failure.message });
				void this.#save();
				return;
			}
			if (failure.kind === "refused") {
				runtime.active = false;
				this.#status(runtime, { kind: "stopped", error: failure.message });
				void this.#save();
				return;
			}
			const now = Date.now();
			runtime.droppedAt ??= now;
			if (now - runtime.droppedAt >= this.#graceMs) {
				runtime.active = false;
				this.#status(runtime, { kind: "stopped", error: failure.message });
				void this.#save();
				return;
			}
			const delay = RETRY_DELAYS_MS[Math.min(runtime.attempt, RETRY_DELAYS_MS.length - 1)] ?? 60_000;
			runtime.attempt += 1;
			this.#status(runtime, { kind: "retrying", at: now + delay, attempt: runtime.attempt, error: failure.message });
			runtime.timer = setTimeout(() => void this.#connect(runtime), delay);
		});
	}

	async #watch(target: SshTarget): Promise<void> {
		await this.#unwatch(target.name);
		const loop = `while :; do (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null); echo ${WATCH_MARKER}; sleep ${SSH_PORT_POLL_SECONDS}; done`;
		const { child, release } = await this.#spawn(target.name, [...targetArgs(target), "sh", "-c", `'${loop}'`]);
		const runtime: WatchRuntime = {
			watch: { server: target.name, ports: [], opened: [], error: null, loading: true },
			target,
			child,
			initial: null,
			stopped: false,
		};
		this.#watches.set(target.name, runtime);
		let buffer = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", chunk => {
			buffer += chunk;
			let end = buffer.indexOf(WATCH_MARKER);
			while (end >= 0) {
				const ports = parseListeningPorts(buffer.slice(0, end));
				buffer = buffer.slice(end + WATCH_MARKER.length);
				end = buffer.indexOf(WATCH_MARKER);
				const shown = runtime.watch;
				// Most listings repeat the last one: nothing to tell any window.
				if (
					!shown.loading &&
					shown.error === null &&
					shown.ports.length === ports.length &&
					shown.ports.every((port, index) => port === ports[index])
				)
					continue;
				runtime.initial ??= ports;
				const initial = runtime.initial;
				runtime.watch = {
					...shown,
					ports,
					opened: ports.filter(port => !initial.includes(port)),
					loading: false,
					error: null,
				};
				this.#changed();
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", chunk => {
			stderr = (stderr + chunk).slice(-STDERR_KEEP);
		});
		child.on("close", () => {
			release();
			if (runtime.stopped || this.#watches.get(target.name) !== runtime) return;
			runtime.watch = { ...runtime.watch, loading: false, error: classifyFailure(stderr).message };
			this.#changed();
		});
	}

	async #unwatch(server: string): Promise<void> {
		const runtime = this.#watches.get(server);
		if (!runtime) return;
		runtime.stopped = true;
		this.#watches.delete(server);
		runtime.child.stdin?.end();
	}

	/** C147: drop the target's and every hop's saved key from OMPdesk's known_hosts. */
	async #forgetHostKey(target: SshTarget): Promise<void> {
		const { config, knownHosts } = await this.#sshConfig();
		const resolved = await run(sshTool("ssh"), ["-F", config, "-G", ...targetArgs(target)]);
		const { hostname, port, jumps } = knownHostNames(resolved.stdout);
		const names = [hostname ?? target.host, ...jumps].flatMap(entry => {
			const [host, hopPort] = entry.includes(":") && !entry.startsWith("[") ? entry.split(":") : [entry, undefined];
			const effective = entry === (hostname ?? target.host) ? port : Number(hopPort ?? 22);
			return effective === 22 ? [host ?? entry] : [`[${host}]:${effective}`];
		});
		for (const name of names) await run(sshTool("ssh-keygen"), ["-R", name, "-f", knownHosts]);
		for (const runtime of this.#forwards.values())
			if (runtime.forward.server === target.name && runtime.forward.status.kind === "hostKeyChanged")
				this.#status(runtime, { kind: "stopped", error: null });
	}
}
