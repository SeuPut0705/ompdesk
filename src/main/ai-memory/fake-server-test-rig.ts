/**
 * A stand-in for the memory server on 127.0.0.1, for tests that drive `AiMemoryClient` through the real core: the
 * core's HTTP client dials it as it dials the server. A test answers each request with a `Response`, as it answered
 * `fetch` when the client ran in main; a handler that throws ends the connection without an answer, which the client
 * reads as a server that is not running.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
	method: string;
	headers: Headers;
	/** The request's body as text; absent on a request without one. */
	body?: string;
}

export interface FakeMemoryServer {
	/** `http://127.0.0.1:<port>`. */
	url: string;
	close(): Promise<void>;
}

/**
 * Starts the server. `answer` gets each request's URL as `<shown><path and query>`, `shown` being the address the
 * test's routes are written against (the server's own when omitted).
 */
export async function fakeMemoryServer(
	answer: (url: string, request: FakeRequest) => Response | Promise<Response>,
	shown?: string,
): Promise<FakeMemoryServer> {
	const server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", async () => {
			try {
				const headers = new Headers();
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				}
				const body = Buffer.concat(chunks).toString("utf8");
				const response = await answer(`${shown ?? url}${incoming.url ?? ""}`, {
					method: incoming.method ?? "GET",
					headers,
					...(body ? { body } : {}),
				});
				const bytes = Buffer.from(await response.arrayBuffer());
				outgoing.writeHead(response.status, {
					"content-type": response.headers.get("content-type") ?? "text/plain",
					"content-length": bytes.byteLength,
				});
				outgoing.end(bytes);
			} catch {
				incoming.socket.destroy();
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url,
		close: () => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			server.closeAllConnections();
			return closed.promise;
		},
	};
}
