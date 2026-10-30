/**
 * A test's MCP hub: ./mcp-hub-entry.ts under Bun, and a client that speaks streamable HTTP to it the way stock omp's
 * http transport does (POST per message, `Mcp-Session-Id` from `initialize`, one GET event stream per session).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface RpcReply {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface TestHub {
	child: ChildProcessWithoutNullStreams;
	url: string;
	secret: string;
	stderr: () => string;
	post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
	stop(): Promise<void>;
}

const hubs: TestHub[] = [];

export async function startTestHub(env: Record<string, string> = {}): Promise<TestHub> {
	const secret = crypto.randomUUID();
	const child = spawn("bun", [fileURLToPath(new URL("./mcp-hub-entry.ts", import.meta.url))], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, HUB_TEST_SECRET: secret, ...env },
	});
	let errors = "";
	child.stderr.on("data", chunk => {
		errors += chunk;
	});
	const exited = once(child, "exit");
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	createInterface({ input: child.stdout }).on("line", line => {
		const match = /http:\/\/127\.0\.0\.1:\d+/.exec(line);
		if (match) resolve(match[0]);
	});
	void exited.then(() => reject(new Error(`hub exited before listening\n${errors}`)));
	const url = await promise;
	const hub: TestHub = {
		child,
		url,
		secret,
		stderr: () => errors,
		post: (path, body, headers = {}) =>
			fetch(`${url}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${secret}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...headers,
				},
				body: JSON.stringify(body),
			}),
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.stdin.end();
			await exited;
		},
	};
	hubs.push(hub);
	return hub;
}

export async function stopTestHubs(): Promise<void> {
	await Promise.all(hubs.splice(0).map(hub => hub.stop()));
}

/** One omp's session on the hub's `/rea` route. */
export interface ReaClient {
	request(method: string, params?: unknown): Promise<RpcReply>;
	/** A request (its reply joins what `wait` sees), a notification or an answer to REA's request. */
	send(message: RpcReply): void;
	wait(predicate: (message: RpcReply) => boolean): Promise<RpcReply>;
	/** Settles when the hub ends the session's event stream (REA is gone). */
	ended: Promise<void>;
	/** Closes the session the way omp's transport does (DELETE). */
	close(): Promise<void>;
	/** Drops the event stream without a DELETE, as a killed omp does. */
	drop(): void;
}

export function reaClient(hub: TestHub, cwd?: string): ReaClient {
	const received: RpcReply[] = [];
	const waiters: { predicate: (message: RpcReply) => boolean; resolve: (message: RpcReply) => void }[] = [];
	const deliver = (message: RpcReply) => {
		const index = waiters.findIndex(waiter => waiter.predicate(message));
		if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
		else received.push(message);
	};
	const wait = (predicate: (message: RpcReply) => boolean) => {
		const index = received.findIndex(predicate);
		if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
		const result = Promise.withResolvers<RpcReply>();
		waiters.push({ predicate, resolve: result.resolve });
		return result.promise;
	};
	const ended = Promise.withResolvers<void>();
	const stream = new AbortController();
	let session: string | undefined;
	let opened = false;
	const path = cwd === undefined ? "/rea" : `/rea?cwd=${encodeURIComponent(cwd)}`;
	const openStream = async (id: string) => {
		const response = await fetch(`${hub.url}/rea`, {
			headers: { authorization: `Bearer ${hub.secret}`, accept: "text/event-stream", "mcp-session-id": id },
			signal: stream.signal,
		});
		const reader = response.body?.getReader();
		if (!reader) return;
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let end = buffer.indexOf("\n\n");
			while (end >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const data = frame
					.split("\n")
					.filter(line => line.startsWith("data:"))
					.map(line => line.slice(5))
					.join("\n");
				if (data) deliver(JSON.parse(data) as RpcReply);
				end = buffer.indexOf("\n\n");
			}
		}
		ended.resolve();
	};
	const postMessage = async (message: RpcReply): Promise<Response> => {
		const response = await hub.post(session ? "/rea" : path, message, session ? { "mcp-session-id": session } : {});
		const id = response.headers.get("mcp-session-id");
		if (id && !session) session = id;
		if (session && !opened) {
			opened = true;
			openStream(session).catch(() => ended.resolve());
		}
		return response;
	};
	let next = 0;
	const send = (message: RpcReply) => {
		void postMessage({ jsonrpc: "2.0", ...message })
			.then(async response => {
				if (response.headers.get("content-type")?.includes("application/json"))
					deliver((await response.json()) as RpcReply);
			})
			// A hub that went away mid-test (its stop, a dropped session): the test asserts on what it saw.
			.catch(() => undefined);
	};
	const request = async (method: string, params: unknown = {}) => {
		const id = ++next;
		const response = await postMessage({ jsonrpc: "2.0", id, method, params });
		return (await response.json()) as RpcReply;
	};
	return {
		request,
		send,
		wait,
		ended: ended.promise,
		async close() {
			if (session)
				await fetch(`${hub.url}/rea`, {
					method: "DELETE",
					headers: { authorization: `Bearer ${hub.secret}`, "mcp-session-id": session },
				});
			stream.abort();
		},
		drop: () => stream.abort(),
	};
}
