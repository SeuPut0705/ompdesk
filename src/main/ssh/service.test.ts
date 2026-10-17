import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshPrompt, SshToolsState } from "../../shared/ssh-tools";
import { AskpassServer } from "./askpass";
import { classifyFailure, classifyPrompt, parseListeningPorts, writeSshConfig } from "./options";
import { SshTools } from "./service";
import { writeFakeSsh } from "./test-fake-ssh";

describe("ssh options", () => {
	it("reads listening ports from ss, netstat and lsof", () => {
		expect(parseListeningPorts("LISTEN 0 4096 127.0.0.1:631 0.0.0.0:*\nLISTEN 0 511 [::]:3000 [::]:*\n")).toEqual([
			631, 3000,
		]);
		expect(
			parseListeningPorts(
				"Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address Foreign Address State\ntcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN\n",
			),
		).toEqual([22]);
		expect(
			parseListeningPorts(
				"COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 812 me 23u IPv6 0x1 0t0 TCP *:5173 (LISTEN)\n",
			),
		).toEqual([5173]);
	});

	it("tells host keys, passwords, passphrases and codes apart", () => {
		expect(
			classifyPrompt(
				"The authenticity of host 'jump.example (10.0.0.1)' can't be established.\nED25519 key fingerprint is SHA256:abc+/=.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?",
			),
		).toEqual({ kind: "hostKey", fingerprint: "SHA256:abc+/=", host: "jump.example (10.0.0.1)" });
		expect(classifyPrompt("Enter passphrase for key '/u/.ssh/id_ed25519': ").kind).toBe("passphrase");
		expect(classifyPrompt("me@box's password: ").kind).toBe("password");
		expect(classifyPrompt("Verification code: ").kind).toBe("code");
	});

	it("never retries a changed host key or a refused login", () => {
		expect(classifyFailure("@@@\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nfoo").kind).toBe(
			"hostKeyChanged",
		);
		expect(classifyFailure("me@box: Permission denied (publickey).").kind).toBe("refused");
		expect(classifyFailure("Connection to box closed by remote host.")).toEqual({
			kind: "dropped",
			message: "Connection to box closed by remote host.",
		});
	});

	it("pins OMPdesk's known_hosts before the user's config", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-config-"));
		try {
			const { config, knownHosts } = await writeSshConfig(dir, "/home/me");
			const text = await fs.readFile(config, "utf8");
			expect(text.indexOf("StrictHostKeyChecking ask")).toBeLessThan(text.indexOf("Include"));
			// ssh_config reads backslashes as escapes, so Windows paths are written with forward slashes.
			expect(text).toContain(`UserKnownHostsFile "${knownHosts.replace(/\\/g, "/")}"`);
			expect(text).toContain('Include "/home/me/.ssh/config"');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("SshTools", () => {
	let root: string;
	let fake: string;
	let http: Server;
	let remotePort: number;
	let tools: SshTools;
	let state: SshToolsState;
	let stateBroadcasts = 0;
	let prompts: SshPrompt[];
	const target = { name: "box", host: "box.example" };
	const create = () =>
		new SshTools({
			userData: path.join(root, "user"),
			broadcast: (kind, data) => {
				if (kind === "state") {
					state = data as SshToolsState;
					stateBroadcasts++;
				} else prompts = data as SshPrompt[];
			},
		});
	const answerNext = async (kind: SshPrompt["kind"], value: string | null) => {
		await vi.waitFor(() => expect(prompts.map(prompt => prompt.kind)).toContain(kind), { timeout: 10_000 });
		const prompt = prompts.find(entry => entry.kind === kind);
		await tools.command({ action: "answer", id: prompt?.id ?? "", value });
		return prompt;
	};
	const status = () => state.forwards[0]?.status.kind;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-tools-"));
		fake = path.join(root, "bin");
		vi.stubEnv("OMP_GUI_SSH", await writeFakeSsh(fake));
		http = createServer((_request, response) => response.end("from the server"));
		const listening = Promise.withResolvers<void>();
		http.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		remotePort = (http.address() as net.AddressInfo).port;
		prompts = [];
		tools = create();
	});
	afterEach(async () => {
		tools.dispose();
		http.close();
		vi.unstubAllEnvs();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("asks the host key and password, forwards, reconnects after a drop, and restores at launch", async () => {
		await fs.writeFile(path.join(fake, "password"), "hunter2");
		await tools.command({ action: "forward", target, remotePort });
		const hostKey = await answerNext("hostKey", "yes");
		expect(hostKey).toMatchObject({
			server: "box",
			fingerprint: "SHA256:fakeFingerprint123",
			host: "box.example (127.0.0.1)",
		});
		await answerNext("password", "hunter2");
		await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });
		const local = state.forwards[0]?.localPort ?? 0;
		expect(await (await fetch(`http://127.0.0.1:${local}/`)).text()).toBe("from the server");
		// The accepted key went to OMPdesk's own known_hosts.
		expect(await fs.readFile(path.join(root, "user", "ssh", "known_hosts"), "utf8")).toContain(
			"box.example ssh-ed25519",
		);

		// C152: a drop retries on its own; Reconnect now skips the wait.
		await fs.writeFile(path.join(fake, "drop"), "");
		await vi.waitFor(() => expect(status()).toBe("retrying"), { timeout: 10_000 });
		const retrying = state.forwards[0]?.status;
		expect(retrying).toMatchObject({
			kind: "retrying",
			attempt: 1,
			error: "Connection to box.example closed by remote host.",
		});
		await fs.rm(path.join(fake, "drop"));
		await tools.command({ action: "reconnect", id: state.forwards[0]?.id ?? "" });
		await answerNext("password", "hunter2");
		await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });

		// C151: saved and started again by the next launch.
		tools.dispose();
		// The supervisor stops the old ssh a moment after its stdin closes, as a quit does.
		await vi.waitFor(
			async () => {
				const { promise, resolve } = Promise.withResolvers<boolean>();
				const probe = net.connect(local, "127.0.0.1");
				probe.once("connect", () => {
					probe.destroy();
					resolve(true);
				});
				probe.once("error", () => resolve(false));
				expect(await promise).toBe(false);
			},
			{ timeout: 10_000 },
		);
		prompts = [];
		tools = create();
		await tools.start();
		await answerNext("password", "hunter2");
		await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });
		expect(state.forwards[0]?.localPort).toBe(local);
	}, 40_000);

	it("stops on a refused login and blocks a changed host key until it is forgotten", async () => {
		await fs.writeFile(path.join(fake, "password"), "right");
		await tools.command({ action: "forward", target, remotePort });
		await answerNext("hostKey", "yes");
		await answerNext("password", "wrong");
		await vi.waitFor(
			() =>
				expect(state.forwards[0]?.status).toEqual({
					kind: "stopped",
					error: expect.stringContaining("Permission denied"),
				}),
			{
				timeout: 10_000,
			},
		);

		await fs.writeFile(path.join(fake, "changed"), "");
		await tools.command({ action: "reconnect", id: state.forwards[0]?.id ?? "" });
		await vi.waitFor(() => expect(status()).toBe("hostKeyChanged"), { timeout: 10_000 });
		await tools.command({ action: "forgetHostKey", target });
		expect(status()).toBe("stopped");
		expect(await fs.readFile(path.join(root, "user", "ssh", "known_hosts"), "utf8")).not.toContain("box.example");
		// A cancelled host-key question never connects.
		await fs.rm(path.join(fake, "changed"));
		await tools.command({ action: "reconnect", id: state.forwards[0]?.id ?? "" });
		await answerNext("hostKey", null);
		await vi.waitFor(() => expect(state.forwards[0]?.status).toMatchObject({ kind: "stopped" }), { timeout: 10_000 });
	}, 40_000);

	it("watches the server's ports and names the newly opened ones; reports the agent's keys", async () => {
		await fs.writeFile(path.join(fake, "ports"), "22 3000");
		await tools.command({ action: "watch", target, on: true });
		await answerNext("hostKey", "yes");
		await vi.waitFor(
			() => expect(state.watches[0]).toMatchObject({ ports: [22, 3000], opened: [], loading: false }),
			{
				timeout: 10_000,
			},
		);
		// Repeated listings of the same ports tell no window anything.
		const listings = async () => (await fs.readFile(path.join(fake, "listings"), "utf8")).length;
		const broadcasts = stateBroadcasts;
		const seen = await listings();
		await vi.waitFor(async () => expect(await listings()).toBeGreaterThanOrEqual(seen + 3), { timeout: 10_000 });
		expect(stateBroadcasts).toBe(broadcasts);
		await fs.writeFile(path.join(fake, "ports"), "22 3000 5173");
		await vi.waitFor(() => expect(state.watches[0]?.opened).toEqual([5173]), { timeout: 10_000 });
		await tools.command({ action: "watch", target, on: false });
		expect(state.watches).toEqual([]);

		expect(await tools.agent()).toMatchObject({
			agent: "available",
			agentKeys: ["256 SHA256:agentKeyFingerprint fake@laptop (ED25519)"],
		});
	}, 30_000);

	describe("re-entrancy", () => {
		const portOpen = (port: number) => {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			const probe = net.connect(port, "127.0.0.1");
			probe.once("connect", () => {
				probe.destroy();
				resolve(true);
			});
			probe.once("error", () => resolve(false));
			return promise;
		};
		// A negative claim ("no ssh ever starts", "no loop keeps running") is checked once `settled()` says no
		// connect is in flight and every ended ssh has closed: nothing is left that could still start one.
		const forwardCalls = async () =>
			(await fs.readFile(path.join(fake, "calls"), "utf8").catch(() => ""))
				.split("\n")
				.filter(line => line.includes('"-L"')).length;
		const listings = async () => (await fs.readFile(path.join(fake, "listings"), "utf8").catch(() => "")).length;
		/** The host key is known, so no question blocks these tests. */
		const trustHost = async () => {
			await fs.mkdir(path.join(root, "user", "ssh"), { recursive: true });
			await fs.writeFile(path.join(root, "user", "ssh", "known_hosts"), "box.example ssh-ed25519 AAAAfake\n");
		};

		it("spawns one ssh when the launch restore and a user command connect the same forward", async () => {
			await trustHost();
			const probe = net.createServer();
			const bound = Promise.withResolvers<void>();
			probe.listen(0, "127.0.0.1", () => bound.resolve());
			await bound.promise;
			const localPort = (probe.address() as net.AddressInfo).port;
			await new Promise<void>(resolve => probe.close(() => resolve()));
			const store = path.join(root, "user", "ssh-forwards.json");
			await fs.writeFile(
				store,
				JSON.stringify({
					graceMs: 3_600_000,
					forwards: [{ id: "saved", server: "box", target, localPort, remotePort, active: true }],
				}),
			);
			await tools.start();
			await tools.command({ action: "forward", target, remotePort });
			await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });
			await tools.settled();
			expect(await forwardCalls()).toBe(1);
			expect(state.forwards).toHaveLength(1);
			// A second connect must not mark the forward stopped ("port in use" by its own ssh).
			const saved = JSON.parse(await fs.readFile(store, "utf8")) as { forwards: { active: boolean }[] };
			expect(saved.forwards[0]?.active).toBe(true);
		}, 20_000);

		it("does not start ssh when the forward is removed while it connects", async () => {
			await trustHost();
			const started = await tools.command({ action: "forward", target, remotePort });
			const forward = started.forwards[0];
			await tools.command({ action: "remove", id: forward?.id ?? "" });
			await tools.settled();
			expect(state.forwards).toEqual([]);
			expect(await portOpen(forward?.localPort ?? 0)).toBe(false);
			expect(await forwardCalls()).toBe(0);
		}, 20_000);

		it("does not start ssh when the forward is stopped while it connects", async () => {
			await trustHost();
			const started = await tools.command({ action: "forward", target, remotePort });
			const forward = started.forwards[0];
			await tools.command({ action: "stop", id: forward?.id ?? "" });
			await tools.settled();
			expect(state.forwards[0]?.status).toEqual({ kind: "stopped", error: null });
			expect(await portOpen(forward?.localPort ?? 0)).toBe(false);
			expect(await forwardCalls()).toBe(0);
		}, 20_000);

		it("dispose stops a forward that is still connecting", async () => {
			await trustHost();
			const started = await tools.command({ action: "forward", target, remotePort });
			tools.dispose();
			await tools.settled();
			expect(await portOpen(started.forwards[0]?.localPort ?? 0)).toBe(false);
			expect(await forwardCalls()).toBe(0);
		}, 20_000);

		it("reconnects a running forward without finding its own port busy", async () => {
			await trustHost();
			await tools.command({ action: "forward", target, remotePort });
			await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });
			await tools.command({ action: "reconnect", id: state.forwards[0]?.id ?? "" });
			await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });
			expect(await forwardCalls()).toBe(2);
		}, 20_000);

		it("leaves no remote loop behind when a watch is toggled on and off at once", async () => {
			await trustHost();
			await fs.writeFile(path.join(fake, "ports"), "22");
			await Promise.all([
				tools.command({ action: "watch", target, on: true }),
				tools.command({ action: "watch", target, on: false }),
			]);
			expect(state.watches).toEqual([]);
			await tools.settled();
			// The fake ssh's loop writes a listing as it starts; with every ssh closed none can follow.
			const before = await listings();
			await tools.settled();
			expect(await listings()).toBe(before);
			expect(state.watches).toEqual([]);
		}, 20_000);

		it("reports a failed start instead of an unhandled rejection, and starts again once it can", async () => {
			await trustHost();
			// A file where the ssh config folder belongs: writing the config fails.
			await fs.rm(path.join(root, "user", "ssh"), { recursive: true });
			await fs.writeFile(path.join(root, "user", "ssh"), "in the way");
			await tools.command({ action: "forward", target, remotePort });
			await vi.waitFor(() => expect(state.forwards[0]?.status.kind).toBe("stopped"), { timeout: 10_000 });
			expect(state.forwards[0]?.status).toMatchObject({ error: expect.any(String) });
			await fs.rm(path.join(root, "user", "ssh"));
			await trustHost();
			await tools.command({ action: "reconnect", id: state.forwards[0]?.id ?? "" });
			await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });
		}, 20_000);

		it("saves concurrent changes without losing the file, and keeps a corrupt store aside", async () => {
			const store = path.join(root, "user", "ssh-forwards.json");
			await fs.mkdir(path.dirname(store), { recursive: true });
			await fs.writeFile(store, "{ not json");
			await Promise.all(
				[60_000, 120_000, 180_000, 240_000, 300_000].map(ms => tools.command({ action: "setGrace", ms })),
			);
			expect(await fs.readFile(`${store}.corrupt`, "utf8")).toBe("{ not json");
			expect(JSON.parse(await fs.readFile(store, "utf8"))).toMatchObject({ forwards: [] });
			expect((await fs.readdir(path.dirname(store))).filter(name => name.includes(".tmp"))).toEqual([]);
		}, 20_000);
	});
});

describe.skipIf(process.platform === "win32")("askpass", () => {
	it("answers only its own processes' tokens", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-askpass-"));
		const server = new AskpassServer(dir, () => {});
		try {
			const { env } = await server.env("box");
			const socket = net.connect(env.OMPDESK_ASKPASS_SOCKET ?? "");
			let reply = "";
			socket.on("data", chunk => {
				reply += chunk;
			});
			const closed = Promise.withResolvers<void>();
			socket.on("close", () => closed.resolve());
			socket.write(`${JSON.stringify({ token: "forged", prompt: "password:" })}\n`);
			await closed.promise;
			expect(JSON.parse(reply)).toEqual({ cancel: true });
			expect(server.list()).toEqual([]);
		} finally {
			server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("release cancels only the prompts of its own token, not another process's on the same server", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-askpass-"));
		const seen: SshPrompt[][] = [];
		const server = new AskpassServer(dir, prompts => seen.push(prompts));
		const ask = (env: NodeJS.ProcessEnv, prompt: string) => {
			const socket = net.connect(env.OMPDESK_ASKPASS_SOCKET ?? "");
			let reply = "";
			socket.on("data", chunk => {
				reply += chunk;
			});
			const closed = Promise.withResolvers<string>();
			socket.on("close", () => closed.resolve(reply));
			socket.write(`${JSON.stringify({ token: env.OMPDESK_ASKPASS_TOKEN, prompt })}\n`);
			return { socket, closed: closed.promise };
		};
		try {
			const forward = await server.env("box");
			const watch = await server.env("box");
			const watchAsk = ask(watch.env, "box's password: ");
			const forwardAsk = ask(forward.env, "Enter passphrase for key: ");
			await vi.waitFor(() => expect(server.list()).toHaveLength(2));
			// The watch ends: its question goes, the forward's stays open on the same server.
			watch.release();
			expect(JSON.parse(await watchAsk.closed)).toEqual({ cancel: true });
			expect(server.list().map(prompt => prompt.kind)).toEqual(["passphrase"]);
			const [pending] = server.list();
			server.answer(pending?.id ?? "", "secret");
			expect(JSON.parse(await forwardAsk.closed)).toEqual({ value: "secret" });
		} finally {
			server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
