import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshPrompt, SshToolsState } from "../../shared/ssh-tools";
import { SshCore } from "./client";
import { SshTools } from "./service";
import { writeFakeSsh } from "./test-fake-ssh";

// Main's SSH tools against the real core process and a stand-in ssh (`test-fake-ssh.ts`), on every platform. The
// rules that moved to the core are tested there with rows captured from the TypeScript (`ssh/rules.rs`: listening
// ports, questions, failures, saved host names, arguments, the config), as are the askpass listener's own cases
// (`ssh/askpass.rs`: a forged token, a release that cancels only its own process's questions).

describe("SshTools", () => {
	let root: string;
	let fake: string;
	let http: Server;
	let remotePort: number;
	let tools: SshTools;
	let state: SshToolsState;
	let stateBroadcasts = 0;
	let prompts: SshPrompt[];
	/** Everything sent to the windows, as text. */
	let broadcasts: string[];
	const target = { name: "box", host: "box.example" };
	const create = () =>
		new SshTools({
			userData: path.join(root, "user"),
			broadcast: (kind, data) => {
				broadcasts.push(JSON.stringify(data));
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
		broadcasts = [];
		tools = create();
	});
	afterEach(async () => {
		tools.dispose();
		// Every ssh has exited: on Windows a running one holds the folder.
		await tools.settled();
		http.close();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
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
		// Repeated listings of the same ports tell no window anything. The fake records a listing before it writes
		// it, so the fourth record from here means three more listings were written.
		const listings = async () => (await fs.readFile(path.join(fake, "listings"), "utf8")).length;
		const broadcasts = stateBroadcasts;
		const seen = await listings();
		await vi.waitFor(async () => expect(await listings()).toBeGreaterThanOrEqual(seen + 4), { timeout: 10_000 });
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

	it("reports nothing of a password or a passphrase: no status, no prompt, no error, no line the core logs", async () => {
		const password = "hunter2-on-the-wire";
		const passphrase = "correct horse battery";
		const logged = vi.spyOn(console, "warn");
		await fs.writeFile(path.join(fake, "passphrase"), passphrase);
		await fs.writeFile(path.join(fake, "password"), password);
		// A stand-in that prints what it was answered, which real ssh never does.
		await fs.writeFile(path.join(fake, "leak"), "");
		await tools.command({ action: "forward", target, remotePort });
		await answerNext("hostKey", "yes");
		await answerNext("passphrase", passphrase);
		await answerNext("password", password);
		await vi.waitFor(
			() =>
				expect(state.forwards[0]?.status).toEqual({
					kind: "stopped",
					error: "me@box.example: Permission denied (***,***).",
				}),
			{ timeout: 10_000 },
		);
		await tools.command({ action: "watch", target, on: true });
		await answerNext("passphrase", passphrase);
		await answerNext("password", password);
		await vi.waitFor(() => expect(state.watches[0]?.error).toBe("me@box.example: Permission denied (***,***)."), {
			timeout: 10_000,
		});
		// An answer that is refused, here and in the core, is not repeated either.
		const refusals = await Promise.all([
			tools.command({ action: "answer", id: "none", value: `${password} `.repeat(300) }).then(String, String),
			tools.command({ action: "answer", id: 5, value: passphrase }).then(String, String),
		]);
		expect(refusals[0]).toBe("CoreError: Invalid SSH tools request");
		const said = [...broadcasts, ...refusals, ...logged.mock.calls.flat().map(String)];
		expect(broadcasts.length).toBeGreaterThan(6);
		for (const text of said) {
			for (const secret of [password, passphrase, password.slice(0, 7), passphrase.slice(8)])
				expect(text).not.toContain(secret);
		}
	}, 40_000);

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

		it("asks again for the local port its own closed ssh may still hold, instead of stopping as taken", async () => {
			await trustHost();
			await tools.command({ action: "forward", target, remotePort });
			await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });
			// The port reads taken twice (the closed ssh's listener not yet freed), then free.
			const real = SshCore.prototype.plan;
			let taken = 2;
			vi.spyOn(SshCore.prototype, "plan").mockImplementation(async function (
				this: SshCore,
				...args: Parameters<SshCore["plan"]>
			) {
				return taken-- > 0 ? args[2] + 1 : real.apply(this, args);
			});
			await tools.command({ action: "reconnect", id: state.forwards[0]?.id ?? "" });
			await vi.waitFor(() => expect(status()).toBe("up"), { timeout: 10_000 });
			expect(taken).toBe(-1);
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

describe("SshTools key actions", () => {
	let root: string;
	let tools: SshTools;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-keys-"));
		// A temp home (HOME on POSIX, USERPROFILE on Windows): never the real ~/.ssh.
		vi.stubEnv("HOME", root);
		vi.stubEnv("USERPROFILE", root);
		vi.stubEnv("OMP_GUI_SSH", await writeFakeSsh(path.join(root, "bin")));
		tools = new SshTools({ userData: path.join(root, "user"), broadcast: () => {} });
	});
	afterEach(async () => {
		tools.dispose();
		vi.unstubAllEnvs();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("createKey makes ~/.ssh/id_ed25519 once and never overwrites an existing key", async () => {
		await tools.command({ action: "createKey" });
		const key = path.join(root, ".ssh", "id_ed25519");
		expect(await fs.readFile(key, "utf8")).toBe("PRIVATE\n");
		expect((await tools.agent()).keyFiles).toEqual(["id_ed25519.pub"]);
		await fs.writeFile(key, "MINE\n");
		await tools.command({ action: "createKey" });
		expect(await fs.readFile(key, "utf8")).toBe("MINE\n");
	});

	it("loadKeys hands each private key that has a .pub to ssh-add, and skips a lone .pub", async () => {
		const dir = path.join(root, ".ssh");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "id_ed25519"), "k");
		await fs.writeFile(path.join(dir, "id_ed25519.pub"), "p");
		await fs.writeFile(path.join(dir, "orphan.pub"), "p");
		await tools.command({ action: "loadKeys" });
		const added = (await fs.readFile(path.join(root, "bin", "added"), "utf8")).trim().split("\n");
		expect(added).toHaveLength(1);
		expect(added[0]).toContain(path.join(dir, "id_ed25519"));
	});
});
