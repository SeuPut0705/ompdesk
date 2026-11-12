/**
 * JS dialogs of a viewer's offscreen page. A page without a window to show `alert`, `confirm` and `prompt` on stays
 * blocked in them for good, and CDP's `Page.javascriptDialogOpening` needs a debugger on the page, which would turn
 * the `choose` gate off (C143). So the viewers' two sessions carry one fixed script that does nothing but replace
 * those three functions in the page's main world, before any page script runs, with calls that ask main
 * synchronously (`__ompdeskSendSync`, which the shell gives a registered preload script and which the script takes
 * and removes, so the page never sees it) and so block the page exactly as a real dialog does, until the viewer
 * answers on its phone (`PageStream.openDialog`).
 *
 * It is the one exception to the preview's "no preload": nothing else is exposed to the page, only the three
 * replaced functions, which can say no more than the text of a dialog. `beforeunload` is not a dialog here: main
 * lets the page leave (`will-prevent-unload`). Main answers the channel only for a page it streams, and always answers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DialogRequest } from "./preview-stream";

/** The channel the preload asks on (Electron's own `ipcMain`, never the web registry: a page is no caller). */
export const DIALOG_CHANNEL = "preview-web:dialog";

const MESSAGE_MAX = 2000;

export const dialogRequestSchema: z.ZodType<DialogRequest> = z.object({
	kind: z.enum(["alert", "confirm", "prompt"]),
	message: z.string().max(MESSAGE_MAX),
	initial: z.string().max(MESSAGE_MAX).nullable(),
});

/** What `sendSync` returns to the replaced function: null for `alert` (a reply is always set), a boolean, a string or null. */
export function dialogReturnValue(
	request: DialogRequest,
	answer: { accept: boolean; text: string | null },
): boolean | string | null {
	if (request.kind === "alert") return null;
	if (request.kind === "confirm") return answer.accept;
	return answer.accept ? (answer.text ?? request.initial ?? "") : null;
}

export const DIALOG_PRELOAD_SOURCE = `(() => {
	"use strict";
	const send = globalThis.__ompdeskSendSync;
	delete globalThis.__ompdeskSendSync;
	if (typeof send !== "function") return;
	const clip = value => String(value === undefined || value === null ? "" : value).slice(0, ${MESSAGE_MAX});
	const ask = (kind, message, initial) =>
		send(${JSON.stringify(DIALOG_CHANNEL)}, { kind, message: clip(message), initial: initial === null ? null : clip(initial) });
	window.alert = message => {
		ask("alert", message, null);
	};
	window.confirm = message => ask("confirm", message, null) === true;
	window.prompt = (message, initial) => {
		const answer = ask("prompt", message, initial === undefined ? "" : initial);
		return typeof answer === "string" ? answer : null;
	};
})();
`;

/** Write the preload under `<userData>/web-preview/` (a session loads it from a real file) and return its path. */
export function writeDialogPreload(userData: string): string {
	const directory = path.join(userData, "web-preview");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = path.join(directory, "dialog-preload.js");
	writeFileSync(file, DIALOG_PRELOAD_SOURCE, { mode: 0o600 });
	return file;
}
