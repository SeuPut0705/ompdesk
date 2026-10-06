import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "./agent-paths";

/** GUI-owned workspace for Work mode. It runs the full agent, never a tool-free chat. */
export function ensureDefaultWorkspace(): string {
	const cwd = path.resolve(agentDir(), "..", "work");
	fs.mkdirSync(cwd, { recursive: true });
	return cwd;
}
