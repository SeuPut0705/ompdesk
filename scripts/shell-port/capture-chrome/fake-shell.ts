/**
 * The shell's end for the chrome capture (PROTOCOL.md §15.3): a real `electron` shim (`createElectron`) over an
 * in-memory connection whose other end records every frame Node sends and answers what a step teaches it. Each area
 * of `capture-chrome.ts` drives the TypeScript under capture through its public functions and records these frames.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Answered, ShellClient } from "../../../src/main/shell-host/client";
import { duplexPair } from "../../../src/main/shell-host/duplex-pair";
import { createElectron, type ElectronShim } from "../../../src/main/shell-host/electron/create";
import type { HostFacts } from "../../../src/main/shell-host/facts";
import { use } from "./electron-module";

export interface Frame {
	kind: "call" | "event";
	method: string;
	params: unknown;
}

export interface FakeShell {
	electron: ElectronShim;
	/** Every frame Node sent, in order. */
	frames: Frame[];
	/** Frames sent since the last `take()`, then forgets them. */
	take(): Frame[];
	/** Teaches the answer to a Node → shell request. */
	answer(method: string, fn: (params: Record<string, unknown>, bin?: Buffer) => unknown): void;
	/** A shell → Node event. */
	emit(name: string, data?: unknown): Promise<void>;
	/** A shell → Node request; resolves with Node's answer. */
	ask(method: string, params?: unknown): Promise<unknown>;
	settle(): Promise<void>;
	userData: string;
	close(): void;
}

const NODE_REQUESTS = [
	"app.init",
	"app.setAsDefaultProtocolClient",
	"app.getGPUInfo",
	"app.focus",
	"app.hide",
	"app.setBadge",
	"app.showAboutPanel",
	"win.create",
	"win.op",
	"wc.op",
	"dialog.messageBox",
	"notification.show",
	"notification.close",
	"shell.openExternal",
	"theme.setSource",
];
const NODE_EVENTS = ["app.exit", "app.relaunch", "wc.send"];

export function facts(userData: string, platform: NodeJS.Platform = process.platform): HostFacts {
	const root = platform === "win32" ? "C:/app" : "/Applications/OMPdesk.app/Contents";
	return {
		paths: {
			userData,
			appData: join(userData, ".."),
			sessionData: userData,
			home: tmpdir(),
			temp: tmpdir(),
			exe: `${root}/OMPdesk`,
			module: `${root}/OMPdesk`,
			desktop: tmpdir(),
			documents: tmpdir(),
			downloads: tmpdir(),
			music: tmpdir(),
			pictures: tmpdir(),
			videos: tmpdir(),
			logs: join(userData, "logs"),
			crashDumps: join(userData, "Crashpad"),
		},
		exe: `${root}/OMPdesk`,
		resourcesPath: `${root}/Resources`,
		appPath: `${root}/Resources/app`,
		isPackaged: true,
		argv: [`${root}/OMPdesk`],
		locale: { appLocale: "en-US", systemLocale: "en-US", preferredLanguages: ["en-US"] },
		displays: [
			{
				id: 1,
				label: "main",
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
				workArea: { x: 0, y: 25, width: 1920, height: 1055 },
				scaleFactor: 2,
				rotation: 0,
				internal: true,
				colorDepth: 24,
			},
		],
		primaryDisplayId: 1,
		theme: { dark: false, highContrast: false, inverted: false },
		system: { reducedMotion: false, onBattery: false, online: true },
		versions: { chrome: "156.0.1", cef: "156.0.26", shell: "0.1.0" },
		safeStorage: { unavailable: "capture" },
	};
}

let firstUserData: string | null = null;

/**
 * The profile of the first fake shell: module top levels that open a store while they load (i18n.ts' `prefs`) keep its
 * path for the rest of the run, so a capture that sets such a preference writes it here.
 */
export function bootUserData(): string {
	if (!firstUserData) throw new Error("no fake shell was made yet");
	return firstUserData;
}

export async function fakeShell(options: { platform?: NodeJS.Platform; ready?: boolean } = {}): Promise<FakeShell> {
	const userData = mkdtempSync(join(tmpdir(), "ompdesk-capture-chrome-"));
	firstUserData ??= userData;
	const [a, b] = duplexPair();
	const node = new ShellClient(a);
	const shell = new ShellClient(b);
	const frames: Frame[] = [];
	let taken = 0;
	const answers = new Map<string, (params: Record<string, unknown>, bin?: Buffer) => unknown>();
	for (const method of NODE_REQUESTS) {
		shell.handle(method, (params: Record<string, unknown>, { bin }) => {
			frames.push({ kind: "call", method, params });
			const answer = answers.get(method)?.(params, bin);
			return answer instanceof Answered ? answer : (answer ?? {});
		});
	}
	for (const name of NODE_EVENTS) {
		shell.on(name, (data: unknown) => {
			frames.push({ kind: "event", method: name, params: data });
		});
	}
	const electron = createElectron(node, facts(userData, options.platform), { exitProcess: () => {} });
	use(electron);
	const settle = async (): Promise<void> => {
		for (let turn = 0; turn < 5; turn += 1) await setImmediate();
	};
	if (options.ready !== false) {
		await settle();
		await shell.event("app.ready");
		await electron.app.whenReady();
		await settle();
	}
	return {
		electron,
		frames,
		take: () => {
			const out = frames.slice(taken);
			taken = frames.length;
			return out;
		},
		answer: (method, fn) => answers.set(method, fn),
		emit: async (name, data = {}) => {
			await shell.event(name, data);
			await settle();
		},
		ask: (method, params = {}) => shell.call(method, params),
		settle,
		userData,
		close: () => {
			node.close();
			shell.close();
		},
	};
}
