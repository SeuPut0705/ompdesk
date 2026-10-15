/**
 * "Run in terminal" for a shell code block in a reply: the text goes to the
 * tab's own terminal (stock `PtySession` through `terminal:request`, local
 * tabs only), the first live session or a new one, and the Terminal panel
 * opens on it. Lines are typed as the keyboard would (`\r`), ending with one.
 */
import { useUiStore } from "../stores/ui";

/** Fence languages (after CodeBlock's alias step) whose text a shell runs. */
export const SHELL_LANGUAGES: Record<string, true> = {
	bash: true,
	fish: true,
	powershell: true,
	ps1: true,
	pwsh: true,
};

export async function runInTerminal(tabId: string, code: string): Promise<void> {
	const sessions = await window.omp.terminal.request(tabId, { action: "list", offsets: {} });
	const live =
		sessions.find(session => !session.exited) ??
		(await window.omp.terminal.request(tabId, { action: "create", cols: 80, rows: 24 })).at(-1);
	if (!live) throw new Error("No terminal session");
	await window.omp.terminal.request(tabId, {
		action: "write",
		id: live.id,
		data: `${code.replace(/\r?\n/g, "\r").replace(/\r+$/, "")}\r`,
	});
	useUiStore.setState({ terminalFocusId: live.id });
	useUiStore.getState().setPanelTab("terminal");
}
