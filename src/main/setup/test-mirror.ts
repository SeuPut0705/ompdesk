/**
 * A server on 127.0.0.1 that stands in for every host machine setup reaches (nodejs.org, api.github.com, github.com,
 * pkgs.tailscale.com, a PortableGit URL, …), for the tests that run the real core. The core reads `https://host/path`
 * from `<mirror>/host/path` when it is given the mirror's URL (`SetupServiceDeps.mirror`, `LookupOptions.mirror`,
 * `DownloadOptions.mirror`), so the tests never touch the network and still name the real addresses.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Answer =
	| string
	| Uint8Array
	| { status?: number; body?: string | Uint8Array; headers?: Record<string, string> }
	| ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>)
	| undefined;

export interface Mirror {
	/** What the core is given as `mirror`. */
	url: string;
	/** The real addresses asked for, in order: `https://nodejs.org/dist/index.json`. */
	asked: string[];
	/** Each request's headers, in the same order. */
	headers: IncomingMessage["headers"][];
	close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", resolve);
	await promise;
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function shut(server: Server): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	// A stalled answer holds its socket open.
	server.closeAllConnections();
	return promise;
}

/** A mirror answering `answer(<real address>)`: a string is 200 text, undefined is 404. */
export async function startMirror(
	answer: (url: string, request: IncomingMessage) => Answer | Promise<Answer> = () => undefined,
): Promise<Mirror> {
	const asked: string[] = [];
	const headers: IncomingMessage["headers"][] = [];
	const server = createServer(async (request, response) => {
		const url = `https://${(request.url ?? "/").slice(1)}`;
		asked.push(url);
		headers.push(request.headers);
		const result = await answer(url, request);
		if (typeof result === "function") return result(request, response);
		if (result === undefined) {
			response.writeHead(404).end("not found");
			return;
		}
		const spec = typeof result === "string" || result instanceof Uint8Array ? { body: result } : result;
		response.writeHead(spec.status ?? 200, spec.headers).end(spec.body);
	});
	const url = await listen(server);
	return { url, asked, headers, close: () => shut(server) };
}

/** An address nothing listens on: the mirror of a machine that is offline. */
export async function deadMirror(): Promise<string> {
	const server = createServer();
	const url = await listen(server);
	await shut(server);
	return url;
}
