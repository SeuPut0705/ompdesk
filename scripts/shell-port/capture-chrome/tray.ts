/**
 * The tray area (`src/main/tray.ts` and the menu functions of `tray-labels.ts`): the pure rules row by row (the update
 * item for each updater state, the menu, its signature, the tooltip) and `createTray` driven over the fake shell (what
 * its icon, tooltip and menu look like as the renderer's state, the windows and the open menu change).
 */
import { MAIN_TEXT } from "../../../src/main/i18n-text";
import { createTray, destroyTray, setTrayState } from "../../../src/main/tray";
import {
	menuSignature,
	statusLabel,
	TRAY_LABELS,
	type TrayMenuActions,
	trayMenuTemplate,
	trayTooltip,
	trayUpdateItem,
} from "../../../src/main/tray-labels";
import type { TrayState, UpdateStatus } from "../../../src/shared/ipc-types";
import type { Step } from "../capture-chrome";
import { type FakeShell, fakeShell } from "./fake-shell";

const LANGUAGES = ["en", "ko"] as const;
const STATUSES = ["idle", "streaming", "question", "approval", "childWaiting", "error"] as const;

const UPDATES: UpdateStatus[] = [
	{ state: "idle" },
	{ state: "auth-required", reason: "missing" },
	{ state: "auth-required", reason: "denied" },
	{ state: "checking" },
	{ state: "available", version: "1.2.3", mode: "automatic" },
	{ state: "available", version: "1.2.3", mode: "manual" },
	{ state: "available", version: "1.2.3", mode: "relaunch" },
	{ state: "downloading", version: "1.2.3", mode: "relaunch", percent: 42 },
	{ state: "downloading", version: "1.2.3", mode: "automatic", percent: 0 },
	{ state: "downloading", version: "1.2.3", mode: "manual", percent: 99.5 },
	{ state: "downloaded", version: "1.2.3", mode: "relaunch" },
	{ state: "downloaded", version: "1.2.3", mode: "manual" },
	{ state: "downloaded", version: "1.2.3", mode: "automatic", restartAt: 5 },
	{ state: "downloaded", version: "1.2.3", mode: "automatic", installing: true },
	{ state: "downloaded", version: "1.2.3", mode: "manual", installing: true },
	{ state: "not-available", version: "1.0.0" },
	{ state: "error", message: "x" },
	{ state: "error", message: "y", detail: "boom", showInBanner: true },
];

const PROJECTS = ["alpha", "", "한글 프로젝트", "a · b — c", "{status}"];

function pure(): Step[] {
	const steps: Step[] = [];
	const labels = Object.fromEntries(
		LANGUAGES.map(language => [
			language,
			{
				...Object.fromEntries(Object.entries(MAIN_TEXT).map(([key, value]) => [key, value[language]])),
				...Object.fromEntries(Object.entries(TRAY_LABELS).map(([key, value]) => [`tray.${key}`, value[language]])),
			},
		]),
	);
	steps.push({ fn: "src/main/tray-labels.ts#labels", input: {}, output: labels });
	for (const lang of LANGUAGES) {
		for (const status of STATUSES) {
			steps.push({
				fn: "src/main/tray-labels.ts#statusLabel",
				input: { lang, status },
				output: statusLabel(lang, status),
			});
		}
		for (const update of UPDATES) {
			for (const upToDateShown of [true, false]) {
				steps.push({
					fn: "src/main/tray-labels.ts#trayUpdateItem",
					input: { lang, status: update, upToDateShown },
					output: trayUpdateItem(lang, update, upToDateShown),
				});
			}
		}
		for (const windowVisible of [true, false]) {
			for (const update of UPDATES) {
				const input = { lang, windowVisible, update: trayUpdateItem(lang, update, true) };
				const clicks: string[] = [];
				const actions: TrayMenuActions = {
					toggleWindow: () => clicks.push("toggleWindow"),
					update: action => clicks.push(`update:${action}`),
					quit: () => clicks.push("quit"),
				};
				const template = trayMenuTemplate(input, actions);
				const pressed = template.map(item => {
					clicks.length = 0;
					(item.click as (() => void) | undefined)?.();
					return [...clicks];
				});
				steps.push({
					fn: "src/main/tray-labels.ts#trayMenuTemplate",
					input,
					output: {
						items: template.map(item => ({
							label: item.label ?? null,
							type: item.type ?? "normal",
							enabled: item.enabled ?? true,
						})),
						pressed,
					},
				});
				steps.push({ fn: "src/main/tray-labels.ts#menuSignature", input, output: menuSignature(input) });
			}
		}
		for (const status of STATUSES) {
			for (const projectName of PROJECTS) {
				const state: TrayState = { status, language: lang, projectName };
				steps.push({ fn: "src/main/tray-labels.ts#trayTooltip", input: state, output: trayTooltip(state) });
			}
		}
	}
	steps.push({ fn: "src/main/tray-labels.ts#trayTooltip", input: null, output: trayTooltip(null) });
	return steps;
}

/** The frames a tray event sent, as the facts a person can see. */
function seen(frames: { kind: string; method: string; params: unknown }[]): unknown[] {
	const out: unknown[] = [];
	for (const frame of frames) {
		const params = frame.params as Record<string, unknown>;
		if (frame.method === "tray.create") {
			const images = params.images as { scaleFactor: number; dataURL: string }[];
			out.push({
				create: { scales: images.map(i => i.scaleFactor), template: params.template, tooltip: params.tooltip },
			});
		} else if (frame.method === "tray.op") {
			const args = params.args as Record<string, unknown>;
			if (params.op === "setToolTip") out.push({ tooltip: args.text });
			else if (params.op === "setContextMenu")
				out.push({
					menu: (args.template as { label: string; type: string; enabled: boolean }[]).map(i => ({
						label: i.label,
						type: i.type,
						enabled: i.enabled,
					})),
				});
			else out.push({ op: params.op });
		} else if (frame.method === "win.op") {
			out.push({ window: params.op });
		}
	}
	return out;
}

type Event =
	| { kind: "state"; state: TrayState }
	| { kind: "visible"; visible: boolean }
	| { kind: "menuOpen" }
	| { kind: "menuClose" }
	| { kind: "click" }
	| { kind: "press"; index: number };

const STATE = (status: TrayState["status"], language: TrayState["language"], projectName: string): Event => ({
	kind: "state",
	state: { status, language, projectName },
});

/** `createTray` and then each event in turn: what the tray showed after it. */
const SCRIPTS: Record<string, { window: boolean; events: Event[] }> = {
	follows: {
		window: true,
		events: [
			STATE("idle", "en", "alpha"),
			STATE("streaming", "en", "alpha"),
			STATE("streaming", "en", "beta"),
			STATE("error", "ko", "beta"),
			STATE("error", "ko", "beta"),
			{ kind: "visible", visible: true },
			{ kind: "visible", visible: false },
			{ kind: "visible", visible: false },
			{ kind: "visible", visible: true },
			STATE("idle", "en", "alpha"),
		],
	},
	open: {
		window: true,
		events: [
			{ kind: "visible", visible: true },
			{ kind: "menuOpen" },
			{ kind: "visible", visible: false },
			STATE("idle", "ko", "alpha"),
			STATE("streaming", "ko", "alpha"),
			{ kind: "menuClose" },
			{ kind: "menuOpen" },
			{ kind: "menuClose" },
		],
	},
	noWindow: {
		window: false,
		events: [STATE("approval", "en", "alpha"), { kind: "click" }, { kind: "press", index: 0 }],
	},
	press: {
		window: true,
		events: [
			{ kind: "press", index: 0 },
			{ kind: "visible", visible: true },
			{ kind: "press", index: 0 },
			{ kind: "click" },
			{ kind: "visible", visible: false },
			{ kind: "click" },
		],
	},
};

async function scenarios(): Promise<Step[]> {
	const steps: Step[] = [];
	for (const [name, script] of Object.entries(SCRIPTS)) {
		{
			const shell: FakeShell = await fakeShell();
			const { BrowserWindow } = shell.electron;
			let target: InstanceType<typeof BrowserWindow> | undefined;
			if (script.window) {
				target = new BrowserWindow({ show: false });
				await shell.settle();
				await shell.emit("win.state", { winId: target.id, visible: false });
			}
			const spawned: (string | null)[] = [];
			const manager = { getTargetWindow: () => target };
			shell.take();
			createTray(
				manager as never,
				((cwd?: string) => {
					spawned.push(cwd ?? null);
					return undefined;
				}) as never,
			);
			await shell.settle();
			let frames = shell.take();
			steps.push({
				fn: "src/main/tray.ts#createTray",
				input: { script: name, platform: process.platform },
				output: { seen: seen(frames), spawned: [...spawned] },
			});
			let trayId = 0;
			let menuId = 0;
			let itemIds: string[] = [];
			const learn = (list: typeof frames) => {
				for (const frame of list) {
					const params = frame.params as Record<string, unknown>;
					if (frame.method === "tray.create") trayId = params.trayId as number;
					if (frame.method === "tray.op" && params.op === "setContextMenu") {
						const args = params.args as { menuId: number; template: { id: string }[] };
						menuId = args.menuId;
						itemIds = args.template.map(item => item.id);
					}
				}
			};
			learn(frames);
			for (const event of script.events) {
				spawned.length = 0;
				if (event.kind === "state") setTrayState(event.state);
				else if (event.kind === "visible" && target) {
					await shell.emit("win.state", { winId: target.id, visible: event.visible });
					await shell.emit("win.event", { winId: target.id, name: event.visible ? "show" : "hide", args: [] });
				} else if (event.kind === "menuOpen") await shell.emit("menu.event", { menuId, name: "will-show" });
				else if (event.kind === "menuClose") await shell.emit("menu.event", { menuId, name: "will-close" });
				else if (event.kind === "click") await shell.emit("tray.event", { trayId, name: "click" });
				else if (event.kind === "press") await shell.emit("menu.click", { menuId, itemId: itemIds[event.index] });
				await shell.settle();
				frames = shell.take();
				learn(frames);
				steps.push({
					fn: "src/main/tray.ts#event",
					input: { script: name, event },
					output: { seen: seen(frames), spawned: [...spawned] },
				});
			}
			destroyTray();
			shell.close();
		}
	}
	return steps;
}

export async function capture(): Promise<Step[]> {
	return [...pure(), ...(await scenarios())];
}
