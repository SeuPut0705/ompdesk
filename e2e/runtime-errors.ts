import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { isRuntimeFailure, type RuntimeLogLine } from "./runtime-error-lines";

export interface RuntimeError {
	source: string;
	message: string;
	line: string;
}

/** Every failure line of `<userData>/logs/gui-runtime.jsonl` (rotated `.1` included), oldest first. */
export async function runtimeErrors(userData: string): Promise<RuntimeError[]> {
	const file = path.join(userData, "logs", "gui-runtime.jsonl");
	const text = [
		await fs.readFile(`${file}.1`, "utf8").catch(() => ""),
		await fs.readFile(file, "utf8").catch(() => ""),
	].join("\n");
	const errors: RuntimeError[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: RuntimeLogLine;
		try {
			entry = JSON.parse(line) as RuntimeLogLine;
		} catch {
			continue;
		}
		if (!isRuntimeFailure(entry)) continue;
		const source = typeof entry.source === "string" ? entry.source : "";
		errors.push({ source, message: typeof entry.message === "string" ? entry.message : "", line });
	}
	return errors;
}

/**
 * Fails when the profile's runtime log holds an error line. `allow` names patterns a flow provokes on purpose
 * (an expected refusal toast); every other error line is listed in the failure.
 */
export async function expectNoRuntimeErrors(userData: string, allow: readonly RegExp[] = []): Promise<void> {
	const unexpected = (await runtimeErrors(userData)).filter(
		error => !allow.some(pattern => pattern.test(error.message) || pattern.test(error.line)),
	);
	expect(
		unexpected.map(error => error.line),
		`errors in ${userData}/logs/gui-runtime.jsonl`,
	).toEqual([]);
}
