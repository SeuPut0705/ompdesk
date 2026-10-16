/**
 * The scenario file of the fake Tailscale CLI (`fake-tailscale.ts`): one JSON document the fake reads on every
 * invocation and mutates when a command changes the daemon (`serve`, `up`), and a test reads and edits to play the
 * user (signs in, approves the machine, enables HTTPS, quits the app). The scenario's shape and what each command
 * answers live in `src/main/tailscale/test-fake-tailscale.ts` (shared with the vitest suites); this file only
 * reads and writes the file and the call log.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { FakeTailscaleScenario } from "../../src/main/tailscale/test-fake-tailscale";

export {
	defaultTailscaleScenario,
	type FakeBackendState,
	type FakeServeConfig,
	type FakeTailscaleScenario,
	USER_SERVE,
	USER_SERVE_HOST,
} from "../../src/main/tailscale/test-fake-tailscale";

export function readTailscaleScenario(file: string): FakeTailscaleScenario {
	return JSON.parse(readFileSync(file, "utf8")) as FakeTailscaleScenario;
}

/** Atomic (a temp file renamed over it): the app's CLI call and the test never see half a document. */
export function writeTailscaleScenario(file: string, scenario: FakeTailscaleScenario): void {
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(scenario, null, "\t")}\n`);
	renameSync(temp, file);
}

/** One recorded call (`FAKE_TAILSCALE_LOG`, one JSON object per line, oldest first). */
export interface FakeInvocation {
	argv: string[];
	/** `TAILSCALE_BE_CLI`, which the macOS app binary needs to act as the CLI. */
	beCli: string | null;
	/** Exit code the fake answered with. */
	code: number;
}

export function readFakeInvocations(logFile: string): FakeInvocation[] {
	let text = "";
	try {
		text = readFileSync(logFile, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as FakeInvocation);
}
