/**
 * Whether a path names a real folder (`initial-cwd.ts` picks a window's first usable folder with it). What a refused
 * second launch's arguments ask for is the shell's (`chrome_core::deep_link::parse_launch_argv`).
 */
import * as fs from "node:fs";

export function isExistingDirectory(path: string): boolean {
	try {
		return fs.statSync(path).isDirectory();
	} catch {
		return false;
	}
}
