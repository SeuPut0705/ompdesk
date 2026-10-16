/**
 * Electron main for e2e/preview-stream.e2e.ts: the real preview host (src/main/preview/host.ts) with a paired
 * viewer's virtual window behind the real WsRouter, driven by a fake WebSocket client, against a local test
 * page. Run by Electron itself (the spec bundles this file with bun), prints `RESULT <json>` and exits.
 *
 * What it proves, on real offscreen pages: frames arrive as JPEGs of the size the viewer's surface asks for,
 * none before the acknowledgement and at most 12 a second, a still page sends nothing, a tap reaches the page
 * as a trusted click (and keys and text as trusted input), a pinch zooms, a page's `confirm` waits for the
 * viewer's answer. It also measures: fps, bytes a frame, CPU of every Electron process while streaming and idle.
 */
import { mkdirSync } from "node:fs";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { app, screen } from "electron";
import { registerPreviewHost } from "../../src/main/preview/host";
import { parseVisualUrl } from "../../src/main/preview/visual-navigation";
import type { VisualStore } from "../../src/main/preview/visuals";
import { BlobStore } from "../../src/main/web/blobs";
import type { WebDevice } from "../../src/main/web/devices-store";
import { IpcRegistry } from "../../src/main/web/ipc-registry";
import { writeDialogPreload } from "../../src/main/web/preview-dialog";
import { WebWindows } from "../../src/main/web/web-client-window";
import { WsRouter } from "../../src/main/web/ws-router";
import type { PreviewState, PreviewStreamFrame, PreviewStreamInput, PreviewStreamPoll } from "../../src/shared/preview";
import {
	PREVIEW_COMMAND,
	PREVIEW_STATE,
	PREVIEW_STREAM_DIALOG,
	PREVIEW_STREAM_INPUT,
	PREVIEW_STREAM_POLL,
} from "../../src/shared/preview";

const userData = process.env.OMP_PREVIEW_E2E_USERDATA;
if (!userData) throw new Error("OMP_PREVIEW_E2E_USERDATA is required");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
// The page under test is on 127.0.0.1; nothing here touches the user's screen.
app.dock?.hide();

/** What the test page posts about the events it saw. */
interface PageLog {
	type: string;
	trusted: boolean;
	[key: string]: unknown;
}

const PAGE = `<!doctype html><meta name=viewport content="width=device-width">
<style>
body{margin:0;font:16px system-ui;background:#fff}
#btn{position:fixed;left:20px;top:30px;width:160px;height:56px;font-size:18px}
#t{position:fixed;left:20px;top:110px;width:300px;height:44px;font-size:18px}
#area{position:fixed;left:20px;top:170px;width:300px;height:80px;font-size:16px}
#list{margin-top:300px}.row{height:28px;padding:4px 8px;border-bottom:1px solid #ddd}.row:nth-child(3n){background:#eef}
#busy{position:fixed;right:0;top:0;width:120px;height:120px;background:#06c}
</style>
<button id=btn>Tap me</button><input id=t><textarea id=area></textarea><div id=busy></div>
<div id=list></div>
<script>
const q = new URLSearchParams(location.search);
const send = entry => fetch('/log', { method: 'POST', body: JSON.stringify(entry) }).catch(() => {});
document.getElementById('list').innerHTML = Array.from({ length: 400 }, (_, i) => '<div class=row>row ' + i + ' the quick brown fox ' + (i * 7919 % 1000) + '</div>').join('');
addEventListener('click', e => send({ type: 'click', trusted: e.isTrusted, x: e.clientX, y: e.clientY, target: e.target.id, active: navigator.userActivation.isActive }), true);
addEventListener('keydown', e => send({ type: 'keydown', trusted: e.isTrusted, key: e.key }), true);
addEventListener('input', e => send({ type: 'input', trusted: e.isTrusted, value: e.target.value, id: e.target.id }), true);
addEventListener('wheel', e => send({ type: 'wheel', trusted: e.isTrusted, dy: e.deltaY }), true);
addEventListener('scroll', () => send({ type: 'scroll', trusted: true, y: scrollY }), true);
document.getElementById('btn').addEventListener('click', () => {
  if (q.get('dialog')) { const r = confirm('Delete everything?'); send({ type: 'confirm', trusted: true, result: r }); const p = prompt('Name?', 'dflt'); send({ type: 'prompt', trusted: true, result: p }); alert('done'); send({ type: 'alert-returned', trusted: true }); }
});
if (q.get('busy')) { let y = 0; (function f() { y = (y + 6) % 3000; document.getElementById('list').style.transform = 'translateY(' + (-y) + 'px)'; document.getElementById('busy').style.background = 'hsl(' + (y % 360) + ',80%,50%)'; requestAnimationFrame(f); })(); }
</script>`;

const log: PageLog[] = [];
const server = http.createServer((request, response) => {
	if (request.url?.startsWith("/log")) {
		if (request.method === "POST") {
			let body = "";
			request.on("data", chunk => {
				body += chunk;
			});
			request.on("end", () => {
				try {
					log.push(JSON.parse(body) as PageLog);
				} catch {
					// A malformed post is not an event.
				}
				response.end("ok");
			});
			return;
		}
	}
	response.setHeader("content-type", "text/html");
	response.end(PAGE);
});

/** JPEG size from its start-of-frame marker. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
	let offset = 2;
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) throw new Error("Not a JPEG marker");
		const marker = bytes[offset + 1] ?? 0;
		const length = bytes.readUInt16BE(offset + 2);
		if (marker >= 0xc0 && marker <= 0xc3) {
			return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
		}
		offset += 2 + length;
	}
	throw new Error(`No frame header in ${bytes.length} bytes: ${bytes.subarray(0, 24).toString("hex")}`);
}

interface Reply {
	ok: boolean;
	v?: unknown;
	e?: { message: string };
}

/** CPU seconds spent so far by every Electron process (browser, GPU, renderers, utilities). */
function cpuSeconds(): number {
	return app.getAppMetrics().reduce((sum, metric) => sum + (metric.cpu.cumulativeCPUUsage ?? 0), 0);
}

async function main() {
	await app.whenReady();
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const origin = `http://127.0.0.1:${port}`;

	const ipc = new IpcRegistry({ handle: () => {}, on: () => {} });
	const visuals = {
		parse: parseVisualUrl,
		view: () => null,
		url: () => null,
		serve: async () => new Response("", { status: 404 }),
		list: async () => [],
		forTab: () => [],
		addToTab: async () => false,
	} as unknown as VisualStore;
	registerPreviewHost(ipc, () => false, visuals, {
		isRemote: () => false,
		hostScale: () => screen.getPrimaryDisplay().scaleFactor,
		preloadPath: () => writeDialogPreload(userData as string),
	});

	const device: WebDevice = {
		deviceId: "phone-1",
		name: "Test phone",
		userAgent: "",
		tailscaleLogin: null,
		secretSha256: "0".repeat(64),
		publicKeyJwk: null,
		grants: ["workspace"],
		uiPrefs: {},
		createdAt: 0,
	};
	const windows = new WebWindows((deviceId, channel, payload) => router.deliver(deviceId, channel, payload));
	const router: WsRouter = new WsRouter({
		registry: ipc,
		devices: { get: () => device },
		windows,
		quota: { reserve: () => ({ ok: true, refund: () => {} }), record: () => {} },
		webChannels: {},
		features: () => ({ push: false, preview: true, upload: false, passkey: false }),
		blobs: new BlobStore(),
	});

	// The fake client: the frames the router writes, and calls it makes as `inv` / `snd` frames.
	const states: PreviewState[] = [];
	const pending = new Map<number, (reply: Reply) => void>();
	let nextId = 1;
	const connection = router.attach(device.deviceId, {
		send(data) {
			const frame = JSON.parse(data) as {
				t: string;
				id?: number;
				ok?: boolean;
				v?: unknown;
				e?: { message: string };
				ch?: string;
				d?: unknown;
			};
			if (frame.t === "res" && frame.id !== undefined) {
				const reply = pending.get(frame.id);
				pending.delete(frame.id);
				reply?.({ ok: frame.ok === true, v: frame.v, e: frame.e });
			} else if (frame.t === "evt" && frame.ch === PREVIEW_STATE) states.push(frame.d as PreviewState);
		},
		close() {},
		ping() {},
		terminate() {},
	});
	if (!connection) throw new Error("The router refused the connection");
	const invoke = (channel: string, ...args: unknown[]) => {
		const id = nextId++;
		const { promise, resolve } = Promise.withResolvers<Reply>();
		pending.set(id, resolve);
		connection.receive(JSON.stringify({ t: "inv", id, ch: channel, a: args }));
		return promise;
	};
	const send = (channel: string, ...args: unknown[]) =>
		connection.receive(JSON.stringify({ t: "snd", ch: channel, a: args }));
	const command = async (request: unknown) => {
		const reply = await invoke(PREVIEW_COMMAND, request);
		if (!reply.ok) throw new Error(`preview command failed: ${reply.e?.message}`);
		return reply.v as PreviewState;
	};
	const poll = async (ack: number | null, wait: number): Promise<PreviewStreamPoll> => {
		const reply = await invoke(PREVIEW_STREAM_POLL, { ack, wait });
		if (!reply.ok) throw new Error(`poll failed: ${reply.e?.message}`);
		return reply.v as PreviewStreamPoll;
	};
	const input = (...events: PreviewStreamInput[]) => send(PREVIEW_STREAM_INPUT, events);
	const lastState = () => states.at(-1);
	const waitFor = async (what: string, ready: () => boolean, timeoutMs = 8000) => {
		const started = Date.now();
		while (!ready()) {
			if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
			await sleep(25);
		}
	};
	const decode = (frame: PreviewStreamFrame) => {
		const bytes = Buffer.from(frame.jpeg, "base64");
		if (bytes.length === 0) throw new Error(`Empty frame: ${JSON.stringify({ ...frame, jpeg: frame.jpeg.length })}`);
		return { bytes: bytes.length, ...jpegSize(bytes) };
	};
	const loaded = async (url: string) => {
		await command({ action: "load", url });
		await waitFor(`${url} to load`, () => lastState()?.url === url && lastState()?.loading === false);
	};

	const result: Record<string, unknown> = {};
	const layout = { x: 0, y: 0, width: 390, height: 700 };

	// 1. A phone-sized surface at 3× is encoded at 2×: 780 px wide, whatever the host screen's density.
	await command({ action: "layout", bounds: layout, visible: true, dpr: 3 });
	await loaded(`${origin}/`);
	let seq: number | null = null;
	const first = await poll(null, 5000);
	if (!first.frame) throw new Error("No first frame");
	seq = first.frame.seq;
	const size = decode(first.frame);
	result.firstFrame = {
		...size,
		rect: first.frame.rect,
		tab: first.frame.tab === lastState()?.activeTab,
		hostScale: screen.getPrimaryDisplay().scaleFactor,
	};

	// 2. A tap on the button is a trusted click with user activation.
	log.length = 0;
	input({ t: "tap", x: 100 / 390, y: 58 / 700 });
	await waitFor("the click", () => log.some(entry => entry.type === "click"));
	const click = log.find(entry => entry.type === "click");
	result.click = { trusted: click?.trusted, target: click?.target, active: click?.active, x: click?.x, y: click?.y };

	// 3. Keys and committed text reach a focused field as trusted input.
	log.length = 0;
	input({ t: "tap", x: 100 / 390, y: 132 / 700 });
	await sleep(100);
	input({ t: "key", key: "a" }, { t: "key", key: "b" }, { t: "key", key: "Backspace" }, { t: "text", text: "한글" });
	await waitFor("the typed value", () =>
		log.some(entry => entry.type === "input" && String(entry.value).includes("한글")),
	);
	const typed = log.filter(entry => entry.type === "input" || entry.type === "keydown");
	result.typing = {
		// The posts may overtake each other: the entry that holds the committed text carries the field's value.
		value: log.find(entry => entry.type === "input" && String(entry.value).includes("한글"))?.value,
		allTrusted: typed.length > 0 && typed.every(entry => entry.trusted === true),
		keys: log.filter(entry => entry.type === "keydown").map(entry => entry.key),
	};
	// Enter types a newline in a textarea (the char event after the key).
	log.length = 0;
	input({ t: "tap", x: 100 / 390, y: 200 / 700 });
	await sleep(100);
	input({ t: "key", key: "x" }, { t: "key", key: "Enter" }, { t: "key", key: "y" });
	await waitFor("the textarea value", () => log.filter(entry => entry.type === "input").length >= 3);
	result.enter = JSON.stringify(log.find(entry => entry.type === "input" && String(entry.value).endsWith("y"))?.value);

	// 4. A wheel gesture scrolls the page (trusted), in the DOM's sign.
	log.length = 0;
	input({ t: "wheel", x: 0.5, y: 0.8, dx: 0, dy: 240 });
	await waitFor("the scroll", () => log.some(entry => entry.type === "scroll" && Number(entry.y) > 0));
	result.wheel = {
		trusted: log.find(entry => entry.type === "wheel")?.trusted,
		dy: log.find(entry => entry.type === "wheel")?.dy,
	};

	// 5. A pinch multiplies the page's zoom and the viewer is told.
	const zoomBefore = lastState()?.zoom;
	input({ t: "pinch", scale: 1.5 });
	await waitFor("the zoom", () => lastState()?.zoom !== zoomBefore);
	result.zoom = { before: zoomBefore, after: lastState()?.zoom };
	input({ t: "pinch", scale: 1 / 1.5 });
	await waitFor("the zoom to come back", () => lastState()?.zoom === zoomBefore);

	// 6. A still page costs nothing: the poll is held and answers empty.
	await sleep(400);
	let idleFrames = 0;
	let idleBytes = 0;
	// Drain whatever the interaction painted first.
	for (let rounds = 0; rounds < 6; rounds++) {
		const drained = await poll(seq, 500);
		if (!drained.frame) break;
		seq = drained.frame.seq;
	}
	const idleMeasureStart = Date.now();
	const idleCpuMeasureStart = cpuSeconds();
	while (Date.now() - idleMeasureStart < 3000) {
		const idle = await poll(seq, 1000);
		if (idle.frame) {
			idleFrames += 1;
			idleBytes += decode(idle.frame).bytes;
			seq = idle.frame.seq;
		}
	}
	result.idle = {
		seconds: (Date.now() - idleMeasureStart) / 1000,
		frames: idleFrames,
		bytes: idleBytes,
		cpuCorePercent: ((cpuSeconds() - idleCpuMeasureStart) / ((Date.now() - idleMeasureStart) / 1000)) * 100,
	};

	// 7. A busy page (every pixel changing each frame), acknowledged at once: at most 12 frames a second.
	await loaded(`${origin}/?busy=1`);
	const drain = await poll(null, 3000);
	if (drain.frame) seq = drain.frame.seq;
	const seconds = 6;
	const cpuStart = cpuSeconds();
	const started = Date.now();
	let frames = 0;
	let bytes = 0;
	const stamps: number[] = [];
	const sizes = new Set<string>();
	while (Date.now() - started < seconds * 1000) {
		const reply = await poll(seq, 2000);
		if (!reply.frame) continue;
		seq = reply.frame.seq;
		const decoded = decode(reply.frame);
		sizes.add(`${decoded.width}x${decoded.height}`);
		frames += 1;
		bytes += decoded.bytes;
		stamps.push(Date.now() - started);
	}
	const elapsed = (Date.now() - started) / 1000;
	const perSecond = Array.from(
		{ length: seconds },
		(_, second) => stamps.filter(stamp => stamp >= second * 1000 && stamp < (second + 1) * 1000).length,
	);
	result.busy = {
		seconds: elapsed,
		frames,
		fps: frames / elapsed,
		maxFramesInAnySecond: Math.max(...perSecond),
		bytesPerFrame: Math.round(bytes / Math.max(1, frames)),
		kbitPerSecond: Math.round((bytes * 8) / elapsed / 1000),
		cpuCorePercent: ((cpuSeconds() - cpuStart) / elapsed) * 100,
		sizes: [...sizes],
	};

	// 8. No acknowledgement, no frame: polling with the frame before the last leaves the busy page unsent.
	const heldStart = Date.now();
	const held = await poll((seq ?? 1) - 1, 1200);
	result.ackHold = { frameWithoutAck: held.frame !== null, heldMs: Date.now() - heldStart };
	const released = await poll(seq, 3000);
	result.ackRelease = { frameAfterAck: released.frame !== null };
	if (released.frame) seq = released.frame.seq;

	// 9. A page's confirm, prompt and alert wait for the viewer; the page's script resumes with the answers.
	await loaded(`${origin}/?dialog=1`);
	const settle = await poll(null, 3000);
	if (settle.frame) seq = settle.frame.seq;
	log.length = 0;
	input({ t: "tap", x: 100 / 390, y: 58 / 700 });
	const dialogs: Array<{ kind: string; message: string; initial: string | null }> = [];
	const answers = [
		{ accept: true, text: undefined },
		{ accept: true, text: "Ada" },
		{ accept: true, text: undefined },
	];
	for (const answer of answers) {
		let opened: PreviewStreamPoll | null = null;
		const waitedFrom = Date.now();
		while (!opened?.dialogs.length) {
			if (Date.now() - waitedFrom > 8000) throw new Error("No dialog arrived");
			opened = await poll(seq, 1500);
			if (opened.frame) seq = opened.frame.seq;
		}
		const dialog = opened.dialogs[0];
		if (!dialog) throw new Error("No dialog");
		dialogs.push({ kind: dialog.kind, message: dialog.message, initial: dialog.initial });
		// While the dialog is open the page is blocked: its script has not logged the result yet.
		if (dialog.kind === "confirm") result.blockedBeforeAnswer = !log.some(entry => entry.type === "confirm");
		await invoke(PREVIEW_STREAM_DIALOG, {
			id: dialog.id,
			accept: answer.accept,
			...(answer.text ? { text: answer.text } : {}),
		});
	}
	await waitFor("the page to resume", () => log.some(entry => entry.type === "alert-returned"));
	result.dialogs = {
		asked: dialogs,
		confirm: log.find(entry => entry.type === "confirm")?.result,
		prompt: log.find(entry => entry.type === "prompt")?.result,
		resumed: true,
	};

	// 10. Closing the preview ends the offscreen windows.
	await command({ action: "dispose" });
	console.log(`RESULT ${JSON.stringify(result)}`);
	server.close();
	app.exit(0);
}

main().catch(error => {
	console.log(`FAILED ${error instanceof Error ? error.stack : String(error)}`);
	app.exit(1);
});
