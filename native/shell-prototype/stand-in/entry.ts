/**
 * The stand-in IPC every prototype shell injects ahead of the app's scripts: `window.omp` from the app's own
 * `createOmpApi` over the dev harness transport (fixture state, no host), the one-time import of Electron's
 * Local Storage, `?long=N` (an N-message transcript) and `?selftest=1` (the page-side video seek check).
 */
import { createOmpApi } from "../../../src/shared/omp-api";
import { IPC_COMMANDS } from "../../../src/shared/ipc-types";
import { createHarnessTransport } from "../../../src/renderer/dev-harness/transport";

const query = new URLSearchParams(location.search);

function report(fields: Record<string, unknown>): void {
	void fetch("/__shell/report", { method: "POST", body: JSON.stringify(fields) }).catch(() => {});
}

// Electron's Local Storage of `file://`, exported by the shell's migrate step, lands once in this origin's storage.
const IMPORTED = "__shellLocalStorageImported";
if (localStorage.getItem(IMPORTED) === null) {
	const xhr = new XMLHttpRequest();
	xhr.open("GET", "/__shell/local-storage.json", false);
	try {
		xhr.send();
	} catch {}
	if (xhr.status === 200) {
		const entries = JSON.parse(xhr.responseText) as Record<string, string>;
		let keys = 0;
		for (const [key, value] of Object.entries(entries)) {
			localStorage.setItem(key, value);
			keys++;
		}
		localStorage.setItem(IMPORTED, new Date().toISOString());
		report({ kind: "localStorage.imported", keys });
	} else report({ kind: "localStorage.none", status: xhr.status });
}

const { transport } = createHarnessTransport({});
const long = Number(query.get("long") ?? 0);
if (long > 0) {
	const invoke = transport.invoke.bind(transport);
	transport.invoke = (async (channel: string, ...args: unknown[]) => {
		const result = await invoke(channel, ...args);
		const payload = args[0] as { command?: { type?: string } } | undefined;
		const type = payload?.command?.type;
		const isRpc = channel === IPC_COMMANDS.RPC_COMMAND || channel === IPC_COMMANDS.RPC_COMMAND_FOR_TAB;
		if (!isRpc || (type !== "get_transcript_page" && type !== "get_transcript")) return result;
		const response = result as { data?: { messages?: Record<string, unknown>[] } };
		const base = response.data?.messages ?? [];
		if (base.length === 0) return result;
		const messages: Record<string, unknown>[] = [];
		for (let i = 0; messages.length < long; i++) {
			const message = base[i % base.length];
			messages.push({ ...message, timestamp: Number(message.timestamp ?? 0) + i });
		}
		return { ...response, data: { ...response.data, messages, totalMessages: messages.length } };
	}) as typeof transport.invoke;
}
const api = createOmpApi(transport);
(window as unknown as { omp: unknown }).omp = { ...api, fs: { ...api.fs, pathForFile: () => "" } };

const started = performance.now();
addEventListener("load", () => {
	report({ kind: "page.load", ms: Math.round(performance.now() - started), href: location.href });
	setTimeout(() => {
		report({
			kind: "page.settled",
			nodes: document.getElementsByTagName("*").length,
			platform: document.documentElement.dataset.platform,
			hasOmp: typeof (window as unknown as { omp?: unknown }).omp === "object",
			long,
		});
	}, 5000);
	if (query.get("selftest") === "1") void videoSeek();
});

/** Seeks a range-served video to three points and reports whether each `seeked` landed. */
async function videoSeek(): Promise<void> {
	const video = document.createElement("video");
	video.muted = true;
	video.preload = "metadata";
	video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none";
	video.src = "/__shell/video.webm";
	document.body.appendChild(video);
	const t0 = performance.now();
	const once = (name: string, ms = 10_000) =>
		new Promise<boolean>(resolve => {
			const timer = setTimeout(() => resolve(false), ms);
			video.addEventListener(
				name,
				() => {
					clearTimeout(timer);
					resolve(true);
				},
				{ once: true },
			);
			video.addEventListener("error", () => resolve(false), { once: true });
		});
	if (!(await once("loadedmetadata"))) {
		report({ kind: "selftest.video_seek", ok: false, error: video.error?.message ?? "no metadata" });
		return;
	}
	const seeks: { target: number; landed: number; ok: boolean }[] = [];
	for (const fraction of [0.8, 0.2, 0.5]) {
		const target = video.duration * fraction;
		const seeked = once("seeked");
		video.currentTime = target;
		const ok = (await seeked) && Math.abs(video.currentTime - target) < 1;
		seeks.push({ target: Math.round(target * 10) / 10, landed: Math.round(video.currentTime * 10) / 10, ok });
	}
	report({
		kind: "selftest.video_seek",
		ok: seeks.every(seek => seek.ok),
		duration: video.duration,
		seeks,
		ms: Math.round(performance.now() - t0),
	});
	video.remove();
}
