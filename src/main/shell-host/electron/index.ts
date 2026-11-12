/**
 * The `electron` module main, electron-store and electron-updater import (the main bundle aliases `electron` to this
 * file). Importing it connects to the shell (`OMPDESK_SHELL_SOCKET`, `OMPDESK_SHELL_TOKEN`), says `hello` and waits
 * for the facts before any main code runs, so Electron's synchronous `app.getPath()` and friends work at module top
 * level, as they do there.
 */
import { ShellClient } from "../client";
import type { HostFacts } from "../facts";
import { createElectron } from "./create";

const socketPath = process.env.OMPDESK_SHELL_SOCKET;
const token = process.env.OMPDESK_SHELL_TOKEN;
if (!socketPath || !token) {
	throw new Error("OMPdesk's main runs under ompdesk-shell: OMPDESK_SHELL_SOCKET and OMPDESK_SHELL_TOKEN are not set");
}

const client = await ShellClient.connect(socketPath);
const hello = await client.call<{ protocol: number; facts: HostFacts }>("hello", {
	token,
	pid: process.pid,
	protocol: 1,
});
if (hello.protocol !== 1) throw new Error(`The shell speaks host protocol ${hello.protocol}, this main speaks 1`);

/** The shell going away ends main: nothing it shows is left to serve, and its next launch reads this from stderr. */
client.onClose(reason => {
	console.error(`[shell-host] the shell connection ended${reason ? `: ${reason.message}` : ""}; exiting`);
	process.exit(1);
});

const electron = createElectron(client, hello.facts, { patchProcess: true });

// The e2e harness (OMP_GUI_TEST_NODE_INSPECT=1: main runs under `--inspect`) evaluates specs' functions against this
// object through the inspector, where Electron's `app.evaluate` handed them the module.
if (process.env.OMP_GUI_TEST_NODE_INSPECT === "1") {
	Object.defineProperty(globalThis, "__ompdeskElectron", { value: electron, configurable: true });
}

export const {
	app,
	BrowserWindow,
	WebContentsView,
	webContents,
	session,
	protocol,
	ipcMain,
	Menu,
	MenuItem,
	Tray,
	dialog,
	clipboard,
	shell,
	Notification,
	screen,
	nativeTheme,
	systemPreferences,
	powerMonitor,
	powerSaveBlocker,
	globalShortcut,
	autoUpdater,
	net,
	nativeImage,
	safeStorage,
} = electron;

export default electron;
