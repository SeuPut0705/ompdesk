import { join } from "node:path";
import type { TerminalOperation } from "../../../src/shared/terminal-types";
import { type Pty, TerminalService } from "./terminal-service";

let service: TerminalService | null = null;
async function terminals(): Promise<TerminalService> {
	if (service) return service;
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
	// Reuse stock's portable-pty / Windows ConPTY implementation in Bun. No Electron native addon.
	const stock = await import(Bun.resolveSync("@oh-my-pi/pi-natives", join(root, "package.json")));
	if (typeof stock.PtySession !== "function") throw new Error("Installed omp has no interactive PtySession");
	service = new TerminalService(() => new stock.PtySession() as Pty);
	return service;
}
export function disposeTerminals(): void {
	service?.dispose();
}
export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"terminal.request": async params => {
		const { owner, cwd, operation } = params as { owner: string; cwd: string; operation: TerminalOperation };
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		env.TERM = "xterm-256color";
		env.TERM_PROGRAM = "OMPdesk";
		const windows = process.platform === "win32";
		const application = windows ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/zsh";
		return (await terminals()).request(owner, operation, {
			application,
			args: windows ? [] : ["-l"],
			cwd,
			env,
			cols: 80,
			rows: 24,
		});
	},
	/** One command (not the login shell) in a PTY, e.g. `gh auth login`, which needs a TTY. Main supplies the whole env. */
	"pty.request": async params => {
		const { owner, application, args, cwd, env, operation } = params as {
			owner: string;
			application: string;
			args: string[];
			cwd: string;
			env: Record<string, string>;
			operation: TerminalOperation;
		};
		return (await terminals()).request(owner, operation, { application, args, cwd, env, cols: 120, rows: 30 });
	},
	"terminal.dispose": async params => {
		const { owner } = params as { owner: string };
		service?.dispose(owner);
	},
};
