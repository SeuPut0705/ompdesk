/**
 * Owner-only JSON files of remote-device state are the core's to write (`crates/core/src/remote/store.rs`); main
 * reads the few it keeps (the run charges) with `readJson`. A save of its own goes through `AtomicSaver`
 * (`atomic-file.ts`), never a throwing write from an event.
 */
import { readFileSync } from "node:fs";

/** Parsed JSON, or undefined when the file is missing or not JSON. */
export function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
