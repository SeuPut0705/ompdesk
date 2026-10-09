import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "./agent-paths";

/** GUI-owned workspace for Work mode and chat tabs: a full agent outside any user project. */
export function ensureDefaultWorkspace(): string {
	const cwd = path.resolve(agentDir(), "..", "work");
	fs.mkdirSync(cwd, { recursive: true });
	return cwd;
}
