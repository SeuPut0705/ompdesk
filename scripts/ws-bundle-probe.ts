/**
 * Entry of the probe `scripts/check-main-bundle.ts` bundles with the main process's own Vite config and runs
 * in Node: one WebSocket round trip through the bundled `ws`, both ends in this process. Every frame a client
 * sends is masked, so the server unmasks each one, and the payloads are long enough (32+ bytes) that ws hands
 * unmasking, masking and UTF-8 validation to its optional native addons (`bufferutil`, `utf-8-validate`) when
 * it believes they are there. v0.34.0 shipped Vite's empty stand-in for those addons, and the first masked
 * frame a paired phone sent crashed main with `bufferUtil.unmask is not a function`.
 *
 * Prints `ws round trip ok` and exits 0 when every echo came back byte for byte; anything else exits non-zero.
 * This file is a `BUILD_SCRIPTS` input of scripts/build-cache.ts.
 */
import { WebSocket, WebSocketServer } from "ws";

const TIMEOUT_MS = 10_000;

/** Sent one at a time, each after the last echo, smallest first: the first that fails names the code path. */
const payloads: Array<{ data: Buffer; binary: boolean }> = [
	{ data: Buffer.from("hi"), binary: false },
	// 32–47 bytes: the server's unmask goes native at 32 (the v0.34.0 crash), the client's mask only at 48.
	{ data: Buffer.from('{"t":"inv","id":1,"ch":"sessions:list"}'), binary: false },
	{ data: Buffer.from(`{"t":"inv","id":2,"ch":"sessions:list","a":[{"scope":"전체 세션"}]}`), binary: false },
	{ data: Buffer.from("한국어 텍스트 프레임, UTF-8 검증을 거치는 긴 메시지. ".repeat(40)), binary: false },
	{ data: Buffer.alloc(4096, 0xa5), binary: true },
	// Above 64 KiB: the 64-bit length form.
	{ data: Buffer.alloc(70_000, 0x3c), binary: true },
];

const timer = setTimeout(() => {
	console.error(`ws round trip timed out after ${TIMEOUT_MS} ms`);
	process.exit(1);
}, TIMEOUT_MS);

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", socket => {
	socket.on("message", (data, binary) => socket.send(data, { binary }));
});
await new Promise<void>((resolve, reject) => {
	server.once("listening", resolve);
	server.once("error", reject);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("the probe server has no port");

const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
await new Promise<void>((resolve, reject) => {
	client.once("open", resolve);
	client.once("error", reject);
});
for (const [index, { data, binary }] of payloads.entries()) {
	const echo = await new Promise<{ data: Buffer; binary: boolean }>((resolve, reject) => {
		client.once("message", (received, isBinary) => resolve({ data: received as Buffer, binary: isBinary }));
		client.once("error", reject);
		client.send(data, { binary });
	});
	if (echo.binary !== binary || !echo.data.equals(data)) {
		throw new Error(`echo ${index} differs from what was sent (${data.length} bytes, binary ${binary})`);
	}
}

clearTimeout(timer);
client.terminate();
server.close();
console.log("ws round trip ok");
