/**
 * The one model call the upkeep makes: `omp -p` on the cheap role, no tools, no session, no extensions (so ai-memory's
 * own extension does not record the call), a system prompt of our own and the digest on stdin.
 *
 * It runs in an empty folder of its own, never the project's: omp reads the folder's context files (AGENTS.md) into
 * every request, and this repository's alone is 157k tokens, which turned a $0.015 call into a $0.64 one when measured.
 */
import { mkdir } from "node:fs/promises";
import type { OmpRuntime } from "../local/types";
import type { DistillMessage } from "./distill";

export interface ModelResult {
	text: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	/** What the provider billed for the call (omp's own accounting), in US dollars. */
	costUsd: number;
}

const MODEL_ROLE = "pi/smol";
const TIMEOUT_MS = 180_000;
/** omp's telemetry export stays off for an internal call, whatever `OTEL_*` the user's environment names. */
const QUIET_ENV = { OTEL_SDK_DISABLED: "true" };

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The last assistant message of `omp --mode json`'s event lines (their text, the model, tokens and cost), or null. */
export function parseOmpJson(stdout: string): ModelResult | null {
	let result: ModelResult | null = null;
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: Record<string, unknown>;
		try {
			event = record(JSON.parse(line));
		} catch {
			continue;
		}
		const message = record(event.message);
		if (event.type !== "message_end" || message.role !== "assistant") continue;
		const usage = record(message.usage);
		const parts = Array.isArray(message.content) ? message.content : [];
		result = {
			text: parts.map(part => (typeof record(part).text === "string" ? (record(part).text as string) : "")).join(""),
			model: typeof message.model === "string" ? message.model : "",
			inputTokens: count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite),
			outputTokens: count(usage.output),
			costUsd: count(record(usage.cost).total),
		};
	}
	return result;
}

/** Runs the message on the user's cheap model through their own omp. Throws with omp's own words when it fails. */
export async function runSmol(
	omp: Pick<OmpRuntime, "run">,
	message: DistillMessage,
	cwd: string,
): Promise<ModelResult> {
	await mkdir(cwd, { recursive: true });
	const run = await omp.run(
		[
			"-p",
			"--mode",
			"json",
			"--no-tools",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--model",
			MODEL_ROLE,
			"--thinking",
			"off",
			"--system-prompt",
			message.system,
		],
		{ cwd, input: message.user, timeoutMs: TIMEOUT_MS, env: QUIET_ENV },
	);
	const result = parseOmpJson(run.stdout);
	if (run.code !== 0 || !result) {
		const detail = run.stderr.trim().split("\n").at(-1) ?? "";
		throw new Error(`omp exited ${run.code}${detail ? `: ${detail}` : ""}`);
	}
	return result;
}
