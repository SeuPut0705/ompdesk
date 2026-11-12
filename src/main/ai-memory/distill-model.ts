/**
 * The one model call the upkeep makes: `omp -p` on the cheap role, no tools, no session, no extensions (so ai-memory's
 * own extension does not record the call), a system prompt of our own and the digest on stdin. The core runs it
 * (`native/ompdesk/crates/core/src/upkeep/model.rs`: the arguments, the empty folder of its own, the 180 s limit, the
 * reading of omp's event lines); this file hands it how omp starts.
 */
import { core } from "../core/process";

/** The system prompt and the text on stdin of one model call. */
export interface DistillMessage {
	system: string;
	user: string;
}

export interface ModelResult {
	text: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	/** What the provider billed for the call (omp's own accounting), in US dollars. */
	costUsd: number;
}

/** How omp starts: its binary and the whole environment it runs with (`core-asks.ts ompLaunch()`). */
export interface OmpLaunch {
	bin: string;
	env: Record<string, string>;
}

/** The core's own 180 s limit on omp, and room for it to answer. */
const CORE_TIMEOUT_MS = 190_000;

/** Runs the message on the user's cheap model through their own omp. Throws with omp's own words when it fails. */
export async function runSmol(launch: OmpLaunch, message: DistillMessage, cwd: string): Promise<ModelResult> {
	const answer = await core().call<ModelResult>(
		"upkeep.runSmol",
		{ launch, message, cwd },
		{ timeoutMs: CORE_TIMEOUT_MS },
	);
	return answer.result;
}
