// The Electron reference for the measurements: today's shell with nothing of OMPdesk's main process, serving the same
// page, stand-in and scheme contract as the candidates (README.md), so memory compares shells, not app logic.
// electron main.cjs [--query q] [--preview url] [--log file] [--debug-port n]
const { app, BrowserWindow, WebContentsView, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const arg = name => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const proto = path.resolve(__dirname, "../..");
const renderer = path.resolve(proto, "../../out/renderer");
const assets = path.join(proto, "shell-assets");
const userData = path.resolve(arg("user-data") ?? path.join(process.env.APPDATA, "ompdesk-proto-electron"));
app.setPath("userData", path.join(userData, "shell-webview"));
const logFile = path.resolve(arg("log") ?? path.join(userData, "shell.log.jsonl"));
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const t0 = Date.now();
const log = (event, fields = {}) => fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - t0, event, ...fields })}\n`);
if (arg("debug-port")) app.commandLine.appendSwitch("remote-debugging-port", arg("debug-port"));
protocol.registerSchemesAsPrivileged([
	{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webm": "video/webm", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wasm": "application/wasm", ".ico": "image/x-icon", ".txt": "text/plain" };

async function serve(request) {
	const url = new URL(request.url);
	if (url.pathname === "/__shell/report" && request.method === "POST") {
		log("page.report", JSON.parse(await request.text()));
		return new Response(null, { status: 204 });
	}
	const file = url.pathname.startsWith("/__shell/")
		? path.join(assets, url.pathname.slice(9))
		: path.join(renderer, decodeURIComponent(url.pathname));
	if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
	const type = MIME[path.extname(file)] ?? "application/octet-stream";
	if (path.basename(file) === "index.html") {
		const html = fs.readFileSync(file, "utf8").replace("<head>", '<head><script src="/__shell/stand-in.js"></script>');
		return new Response(html, { headers: { "content-type": type } });
	}
	const size = fs.statSync(file).size;
	const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") ?? "");
	if (range) {
		const start = range[1] ? Number(range[1]) : size - Number(range[2]);
		const end = range[1] && range[2] ? Number(range[2]) : size - 1;
		log("scheme.range", { path: url.pathname, range: request.headers.get("range"), status: 206 });
		const body = fs.createReadStream(file, { start, end });
		return new Response(require("node:stream").Readable.toWeb(body), {
			status: 206,
			headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": String(end - start + 1) },
		});
	}
	return new Response(fs.readFileSync(file), { headers: { "content-type": type, "accept-ranges": "bytes" } });
}

app.whenReady().then(() => {
	log("start", { candidate: "electron", version: process.versions.electron });
	protocol.handle("app", serve);
	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		titleBarStyle: "hidden",
		titleBarOverlay: { height: 48 },
		webPreferences: { contextIsolation: true },
	});
	const started = Date.now();
	win.webContents.on("did-finish-load", () => log("page.loaded", { ms: Date.now() - started }));
	const q = arg("query");
	win.loadURL(`app://ompdesk/index.html${q ? `?${q}` : ""}`);
	log("page.url", { url: win.webContents.getURL() || "app://ompdesk/index.html" });
	const preview = arg("preview");
	if (preview) {
		const view = new WebContentsView();
		win.contentView.addChildView(view);
		const place = () => {
			const [w, h] = win.getContentSize();
			view.setBounds({ x: Math.round(w * 0.6), y: 48, width: Math.round(w * 0.4), height: h - 48 });
		};
		place();
		win.on("resize", place);
		const p0 = Date.now();
		view.webContents.on("did-finish-load", () => log("preview.loaded", { url: preview, ms: Date.now() - p0 }));
		view.webContents.loadURL(preview);
	}
	const exitAfter = Number(arg("exit-after") ?? 0);
	if (exitAfter) setTimeout(() => app.quit(), exitAfter * 1000);
});
app.on("window-all-closed", () => app.quit());
