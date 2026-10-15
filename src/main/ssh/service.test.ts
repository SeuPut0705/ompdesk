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
			expect(text).toContain(`UserKnownHostsFile "${knownHosts}"`);
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
	let prompts: SshPrompt[];
	const target = { name: "box", host: "box.example" };
	const create = () =>
		new SshTools({
			userData: path.join(root, "user"),
			broadcast: (kind, data) => {
				if (kind === "state") state = data as SshToolsState;
				else prompts = data as SshPrompt[];
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
		await fs.writeFile(path.join(fake, "ports"), "22 3000 5173");
		await vi.waitFor(() => expect(state.watches[0]?.opened).toEqual([5173]), { timeout: 10_000 });
		await tools.command({ action: "watch", target, on: false });
		expect(state.watches).toEqual([]);

		expect(await tools.agent()).toMatchObject({
			agent: "available",
			agentKeys: ["256 SHA256:agentKeyFingerprint fake@laptop (ED25519)"],
		});
	}, 30_000);
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
});
