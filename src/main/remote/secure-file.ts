/**
 * Owner-only JSON files for remote-device state (identity, peers, hosts):
 * written atomically with mode 0600 (`writeFileAtomicSync`), so a crash never
 * leaves a half-written key or peer list, and a reader holding the file open on Windows does not lose the save.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../atomic-file";

export function writeSecureJson(file: string, value: unknown): void {
	writeFileAtomicSync(file, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
}

/** Parsed JSON, or undefined when the file is missing or not JSON. */
export function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
