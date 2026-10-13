export interface TerminalSnapshot {
	id: string;
	output: string;
	offset: number;
	exited: boolean;
	exitCode?: number;
	error?: string;
}
export type TerminalOperation =
	| { action: "list"; offsets?: Record<string, number> }
	| { action: "create"; cols: number; rows: number }
	| { action: "write"; id: string; data: string }
	| { action: "resize"; id: string; cols: number; rows: number }
	| { action: "close" | "restart" | "clear"; id: string };
export interface TerminalApi {
	request(tabId: string, operation: TerminalOperation): Promise<TerminalSnapshot[]>;
}
