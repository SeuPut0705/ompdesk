/**
 * The shell's page script: `window.omp`, built by the shared `createOmpApi` over `fetch` to the shell's own scheme.
 * The shell (`native/ompdesk/crates/shell`, `scheme.rs`) puts `<script src="/__shell/preload.js">` first in the app's
 * `index.html`, so this runs before any page script, as Electron's preload did through `contextBridge`.
 *
 *   invoke   POST app://ompdesk/__ipc/invoke  {channel, args}  → {value} | {error}     (never blocks the renderer)
 *   send     POST app://ompdesk/__ipc/send    {channel, args}  → 204, one at a time, in order
 *   on       GET  app://ompdesk/__ipc/events                   → one JSON line per main → page push, in order
 *
 * JSON cannot carry a `Uint8Array`: it travels as `{"$bin": "<base64>"}` both ways (the host protocol's `ipc.invoke`
 * args and answers use the same tag). Also here: Electron's `file://` Local Storage, exported once by the shell, is
 * copied into this origin before the page reads any of it, and `fs.pathForFile` is answered from the shell's last
 * drag-and-drop file list.
 */
import type { OmpApi } from "../shared/ipc-types";
import { createOmpApi, type OmpTransport } from "../shared/omp-api";

const BASE = "app://ompdesk/";

function toBase64(bytes: Uint8Array): string {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

function fromBase64(text: string): Uint8Array {
	const raw = atob(text);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

function encode(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (item instanceof Uint8Array) return { $bin: toBase64(item) };
		if (item instanceof ArrayBuffer) return { $bin: toBase64(new Uint8Array(item)) };
		return item;
	});
}

function decode(text: string): unknown {
	return JSON.parse(text, (_key, item) => {
		if (item !== null && typeof item === "object" && "$bin" in item && typeof item.$bin === "string") return fromBase64(item.$bin);
		return item;
	});
}

/** Electron's `file://` Local Storage → this origin, once, synchronously, before the page's first read. */
function importLocalStorage(): void {
	try {
		const read = new XMLHttpRequest();
		read.open("GET", `${BASE}__shell/local-storage`, false);
		read.send();
		if (read.status !== 200 || read.getResponseHeader("X-Ompdesk-Import") !== "pending") return;
		const items = JSON.parse(read.responseText) as Record<string, string>;
		for (const [key, value] of Object.entries(items)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
		const done = new XMLHttpRequest();
		done.open("POST", `${BASE}__shell/local-storage-done`, false);
		done.send();
	} catch {
		// A failed import leaves the page with an empty store, as a first run; the shell logs nothing more here.
	}
}

const listeners = new Map<string, Set<(data: unknown) => void>>();

function dispatch(line: string): void {
	let message: { channel: string; args: unknown[] };
	try {
		message = decode(line) as { channel: string; args: unknown[] };
	} catch {
		return;
	}
	const set = listeners.get(message.channel);
	if (!set) return;
	const data = message.args[0];
	for (const listener of [...set]) listener(data);
}

/** The push stream: one reader for the page's life, started now so nothing the main process sends waits for a listener. */
async function readEvents(): Promise<never> {
	for (;;) {
		try {
			const response = await fetch(`${BASE}__ipc/events`);
			if (!response.body) throw new Error("no body");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line) dispatch(line);
				}
			}
		} catch {
			// The shell is gone or the stream broke: try again shortly.
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 250);
		await promise;
	}
}

let sends: Promise<unknown> = Promise.resolve();

const shellTransport: OmpTransport = {
	async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		const response = await fetch(`${BASE}__ipc/invoke`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: encode({ channel, args }),
		});
		const answer = decode(await response.text()) as { value?: T; error?: { message: string } };
		if (answer.error) throw new Error(answer.error.message);
		return answer.value as T;
	},
	send(channel: string, ...args: unknown[]): void {
		const body = encode({ channel, args });
		sends = sends.then(() =>
			fetch(`${BASE}__ipc/send`, { method: "POST", headers: { "content-type": "text/plain" }, body }).catch(() => undefined),
		);
	},
	on(channel: string, listener: (data: unknown) => void): () => void {
		let set = listeners.get(channel);
		if (!set) {
			set = new Set();
			listeners.set(channel, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	},
};

/** The path of a dropped file: the shell saw the drag enter with the paths, the page only has the `File`. */
function pathForFile(file: File): string {
	try {
		const request = new XMLHttpRequest();
		request.open("GET", `${BASE}__shell/drag-files`, false);
		request.send();
		const dropped = JSON.parse(request.responseText) as Array<{ name: string; path: string }>;
		return dropped.find(entry => entry.name === file.name)?.path ?? "";
	} catch {
		return "";
	}
}

/**
 * A link to a `file:` URL is refused by Blink before the browser process hears of it (the page's origin is not local),
 * so Electron's `will-navigate` would never fire here. The shell is told, and the main process's listeners decide.
 */
document.addEventListener(
	"click",
	event => {
		const target = event.target;
		const anchor = target instanceof Element ? target.closest("a[href]") : null;
		if (!(anchor instanceof HTMLAnchorElement) || !/^file:/i.test(anchor.href)) return;
		event.preventDefault();
		void fetch(`${BASE}__shell/will-navigate`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ url: anchor.href }),
		}).catch(() => undefined);
	},
	true,
);

importLocalStorage();
void readEvents();

const shared = createOmpApi(shellTransport);
const api: OmpApi = { ...shared, fs: { ...shared.fs, pathForFile } };

(window as unknown as { omp: OmpApi }).omp = api;
