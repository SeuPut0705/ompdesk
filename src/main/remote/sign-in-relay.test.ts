import { request as httpRequest } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcSignInRelay } from "../../shared/ipc-types";
import { loopbackCallback } from "../sign-in-callback";
import { type SignInRelay, startSignInRelay } from "./sign-in-relay";

const relays: SignInRelay[] = [];
const blockers: Server[] = [];

/** Resolves once `start` called back: a listen or a close. */
function settled(start: (done: () => void) => void): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	start(() => resolve());
	return promise;
}

afterEach(async () => {
	for (const relay of relays.splice(0)) relay.close();
	for (const blocker of blockers.splice(0)) await settled(done => blocker.close(done));
});

async function freePort(): Promise<number> {
	const server = createServer();
	await settled(done => server.listen({ host: "127.0.0.1", port: 0 }, done));
	const address = server.address();
	await settled(done => server.close(done));
	if (!address || typeof address === "string") throw new Error("no port");
	return address.port;
}

/** Stock's authorization URL for a flow whose callback server listens on `callback` (pi-ai callback-server.ts). */
function authorize(callback: string, state: string | null = "xyz"): string {
	const url = new URL("https://claude.ai/oauth/authorize?code=true&client_id=fixture");
	url.searchParams.set("redirect_uri", callback);
	if (state !== null) url.searchParams.set("state", state);
	return url.toString();
}

const failure = () => ({ title: "Sign-in not finished", message: "Copy this page's address & paste it in OMPdesk." });

function relay(options: { callback: string; forward?: SignInRelayForward; port?: number; timeoutMs?: number }) {
	const states: Array<IpcSignInRelay> = [];
	const forward = vi.fn(
		options.forward ??
			(async () => ({ status: 200, contentType: "text/html; charset=utf-8", body: "<p>Signed in</p>" })),
	);
	const started = startSignInRelay({
		authorizationUrl: authorize(options.callback),
		forward,
		failure,
		onState: state => states.push(state),
		...(options.port === undefined ? {} : { port: options.port }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	});
	if (!started) throw new Error("expected a relay");
	relays.push(started);
	return { relay: started, states, forward };
}

type SignInRelayForward = (
	path: string,
	query: string,
) => Promise<{ status: number; contentType: string; body: string }>;

/** A GET as a browser makes it, with the Host header it would send. */
function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
	const request = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, response => {
		let body = "";
		response.setEncoding("utf8");
		response.on("data", chunk => {
			body += chunk;
		});
		response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
	});
	request.on("error", reject);
	request.end();
	return promise;
}

/** Whether nothing listens on `port`, by a bare connect: no request, so nothing a stand-in still listening could forward. */
const nothingListens = (port: number) =>
	new Promise<boolean>(resolve => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
	});

const refused = (port: number) =>
	get(port, "/callback?code=abc&state=xyz").then(
		() => false,
		(error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED",
	);

describe("loopbackCallback", () => {
	it("reads a browser sign-in's loopback redirect and the flow's state", () => {
		const callback = loopbackCallback(authorize("http://localhost:54545/callback"));
		expect(callback?.url.toString()).toBe("http://localhost:54545/callback");
		expect(callback?.state).toBe("xyz");
		expect(loopbackCallback(authorize("http://[::1]:1455/auth/callback?x=1"))?.url.toString()).toBe(
			"http://[::1]:1455/auth/callback",
		);
		expect(loopbackCallback(authorize("http://127.0.0.1:1455/cb", null))?.state).toBeNull();
	});

	it("reads nothing that is not a loopback http callback with a port", () => {
		expect(loopbackCallback(authorize("https://localhost:54545/callback"))).toBeNull();
		expect(loopbackCallback(authorize("http://evil.example:54545/callback"))).toBeNull();
		expect(loopbackCallback(authorize("http://127.0.0.2:54545/callback"))).toBeNull();
		expect(loopbackCallback(authorize("vscode://gitlab/callback"))).toBeNull();
		expect(loopbackCallback(authorize("http://localhost/callback"))).toBeNull();
		expect(loopbackCallback("not a url")).toBeNull();
	});
});

describe("startSignInRelay", () => {
	it("listens on the callback's own port on loopback and hands the host the matching callback once", async () => {
		const port = await freePort();
		const { states, forward } = relay({ callback: `http://127.0.0.1:${port}/callback` });
		await vi.waitFor(() => expect(states).toEqual([{ listening: true }]));

		// Another path or another flow's state never reaches the host.
		expect((await get(port, "/favicon.ico")).status).toBe(404);
		expect((await get(port, "/callback?code=abc&state=other")).status).toBe(404);
		expect((await get(port, "/callback?code=abc")).status).toBe(404);
		expect(forward).not.toHaveBeenCalled();

		// The browser comes back here: the host's omp gets path and query, the browser gets its page.
		const page = await get(port, "/callback?code=abc&state=xyz");
		expect(page).toEqual({ status: 200, body: "<p>Signed in</p>" });
		expect(forward.mock.calls).toEqual([["/callback", "code=abc&state=xyz"]]);
		// One use: the listener is gone.
		await vi.waitFor(async () => expect(await refused(port)).toBe(true));
		expect(forward).toHaveBeenCalledTimes(1);
	});

	it("listens for a localhost callback on both loopback families, as stock does", async () => {
		const port = await freePort();
		const { states, forward } = relay({ callback: `http://localhost:${port}/callback` });
		await vi.waitFor(() => expect(states).toEqual([{ listening: true }]));
		expect((await get(port, "/callback?code=abc&state=xyz", `localhost:${port}`)).status).toBe(200);
		expect(forward).toHaveBeenCalledTimes(1);
	});

	it("never answers a page asked for under another host name", async () => {
		const port = await freePort();
		const { states, forward } = relay({ callback: `http://127.0.0.1:${port}/callback` });
		await vi.waitFor(() => expect(states).toEqual([{ listening: true }]));
		expect((await get(port, "/callback?code=abc&state=xyz", `rebound.example:${port}`)).status).toBe(403);
		expect(forward).not.toHaveBeenCalled();
	});

	it("tells the browser how to finish by hand when the host cannot be reached, and stays for another try", async () => {
		const port = await freePort();
		let reachable = false;
		const { forward, states } = relay({
			callback: `http://127.0.0.1:${port}/callback`,
			forward: async () => {
				if (!reachable) throw new Error("offline");
				return { status: 200, contentType: "text/plain", body: "Signed in." };
			},
		});
		await vi.waitFor(() => expect(states).toEqual([{ listening: true }]));
		const failed = await get(port, "/callback?code=abc&state=xyz");
		expect(failed.status).toBe(502);
		expect(failed.body).toContain("Sign-in not finished");
		// Escaped: the page is HTML.
		expect(failed.body).toContain("page&#39;s address &amp; paste");

		reachable = true;
		expect(await get(port, "/callback?code=abc&state=xyz")).toEqual({ status: 200, body: "Signed in." });
		expect(forward).toHaveBeenCalledTimes(2);
	});

	it("still gives the browser its page when the sign-in ends while the callback is on its way", async () => {
		const port = await freePort();
		const holder: { relay?: SignInRelay } = {};
		const started = relay({
			callback: `http://127.0.0.1:${port}/callback`,
			// The host's `login` answers before its page does: the device ends the stand-in first.
			forward: async () => {
				holder.relay?.close();
				return { status: 200, contentType: "text/plain", body: "Signed in." };
			},
		});
		holder.relay = started.relay;
		await vi.waitFor(() => expect(started.states).toEqual([{ listening: true }]));
		expect(await get(port, "/callback?code=abc&state=xyz")).toEqual({ status: 200, body: "Signed in." });
		await vi.waitFor(async () => expect(await refused(port)).toBe(true));
	});

	it("says so when this computer already uses the callback's port, and listens on nothing", async () => {
		const port = await freePort();
		const blocker = createServer();
		blockers.push(blocker);
		await settled(done => blocker.listen({ host: "127.0.0.1", port }, done));
		const { states } = relay({ callback: `http://127.0.0.1:${port}/callback` });
		await vi.waitFor(() => expect(states).toEqual([{ listening: false, port }]));
	});

	it("listens on a port it is given instead (two apps on one computer share its loopback)", async () => {
		const [callbackPort, port] = [await freePort(), await freePort()];
		const { states, forward } = relay({ callback: `http://127.0.0.1:${callbackPort}/callback`, port });
		await vi.waitFor(() => expect(states).toEqual([{ listening: true }]));
		expect((await get(port, "/callback?code=abc&state=xyz")).status).toBe(200);
		expect(forward).toHaveBeenCalledTimes(1);
	});

	it("ends when closed and when stock's callback would have timed out", async () => {
		const port = await freePort();
		const closed = relay({ callback: `http://127.0.0.1:${port}/callback` });
		await vi.waitFor(() => expect(closed.states).toEqual([{ listening: true }]));
		closed.relay.close();
		await vi.waitFor(async () => expect(await refused(port)).toBe(true));

		const later = await freePort();
		const timed = relay({ callback: `http://127.0.0.1:${later}/callback`, timeoutMs: 50 });
		await vi.waitFor(() => expect(timed.states).toEqual([{ listening: true }]));
		await vi.waitFor(async () => expect(await nothingListens(later)).toBe(true));
		expect(timed.forward).not.toHaveBeenCalled();
	});

	it("forwards nothing once closed, even a callback that reaches the core before the close does", async () => {
		// The close crosses to the core as a push while the callback is already on its way: whichever the core reads
		// first, the browser hears 409 or a refused connection and the host never gets the callback.
		for (let round = 0; round < 10; round++) {
			const port = await freePort();
			const stand = relay({ callback: `http://127.0.0.1:${port}/callback` });
			await vi.waitFor(() => expect(stand.states).toEqual([{ listening: true }]));
			const callback = get(port, "/callback?code=abc&state=xyz").then(
				page => page.status,
				() => "refused",
			);
			stand.relay.close();
			expect([409, "refused"]).toContain(await callback);
			expect(stand.forward).not.toHaveBeenCalled();
		}
	});

	it("starts for no sign-in without a loopback callback or a state to check", () => {
		const options = { forward: vi.fn(), failure, onState: vi.fn() };
		expect(startSignInRelay({ ...options, authorizationUrl: authorize("https://example.com/callback") })).toBeNull();
		expect(
			startSignInRelay({ ...options, authorizationUrl: authorize("http://127.0.0.1:1455/callback", null) }),
		).toBeNull();
	});
});
