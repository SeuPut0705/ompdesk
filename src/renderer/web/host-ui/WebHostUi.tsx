import { useEffect } from "react";
import { translate } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { registerWebHostHooks } from "../host-hooks";
import { webRuntime } from "../runtime";
import { ConfirmSheet } from "./ConfirmSheet";
import { EditorSheet } from "./EditorSheet";
import { HostBrowserSheet } from "./HostBrowserSheet";
import { type HostPrompt, useHostUiStore } from "./host-ui-store";
import { InstallSheet } from "./InstallSheet";
import { ModelsConfigSheet } from "./ModelsConfigSheet";
import { PathActionsSheet } from "./PathActionsSheet";
import { SaveImageSheet } from "./SaveImageSheet";

/** Wait for the person's answer to a prompt the sheet layer shows. */
function ask<T>(make: (resolve: (value: T) => void) => HostPrompt): Promise<T> {
	return new Promise<T>(resolve => useHostUiStore.getState().push(make(resolve)));
}

const EXTERNAL_TOAST_MS = 6000;

/** Registers the page's hooks (host-hooks.ts) and shows the sheet each one asks for. Nothing in the desktop app. */
export function WebHostUi() {
	if (!webRuntime()) return null;
	return <WebHostSheets />;
}

function WebHostSheets() {
	const prompt = useHostUiStore(state => state.queue[0]);
	const shift = useHostUiStore(state => state.shift);

	useEffect(
		() =>
			registerWebHostHooks({
				// A link opens on this device at once; the computer is one tap away in the toast that follows.
				openExternal: async url => {
					window.open(url, "_blank", "noopener,noreferrer");
					const host = webRuntime()?.host;
					if (!host) return;
					toast({
						variant: "info",
						message: translate("hostUi.link.opened"),
						durationMs: EXTERNAL_TOAST_MS,
						action: {
							label: translate("hostUi.link.onComputer"),
							run: () => void host.openExternalOnComputer(url).catch(() => undefined),
						},
					});
				},
				openPath: (path, tabId, host) =>
					ask(resolve => ({ kind: "openPath", path, ...(tabId ? { tabId } : {}), host, resolve })),
				revealPath: (path, tabId, host) =>
					ask(resolve => ({ kind: "revealPath", path, ...(tabId ? { tabId } : {}), host, resolve })),
				showSaveDialog: (defaultPath, filters, host) =>
					ask<string[] | null>(resolve => ({
						kind: "browse",
						mode: "save",
						...(defaultPath ? { defaultPath } : {}),
						...(filters ? { filters } : {}),
						host,
						resolve,
					})).then(paths => paths?.[0] ?? null),
				showOpenDialog: (filters, options, host) =>
					ask<string[] | null>(resolve => ({
						kind: "browse",
						mode: options?.directory ? "folder" : "file",
						...(options?.title ? { title: options.title } : {}),
						...(filters ? { filters } : {}),
						host,
						resolve,
					})),
				selectProject: host =>
					ask<string[] | null>(resolve => ({ kind: "browse", mode: "folder", host, resolve })).then(
						paths => paths?.[0] ?? null,
					),
				saveImage: (name, mime, base64, host) =>
					ask(resolve => ({ kind: "saveImage", name, mime, base64, host, resolve })),
				openEditor: (content, host) => ask(resolve => ({ kind: "editor", content, host, resolve })),
				openModelsConfig: host => ask(resolve => ({ kind: "models", host, resolve })),
				confirmQuit: () => ask<boolean>(resolve => ({ kind: "quit", resolve })),
				confirmUpdateApply: () => ask<boolean>(resolve => ({ kind: "update", resolve })),
			}),
		[],
	);

	if (!prompt) return null;
	// One sheet at a time; `key` gives each prompt fresh state.
	switch (prompt.kind) {
		case "openPath":
		case "revealPath":
			return <PathActionsSheet key={queueKey(prompt)} onSettled={shift} prompt={prompt} />;
		case "browse":
			return (
				<HostBrowserSheet
					defaultPath={prompt.defaultPath}
					filters={prompt.filters}
					host={prompt.host}
					key={queueKey(prompt)}
					mode={prompt.mode}
					onDone={paths => {
						prompt.resolve(paths);
						shift();
					}}
					title={prompt.title}
				/>
			);
		case "saveImage":
			return <SaveImageSheet key={queueKey(prompt)} onSettled={shift} prompt={prompt} />;
		case "editor":
			return <EditorSheet key={queueKey(prompt)} onSettled={shift} prompt={prompt} />;
		case "models":
			return <ModelsConfigSheet key={queueKey(prompt)} onSettled={shift} prompt={prompt} />;
		case "quit":
		case "update":
			return <ConfirmSheet key={queueKey(prompt)} onSettled={shift} prompt={prompt} />;
		case "install":
			return <InstallSheet key={queueKey(prompt)} onSettled={shift} prompt={prompt} />;
	}
}

const keys = new WeakMap<HostPrompt, number>();
let nextKey = 1;
function queueKey(prompt: HostPrompt): number {
	let key = keys.get(prompt);
	if (key === undefined) {
		key = nextKey++;
		keys.set(prompt, key);
	}
	return key;
}
