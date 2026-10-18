/**
 * `window.omp` for a paired web page: the shared `createOmpApi` over the socket transport, with the calls the
 * policy table (main/web/ipc-policy.ts, `mode: "web"`) says a phone answers differently put in front of it.
 *
 * What is overridden here is only what the page itself can do: the system calls that mean "the computer's
 * desktop" (open a link or a file, a save or open dialog, notify, the $EDITOR round trip, quit), the window
 * chrome pushes (badge, progress, theme color), the session handoff, and the channels a page makes itself
 * (`MENU_ACTION`, `DEEP_LINK`, `NOTIFICATION_CLICK`). Each override first asks the UI's registered hook
 * (host-hooks.ts: the sheets and the host folder browser) and otherwise does the plain browser thing. Every
 * other call goes to the host unchanged. A call never falls back to "local to the phone": a `device` argument
 * absent always means the host, as on the desktop (design §1.5).
 */

import { isDeviceLocalPref, overlayDevicePrefs, readDevicePref } from "../../shared/device-prefs";
import { IPC_COMMANDS, IPC_EVENTS, type IpcFsReadBinaryResult, type OmpApi } from "../../shared/ipc-types";
import { createOmpApi, type OmpTransport } from "../../shared/omp-api";
import { PREVIEW_SAVE_PDF, PREVIEW_STREAM_PDF } from "../../shared/preview";
import {
	WEB_DEVICE_CHANNELS,
	WEB_HOST_CHANNELS,
	type WebHostListing,
	type WebHostSaveResult,
	type WebModelsText,
	type WebModelsWriteResult,
} from "../../shared/web-host";
import type { WebChrome } from "./chrome";
import { type LocalChannels, parseOmpUrl } from "./deep-link";
import { base64ToBytes, type SaveOutcome } from "./download";
import {
	type EditorResult,
	type FileFilter,
	type HostActions,
	type OpenDialogOptions,
	webHostHooks,
} from "./host-hooks";
import type { FetchLike } from "./session";
import {
	acceptFromFilters,
	createPathForFile,
	holdsInlineImage,
	liftInlineImages,
	UploadFailed,
	type UploadFailure,
} from "./upload";

const C = IPC_COMMANDS;
const E = IPC_EVENTS;

/** Everything the shim needs from the page; tests pass fakes. */
export interface ShimEnv {
	transport: OmpTransport;
	fetch: FetchLike;
	chrome: WebChrome;
	channels: LocalChannels;
	/** Localized text for the browser fallbacks (`translate` of lib/i18n). */
	t: (key: string, params?: Record<string, string | number>) => string;
	browser: {
		/** `window.open(url, "_blank", "noopener,noreferrer")`. */
		open(url: string): void;
		confirm(message: string): boolean;
		prompt(message: string, initial: string): string | null;
	};
	/** A new tab for a session on this device (the tabs store's `openTab`). */
	openTab(payload: { cwd?: string; sessionPath?: string; device?: string }): Promise<string | null>;
	/** The session path `#/open?sessionPath=` named, once. */
	takePendingSessionPath(): string | null;
	/** The page's notification (toast or system notification). */
	notify(
		title: string,
		body: string | undefined,
		tabId: string | undefined,
		kind: "completion" | "error" | "ask" | undefined,
	): void;
	/** A toast for a problem the shim itself found (an upload refused). */
	toastError(message: string): void;
	/** Hand `blob` to the phone: the share sheet or a download (download.ts `saveBlob`). */
	save(name: string, blob: Blob): Promise<SaveOutcome>;
	/** A file picker on the phone (upload.ts `pickFiles`); empty when cancelled. */
	pickFiles(accept: string | undefined): Promise<File[]>;
	/** Where the shim sends uploads and reads blobs. */
	base?: string;
}

export interface WebOmp {
	api: OmpApi;
	host: HostActions;
	/** Raise a native-menu action on the page (the More sheet and the command palette call this). */
	emitMenuAction(action: string, payload?: Record<string, unknown>): void;
}

/** The wire form of `IpcFsReadBinaryResult`: bytes inline as base64 or behind a `/blob` URL. */
interface WireReadBinary extends Omit<IpcFsReadBinaryResult, "data"> {
	data?: Uint8Array;
	dataBase64?: string;
	blobUrl?: string;
}

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function createWebOmp(env: ShimEnv): WebOmp {
	const { transport } = env;
	const hooks = webHostHooks;
	const base = env.base ?? "";

	const host: HostActions = {
		openExternalOnComputer: url => transport.invoke<void>(C.SYSTEM_OPEN_EXTERNAL, url),
		openPathOnComputer: (path, tabId) => transport.invoke(C.SYSTEM_OPEN_PATH, path, tabId),
		revealPathOnComputer: (path, tabId) => transport.invoke(C.SYSTEM_REVEAL_PATH, path, tabId),
		editOnComputer: content => transport.invoke<EditorResult>(C.EDITOR_OPEN_EXTERNAL, { content }),
		openModelsConfigOnComputer: device => transport.invoke(C.MODELS_CONFIG_OPEN, device),
		listDirs: request => transport.invoke<WebHostListing>(WEB_HOST_CHANNELS.LIST_DIRS, request),
		saveToHost: request => transport.invoke<WebHostSaveResult>(WEB_HOST_CHANNELS.SAVE, request),
		modelsConfigRead: () => transport.invoke<WebModelsText>(WEB_HOST_CHANNELS.MODELS_CONFIG_READ),
		modelsConfigWrite: request =>
			transport.invoke<WebModelsWriteResult>(WEB_HOST_CHANNELS.MODELS_CONFIG_WRITE, request),
		downloadToPhone: (path, tabId) => viewOnPhone(path, tabId),
		saveBytesToPhone: (name, mime, base64) => saveImagePhone(name, mime, base64),
		pickPhoneFiles: filters => pickPhoneFiles(filters),
	};

	/** `FS_READ_BINARY`, with the bytes the page's viewers expect (`data: Uint8Array`). */
	async function readBinary(args: unknown[]): Promise<IpcFsReadBinaryResult> {
		const wire = await transport.invoke<WireReadBinary>(C.FS_READ_BINARY, ...args);
		const { dataBase64, blobUrl, ...rest } = wire;
		if (wire.data instanceof Uint8Array) return { ...rest, data: wire.data };
		if (typeof dataBase64 === "string") return { ...rest, data: base64ToBytes(dataBase64) };
		if (typeof blobUrl === "string" && wire.ok) {
			const response = await env.fetch(`${base}${blobUrl}`, { credentials: "same-origin" });
			if (!response.ok) return { ...rest, ok: false, data: new Uint8Array(), error: `blob ${response.status}` };
			return { ...rest, data: new Uint8Array(await response.arrayBuffer()) };
		}
		return { ...rest, data: new Uint8Array() };
	}

	async function viewOnPhone(path: string, tabId: string | undefined) {
		const result = await readBinary([{ path, tabId }]);
		if (!result.ok) return { ok: false, error: result.error ?? "The file could not be read", code: result.code };
		const name = path.split(/[\\/]/).pop() ?? "file";
		await env.save(name, new Blob([result.data as Uint8Array<ArrayBuffer>], { type: result.mime }));
		return { ok: true };
	}

	function hostPath(message: string, initial: string): string | null {
		const answer = env.browser.prompt(message, initial)?.trim();
		return answer ? answer : null;
	}

	async function saveImagePhone(name: string, mime: string, base64: string) {
		try {
			const outcome = await env.save(name, new Blob([base64ToBytes(base64)], { type: mime }));
			return { saved: outcome !== "cancelled" };
		} catch (error) {
			return { saved: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Files picked on this device, uploaded to the computer: their host paths, or null when none. */
	async function pickPhoneFiles(filters: FileFilter[] | undefined): Promise<string[] | null> {
		const files = await env.pickFiles(acceptFromFilters(filters));
		if (files.length === 0) return null;
		const uploaded = await Promise.all(
			files.map(file =>
				pathForFile(file).catch((error: Error) => {
					env.toastError(error.message);
					return "";
				}),
			),
		);
		const paths = uploaded.filter(path => path.length > 0);
		return paths.length > 0 ? paths : null;
	}

	const failureText: Record<UploadFailure, string> = {
		"too-large": "web.upload.tooLarge",
		refused: "web.upload.refused",
		network: "web.upload.network",
	};
	const uploadOnce = createPathForFile({ fetch: env.fetch, base });
	/** `fs.pathForFile`: the host path of the file's upload; rejects with why it was not sent, in words. */
	const pathForFile = (file: File): Promise<string> =>
		uploadOnce(file).catch((error: unknown) => {
			const failure = error instanceof UploadFailed ? error.failure : "network";
			throw new Error(env.t(failureText[failure], { name: file.name }));
		});

	/** Why a call's picture did not reach the computer (the call is not sent then). */
	const imageFailureText: Record<UploadFailure, string> = {
		"too-large": "web.upload.imageTooLarge",
		refused: "web.upload.imageRefused",
		network: "web.upload.imageNetwork",
	};
	/** `args` with their inline pictures uploaded first (upload.ts `liftInlineImages`); rejects with the reason. */
	async function withImagesUploaded(args: unknown[]): Promise<unknown[]> {
		try {
			return await liftInlineImages(args, { fetch: env.fetch, base });
		} catch (error) {
			throw new Error(env.t(imageFailureText[error instanceof UploadFailed ? error.failure : "network"]));
		}
	}

	/**
	 * This device's own appearance and layout prefs (shared/device-prefs.ts) live in its `uiPrefs` record on the
	 * host, never in the host's prefs: reads overlay them on the host's, writes of those keys go only to the
	 * record (one at a time, each from the latest copy), and the host's `PREFS_CHANGED` for them is dropped.
	 */
	let devicePrefs: Record<string, unknown> | null = null;
	let devicePrefsWrites: Promise<unknown> = Promise.resolve();

	async function loadDevicePrefs(): Promise<Record<string, unknown>> {
		const stored = await transport.invoke<Record<string, unknown> | null>(WEB_DEVICE_CHANNELS.UI_PREFS_GET);
		devicePrefs = stored && typeof stored === "object" ? stored : {};
		return devicePrefs;
	}

	/** The member of a `{key, value}` payload, read without trusting its shape. */
	function payloadField(payload: unknown, field: "key" | "value"): unknown {
		return typeof payload === "object" && payload !== null ? Reflect.get(payload, field) : undefined;
	}

	async function getPrefs(payload: unknown, ...rest: unknown[]): Promise<unknown> {
		const key = payloadField(payload, "key");
		if (typeof key === "string" && key !== "" && !isDeviceLocalPref(key)) {
			return transport.invoke(C.PREFS_GET, payload, ...rest);
		}
		// A whole-store read (the page's start-up) refreshes the copy; a keyed one uses it.
		const wholeStore = typeof key !== "string" || key === "";
		const device = wholeStore || devicePrefs === null ? await loadDevicePrefs() : devicePrefs;
		if (!wholeStore) return readDevicePref(device, key);
		return overlayDevicePrefs(await transport.invoke(C.PREFS_GET, payload, ...rest), device);
	}

	function setPrefs(payload: unknown, ...rest: unknown[]): Promise<unknown> {
		const key = payloadField(payload, "key");
		if (typeof key !== "string" || !isDeviceLocalPref(key)) return transport.invoke(C.PREFS_SET, payload, ...rest);
		const value = payloadField(payload, "value");
		const write = devicePrefsWrites.then(async () => {
			const current = devicePrefs ?? (await loadDevicePrefs());
			const next = { ...current };
			if (value === undefined) delete next[key];
			else next[key] = value;
			await transport.invoke(WEB_DEVICE_CHANNELS.UI_PREFS_SET, next);
			devicePrefs = next;
		});
		devicePrefsWrites = write.catch(() => undefined);
		return write;
	}

	const hostPrefsChanged = (listener: (payload: unknown) => void) => (payload: unknown) => {
		const key = payloadField(payload, "key");
		if (typeof key === "string" && isDeviceLocalPref(key)) return;
		listener(payload);
	};

	const invokeOverrides: Record<string, (...args: unknown[]) => Promise<unknown>> = {
		[C.SYSTEM_OPEN_EXTERNAL]: async (url: unknown) => {
			if (typeof url !== "string") throw new Error("A link is required");
			const link = parseOmpUrl(url);
			if (link) {
				env.channels.emit(E.DEEP_LINK, link);
				return;
			}
			const open = hooks().openExternal;
			if (open) return open(url);
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new Error("Not a link");
			}
			if (!EXTERNAL_SCHEMES.has(parsed.protocol)) throw new Error("Only web and mail links open from here");
			env.browser.open(parsed.href);
		},
		[C.SYSTEM_OPEN_PATH]: (path: unknown, tabId: unknown) => {
			const target = String(path);
			const tab = typeof tabId === "string" ? tabId : undefined;
			const open = hooks().openPath;
			return open ? open(target, tab, host) : viewOnPhone(target, tab);
		},
		[C.SYSTEM_REVEAL_PATH]: (path: unknown, tabId: unknown) => {
			const target = String(path);
			const tab = typeof tabId === "string" ? tabId : undefined;
			const reveal = hooks().revealPath;
			return reveal ? reveal(target, tab, host) : host.revealPathOnComputer(target, tab);
		},
		[C.SYSTEM_SAVE_DIALOG]: async (defaultPath: unknown, filters: unknown) => {
			const initial = typeof defaultPath === "string" ? defaultPath : undefined;
			const pick = hooks().showSaveDialog;
			if (pick) return pick(initial, filters as FileFilter[] | undefined, host);
			return hostPath(env.t("web.hostPath.save"), initial ?? "");
		},
		[C.SYSTEM_SAVE_IMAGE]: (name: unknown, mime: unknown, data: unknown) => {
			const save = hooks().saveImage;
			return save
				? save(String(name), String(mime), String(data), host)
				: saveImagePhone(String(name), String(mime), String(data));
		},
		[C.SYSTEM_OPEN_DIALOG]: async (filters: unknown, options: unknown) => {
			const list = filters as FileFilter[] | undefined;
			const opts = options as OpenDialogOptions | undefined;
			const pick = hooks().showOpenDialog;
			if (pick) return pick(list, opts, host);
			if (opts?.directory) {
				const chosen = hostPath(opts.title ?? env.t("web.hostPath.folder"), "");
				return chosen ? [chosen] : null;
			}
			return pickPhoneFiles(list);
		},
		[C.SYSTEM_NOTIFY]: async (payload: unknown) => {
			const { title, body, tabId, kind } = payload as {
				title: string;
				body?: string;
				tabId?: string;
				kind?: "completion" | "error" | "ask";
			};
			if (hooks().notify?.(title, body, tabId, kind)) return;
			env.notify(title, body, tabId, kind);
		},
		[C.EDITOR_OPEN_EXTERNAL]: (payload: unknown) => {
			const content = (payload as { content?: string } | undefined)?.content ?? "";
			const open = hooks().openEditor;
			return open ? open(content, host) : Promise.resolve({ ok: false, unavailable: true, text: null });
		},
		[C.MODELS_CONFIG_OPEN]: async (device: unknown) => {
			const open = hooks().openModelsConfig;
			if (!open || typeof device === "string") return host.openModelsConfigOnComputer(device as string | undefined);
			return open(host);
		},
		[C.SIDECAR_SELECT_PROJECT]: async () => {
			const pick = hooks().selectProject;
			if (pick) return pick(host);
			return hostPath(env.t("web.hostPath.project"), "");
		},
		[C.SESSION_OPEN_NEW_WINDOW]: async (payload: unknown) => {
			const { sessionPath, cwd, device } = (payload ?? {}) as {
				sessionPath?: string;
				cwd?: string;
				device?: string;
			};
			return (await env.openTab({ sessionPath, cwd, device })) !== null;
		},
		[C.SESSION_CONSUME_PENDING]: async () => env.takePendingSessionPath(),
		[C.UPDATER_APPLY]: async () => {
			const confirm = hooks().confirmUpdateApply;
			const confirmed = confirm ? await confirm() : env.browser.confirm(env.t("web.update.confirm"));
			return confirmed ? transport.invoke(C.UPDATER_APPLY) : undefined;
		},
		[C.FS_READ_BINARY]: (...args: unknown[]) => readBinary(args),
		// The phone's page prints on the computer; the PDF comes back as bytes and is kept on this device.
		[PREVIEW_SAVE_PDF]: async () => {
			const { name, base64 } = await transport.invoke<{ name: string; base64: string }>(PREVIEW_STREAM_PDF);
			const outcome = await env.save(name, new Blob([base64ToBytes(base64)], { type: "application/pdf" }));
			return outcome === "cancelled" ? null : name;
		},
		[C.PREFS_GET]: getPrefs,
		[C.PREFS_SET]: setPrefs,
	};

	const sendOverrides: Record<string, (...args: unknown[]) => void> = {
		[C.APP_QUIT]: () => {
			void (async () => {
				const confirm = hooks().confirmQuit;
				const confirmed = confirm ? await confirm() : env.browser.confirm(env.t("web.quit.confirm"));
				if (confirmed) transport.send(C.APP_QUIT);
			})();
		},
		// The phone's own link says nothing about the host's connectivity; the page shows its own reconnect banner.
		[C.CONNECTIVITY_REPORT]: () => undefined,
		[E.TRAY_STATE_PUSH]: (state: unknown) => env.chrome.applyTray(state as Parameters<WebChrome["applyTray"]>[0]),
		[E.PROGRESS_SET]: (state: unknown) => {
			const progress = state as "working" | "waiting" | "idle";
			const hook = hooks().progress;
			if (hook) hook(progress);
			else env.chrome.applyProgress(progress);
		},
		[E.WINDOW_CHROME_SET]: (colors: unknown) =>
			env.chrome.applyColors(colors as Parameters<WebChrome["applyColors"]>[0]),
	};

	const pageChannels: readonly string[] = [E.MENU_ACTION, E.DEEP_LINK, E.NOTIFICATION_CLICK];

	const shimTransport: OmpTransport = {
		invoke: <T>(channel: string, ...args: unknown[]) => {
			const override = invokeOverrides[channel];
			if (override) return override(...args) as Promise<T>;
			// A photo is larger than a frame may be: it goes by upload, and the call names the host's copy.
			if (holdsInlineImage(args)) {
				return withImagesUploaded(args).then(lifted => transport.invoke<T>(channel, ...lifted));
			}
			return transport.invoke<T>(channel, ...args);
		},
		send: (channel, ...args) => {
			const override = sendOverrides[channel];
			if (override) override(...args);
			else if (holdsInlineImage(args)) {
				void withImagesUploaded(args).then(
					lifted => transport.send(channel, ...lifted),
					(error: Error) => env.toastError(error.message),
				);
			} else transport.send(channel, ...args);
		},
		on: (channel, listener) =>
			channel === E.PREFS_CHANGED
				? transport.on(channel, hostPrefsChanged(listener))
				: pageChannels.includes(channel)
					? env.channels.on(channel, listener)
					: transport.on(channel, listener),
	};

	const shared = createOmpApi(shimTransport);
	const api: OmpApi = { ...shared, fs: { ...shared.fs, pathForFile } };

	return {
		api,
		host,
		emitMenuAction: (action, payload) => env.channels.emit(E.MENU_ACTION, { action, ...payload }),
	};
}
