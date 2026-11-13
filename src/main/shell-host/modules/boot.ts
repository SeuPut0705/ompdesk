/**
 * `boot.*` (native/ompdesk/crates/shell/PROTOCOL.md §15.9, batch SX5): what main's start wired to Electron, now the
 * shell's. `omp-media://` streams (the shell serves the file; Node only registers it and, for a paired device's page,
 * streams the shell's reads into a `Response`), keep-awake's blockers (the shell also holds the lid of a charging laptop
 * while one is held, `boot_core::lid`), the power and network events main reacts to, the app's theme over the OS's,
 * the global shortcut and the resolver the reachability probe asks.
 */
import type { KeepAwakeBlocker } from "../../remote/keep-awake";
import type { HostClient } from "../electron/host";
import { type ModuleClient, shellHost, shellModule } from "./client";

type None = Record<string, never>;

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
