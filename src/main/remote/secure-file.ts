/**
 * Owner-only JSON files for remote-device state (identity, peers, hosts):
 * written to a sibling temp file with mode 0600 and renamed into place, so a
 * crash never leaves a half-written key or peer list.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeSecureJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		// An existing umask can narrow but never widen the creation mode; this
		// pins it for filesystems that ignore the creation mode.
		chmodSync(temp, 0o600);
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Parsed JSON, or undefined when the file is missing or not JSON. */
export function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
