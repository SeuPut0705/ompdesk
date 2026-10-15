/**
 * C148: OMPdesk's ssh processes ask their questions (password, key
 * passphrase, one-time code, an unknown host key) through `SSH_ASKPASS`. The
 * helper is a tiny Node script run by the app's own binary
 * (`ELECTRON_RUN_AS_NODE`); it sends the question with its process's random
 * token over a local socket, main shows it in the window and prints the answer
 * back to ssh. Answers live only in that exchange; an unanswered question is
 * cancelled after `SSH_PROMPT_TIMEOUT_MS`.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SSH_PROMPT_TIMEOUT_MS, type SshPrompt } from "../../shared/ssh-tools";
import { classifyPrompt } from "./options";

const HELPER_SOURCE = `
const net = require("node:net");
const socket = net.connect(process.env.OMPDESK_ASKPASS_SOCKET);
let reply = "";
socket.on("connect", () => socket.write(JSON.stringify({ token: process.env.OMPDESK_ASKPASS_TOKEN, prompt: process.argv[2] || "" }) + "\\n"));
socket.on("data", chunk => { reply += chunk; });
socket.on("error", () => process.exit(1));
socket.on("close", () => {
	try {
		const answer = JSON.parse(reply);
		if (typeof answer.value !== "string") process.exit(1);
		process.stdout.write(answer.value + "\\n");
		process.exit(0);
	} catch { process.exit(1); }
});
`;

interface Pending {
	prompt: SshPrompt;
	/** The ssh process that asked; `release` cancels only its own questions. */
	token: string;
	finish: (value: string | null) => void;
}

export class AskpassServer {
	readonly #dir: string;
	readonly #onChange: (prompts: SshPrompt[]) => void;
	readonly #tokens = new Map<string, string>();
	readonly #pending = new Map<string, Pending>();
	#ready: Promise<{ socket: string; helper: string; script: string }> | null = null;
	#server: net.Server | null = null;

	constructor(dir: string, onChange: (prompts: SshPrompt[]) => void) {
		this.#dir = dir;
		this.#onChange = onChange;
	}

	#start(): Promise<{ socket: string; helper: string; script: string }> {
		if (this.#ready) return this.#ready;
		const ready = (async () => {
			await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
			const script = path.join(this.#dir, "askpass.js");
			await fs.writeFile(script, HELPER_SOURCE, { mode: 0o600 });
			const windows = process.platform === "win32";
			const helper = path.join(this.#dir, windows ? "askpass.cmd" : "askpass.sh");
			await fs.writeFile(
				helper,
				windows
					? '@set ELECTRON_RUN_AS_NODE=1\r\n@"%OMPDESK_ASKPASS_NODE%" "%OMPDESK_ASKPASS_SCRIPT%" %*\r\n'
					: '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$OMPDESK_ASKPASS_NODE" "$OMPDESK_ASKPASS_SCRIPT" "$@"\n',
				{ mode: 0o700 },
			);
			const name = `ompdesk-askpass-${randomBytes(6).toString("hex")}`;
			const socket = windows ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
			const server = net.createServer(connection => this.#accept(connection));
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(socket, () => listening.resolve());
			await listening.promise;
			if (!windows) await fs.chmod(socket, 0o600);
			this.#server = server;
			return { socket, helper, script };
		})();
		this.#ready = ready;
		// A failed start (disk full, folder in the way) must not be remembered for the whole session.
		ready.catch(() => {
			if (this.#ready === ready) this.#ready = null;
		});
		return ready;
	}

	/** Environment for one ssh process asking on behalf of `server`; `release` forgets its token. */
	async env(server: string): Promise<{ env: NodeJS.ProcessEnv; release: () => void }> {
		const { socket, helper, script } = await this.#start();
		const token = randomBytes(24).toString("hex");
		this.#tokens.set(token, server);
		return {
			env: {
				SSH_ASKPASS: helper,
				SSH_ASKPASS_REQUIRE: "force",
				DISPLAY: process.env.DISPLAY || "ompdesk:0",
				OMPDESK_ASKPASS_SOCKET: socket,
				OMPDESK_ASKPASS_TOKEN: token,
				OMPDESK_ASKPASS_NODE: process.execPath,
				OMPDESK_ASKPASS_SCRIPT: script,
			},
			release: () => {
				this.#tokens.delete(token);
				for (const [id, pending] of this.#pending) if (pending.token === token) this.answer(id, null);
			},
		};
	}

	list(): SshPrompt[] {
		return [...this.#pending.values()].map(entry => entry.prompt);
	}

	/** The user's answer (`null` = cancel); unknown or expired ids do nothing. */
	answer(id: string, value: string | null): void {
		this.#pending.get(id)?.finish(value);
	}

	close(): void {
		for (const id of [...this.#pending.keys()]) this.answer(id, null);
		this.#server?.close();
	}

	#accept(connection: net.Socket): void {
		let buffer = "";
		connection.setEncoding("utf8");
		connection.on("error", () => {});
		connection.on("data", chunk => {
			buffer += chunk;
			const end = buffer.indexOf("\n");
			if (end < 0) {
				if (buffer.length > 16_384) connection.destroy();
				return;
			}
			let request: { token?: unknown; prompt?: unknown };
			try {
				request = JSON.parse(buffer.slice(0, end)) as { token?: unknown; prompt?: unknown };
			} catch {
				connection.destroy();
				return;
			}
			const token = typeof request.token === "string" ? request.token : "";
			const server = this.#tokens.get(token);
			if (!server || typeof request.prompt !== "string") {
				connection.end(JSON.stringify({ cancel: true }));
				return;
			}
			const id = randomBytes(8).toString("hex");
			const text = request.prompt.slice(0, 4000);
			const prompt: SshPrompt = {
				id,
				server,
				text,
				...classifyPrompt(text),
				expiresAt: Date.now() + SSH_PROMPT_TIMEOUT_MS,
			};
			const timer = setTimeout(() => this.answer(id, null), SSH_PROMPT_TIMEOUT_MS);
			const finish = (value: string | null) => {
				if (!this.#pending.delete(id)) return;
				clearTimeout(timer);
				connection.end(JSON.stringify(value === null ? { cancel: true } : { value }));
				this.#onChange(this.list());
			};
			connection.on("close", () => finish(null));
			this.#pending.set(id, { prompt, token, finish });
			this.#onChange(this.list());
		});
	}
}
