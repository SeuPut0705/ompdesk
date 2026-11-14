/**
 * `boot.*` (native/ompdesk/crates/shell/PROTOCOL.md §15.9, batch SX5): what main's start wired to Electron, now the
 * shell's. `omp-media://` streams (the shell serves the file; Node only registers it and, for a paired device's page,
 * streams the shell's reads into a `Response`), keep-awake's blockers (the shell also holds the lid of a charging laptop
 * while one is held, `boot_core::lid`), the power and network events main reacts to, the app's theme over the OS's,
 * the global shortcut, the resolver the reachability probe asks, and main's text: the shell's table
 * (`boot_core/main-text.json`) and UI language, mirrored here for `mainT`.
 */
import type mainText from "../../../../native/ompdesk/crates/shell/src/boot_core/main-text.json";
import { fillText } from "../../../shared/fill-text";
import { deviceLanguageTag } from "../../../shared/reply-language";
import type { UiLanguage } from "../../../shared/ui-language";
import type { OmpFailure } from "../../omp-runtime";
import type { KeepAwakeBlocker } from "../../remote/keep-awake";
import type { HostClient } from "../electron/host";
import { type ModuleClient, shellHost, shellModule } from "./client";

type None = Record<string, never>;

/** A key of main's text table (`MAIN_TEXT`'s, and `TRAY_LABELS`'s as `tray.<key>`). */
export type MainTextKey = keyof typeof mainText;
export type MainLanguage = UiLanguage;
/** The table as the shell pushes it: every key in both languages, placeholders unfilled. */
export type MainTextTable = Record<string, Record<MainLanguage, string>>;

/** What `omp-media://` answers for a request (`boot_core::media::answer`): the body is `length` bytes from `start`. */
export interface MediaHead {
	status: number;
	headers: [string, string][];
	start: number;
	length: number;
}

export type BootSpec = {
	calls: {
		mediaOpen: { params: { path: string; mime: string; owner: number }; result: { url: string } };
		mediaHead: { params: { url: string; method?: string; range?: string }; result: MediaHead };
		mediaRead: { params: { url: string; offset: number; length: number }; result: None };
		awakeState: { params: None; result: { held: boolean; lidHeld: boolean } };
		resolveHost: {
			/** `disallowed`: the OS resolver, never Chromium's host cache (a dead DNS after a wake shows). */
			params: { host: string; cacheUsage?: "allowed" | "staleAllowed" | "disallowed" };
			result: { endpoints: { address: string; family: "ipv4" | "ipv6" }[] };
		};
		registerShortcut: { params: { accelerator: string }; result: { registered: boolean } };
		/** Answered once the shell applied it and pushed `theme.changed`, so the shim's `nativeTheme` already agrees. */
		themeSource: { params: { source: "system" | "light" | "dark" }; result: None };
		/** The person changed the `language` pref (`null`: cleared, the locale decides); answered after `labels`. */
		language: { params: { language: string | null }; result: None };
	};
	posts: {
		mediaRelease: { url: string; owner: number };
		mediaReleaseOwner: { owner: number };
		awakeStart: { id: number; label: string };
		awakeStop: { id: number };
	};
	events: {
		power: { name: "suspend" | "resume" | "lock-screen" | "unlock-screen" | "on-ac" | "on-battery" | "shutdown" };
		online: { online: boolean };
		shortcut: { accelerator: string };
		/** The UI language, the whole table and the locale it was chosen from; once before `app.ready`, then after
		 * every language change. */
		labels: Labels;
	};
	asks: None;
};

export type BootClient = ModuleClient<BootSpec>;

export function bootModule(host: () => HostClient = shellHost): BootClient {
	return shellModule<BootSpec>("boot", host);
}

/** The most one `boot.mediaRead` asks for. */
const READ_CHUNK = 256 * 1024;

/**
 * A request for an `omp-media://` stream as the shell answers it, for a paired device's `/blob` URL: the head from the
 * shell, the body pulled from it chunk by chunk, so a paused player stops the disk read.
 */
export async function mediaResponse(boot: BootClient, url: string, range: string | undefined): Promise<Response> {
	const head = await boot.call("mediaHead", { url, ...(range === undefined ? {} : { range }) });
	const headers = new Headers(head.headers);
	if (head.length === 0) return new Response(null, { status: head.status, headers });
	let offset = head.start;
	const end = head.start + head.length;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const answer = await boot.request("mediaRead", { url, offset, length: Math.min(READ_CHUNK, end - offset) });
			const bytes = answer.bin ?? new Uint8Array();
			if (bytes.length === 0) {
				controller.close();
				return;
			}
			offset += bytes.length;
			controller.enqueue(new Uint8Array(bytes));
			if (offset >= end) controller.close();
		},
	});
	return new Response(body, { status: head.status, headers });
}

let nextBlocker = 1;

/**
 * Electron's `powerSaveBlocker` `prevent-app-suspension` as keep-awake holds it (`KeepAwakePolicy`): the shell holds
 * the idle-sleep blocker and, while any is held, the lid of a laptop on AC. `label` (`work`, `host`) names whose hold
 * it is. Ids are this process's, so two blockers never share one.
 */
export function awakeBlocker(boot: BootClient, label: string, warn: (message: string) => void): KeepAwakeBlocker {
	return {
		start() {
			const id = nextBlocker++;
			boot.post("awakeStart", { id, label }).catch(error => warn(`boot.awakeStart: ${String(error)}`));
			return id;
		},
		stop(id) {
			boot.post("awakeStop", { id }).catch(error => warn(`boot.awakeStop: ${String(error)}`));
		},
	};
}

/**
 * Chromium's link state (`net.isOnline()`), mirrored from the shell's `boot.online` events; the first one arrives
 * before `app.ready`. Until then it reads online, so a launch never starts as if offline.
 */
export function onlineMirror(boot: BootClient): { isOnline(): boolean } {
	let online = true;
	boot.on("online", data => {
		online = data.online;
	});
	return { isOnline: () => online };
}

/** What `boot.labels` carries. */
export interface Labels {
	language: MainLanguage;
	text: MainTextTable;
	/** Chromium's locale (`app.getLocale()`) and the system's preferred languages, from the shell's facts. */
	appLocale: string;
	preferredLanguages: string[];
}

/** The shell's latest `boot.labels`. */
let labels: Labels | null = null;

/** `key`'s template in `language`, placeholders unfilled, for a caller with its own fill rule; the key itself before
 * the shell's table came. */
export function mainTemplate(key: MainTextKey, language: MainLanguage = getMainLanguage()): string {
	return labels?.text[key]?.[language] ?? key;
}

/** Mirrors the shell's text from now on; call before `app.init` goes out (the first table comes before `app.ready`). */
export function mirrorLabels(boot: BootClient): void {
	boot.on("labels", data => {
		labels = data;
	});
}

/** Tests: main's text as the shell would push it, without a shell. */
export function seedLabels(language: MainLanguage, text: MainTextTable): void {
	labels = { language, text, appLocale: "en-US", preferredLanguages: ["en-US"] };
}

/** The device language as a BCP 47 subtag (`ko`, `zh-Hant`): not the UI one, which ships only en/ko. */
export function deviceLanguage(): string | undefined {
	return labels ? deviceLanguageTag(labels.preferredLanguages, labels.appLocale) : undefined;
}

/** The UI language: the person's `language` pref, else the app locale (the shell decides; English before it said). */
export function getMainLanguage(): MainLanguage {
	return labels?.language ?? "en";
}

/** `key` in `language`, its `{name}` placeholders filled (`fillText`). The key itself before the shell's table came. */
export function mainT(
	key: MainTextKey,
	language: MainLanguage = getMainLanguage(),
	params?: Record<string, string | number>,
): string {
	return fillText(mainTemplate(key, language), params);
}

/** User-facing text for why the system omp is unusable, in the UI language. */
export function ompFailureText(reason: OmpFailure, language = getMainLanguage()): string {
	switch (reason.kind) {
		case "not-found":
			return mainT("omp.notFound", language);
		case "override-missing":
			return mainT("omp.overrideMissing", language, { path: reason.path });
		case "cannot-run":
			return mainT("omp.cannotRun", language, { bin: reason.bin, detail: reason.detail });
		case "too-old":
			return mainT("omp.tooOld", language, { version: reason.version, minimum: reason.minimum });
		case "compiled":
			return mainT("omp.compiled", language, { bin: reason.bin });
		case "bun-too-old":
			return mainT("omp.bunTooOld", language, {
				bin: reason.bin,
				bun: reason.bun,
				bunVersion: reason.bunVersion,
				minimum: reason.minimum,
			});
	}
}
