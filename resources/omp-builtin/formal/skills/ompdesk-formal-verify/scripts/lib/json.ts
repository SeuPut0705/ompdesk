import fs from "node:fs";

/** The one object guard of this skill's scripts (a standalone package: no shared type-guard module to import). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads and parses a JSON file; the error names the file. */
export function readJson(file: string): unknown {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}
