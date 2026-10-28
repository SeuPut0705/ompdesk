import fs from "node:fs";

/**
 * Removes a scratch folder and never throws: on Windows a folder java or an antivirus scanner still holds fails with
 * EBUSY or EPERM for a moment, and that must not replace a verdict that is already computed. Returns the message
 * of a failure (the folder stays), `undefined` when it is gone.
 */
export function removeTree(dir: string): string | undefined {
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		return undefined;
	} catch (error) {
		return `could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
