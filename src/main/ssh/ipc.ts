import { app, BrowserWindow, ipcMain } from "electron";
import {
	SSH_TOOLS_AGENT,
	SSH_TOOLS_COMMAND,
	SSH_TOOLS_PROMPT,
	SSH_TOOLS_PROMPTS,
	SSH_TOOLS_STATE,
} from "../../shared/ssh-tools";
import { SshTools } from "./service";

/** Settings › SSH tools for every window; saved forwards start again right away (C151 restore). */
export function registerSshToolsIpc(): void {
	const tools = new SshTools({
		userData: app.getPath("userData"),
		broadcast: (kind, data) => {
			for (const win of BrowserWindow.getAllWindows())
				if (!win.isDestroyed()) win.webContents.send(kind === "state" ? SSH_TOOLS_STATE : SSH_TOOLS_PROMPT, data);
		},
	});
	ipcMain.handle(SSH_TOOLS_COMMAND, (_event, request: unknown) => tools.command(request));
	ipcMain.handle(SSH_TOOLS_AGENT, () => tools.agent());
	// A window that opens (or reloads) while a question waits still sees it.
	ipcMain.handle(SSH_TOOLS_PROMPTS, () => tools.prompts());
	app.on("will-quit", () => tools.dispose());
	void tools.start();
}
