export interface TerminalSnapshot {
	id: string;
	output: string;
	offset: number;
	exited: boolean;
	exitCode?: number;
	error?: string;
}
/** A shell the Terminal panel can start (main/terminal/shells.ts); `path` names it. */
export interface TerminalShell {
	path: string;
	name: string;
	args: string[];
}
/** Pref holding the shell path new terminals start with; unset or unknown = the first detected shell. */
export const TERMINAL_SHELL_PREF = "terminalShell";
export type TerminalOperation =
	| { action: "list"; offsets?: Record<string, number> }
	/** `shell`: a detected shell's path; omitted = this computer's default. */
	| { action: "create"; cols: number; rows: number; shell?: string }
	| { action: "write"; id: string; data: string }
	| { action: "resize"; id: string; cols: number; rows: number }
	| { action: "close" | "restart" | "clear"; id: string };
export interface TerminalApi {
	request(tabId: string, operation: TerminalOperation): Promise<TerminalSnapshot[]>;
	/** Shells this computer can start, the default first. */
	shells(): Promise<TerminalShell[]>;
}
