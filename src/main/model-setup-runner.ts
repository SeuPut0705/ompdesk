/**
 * The model setup assistant's research run: one stock `omp --mode rpc` job
 * with only web_search and read, prompted once with the shared research
 * prompt. RPC mode, not `-p`: print mode reads piped stdin to EOF before it
 * starts, so it cannot keep the open stdin pipe every child of the app holds
 * (a crashed or force-killed app closes it and RPC mode exits on EOF). The
 * session events stream as JSON lines (stock `RpcSessionEventForwarder`); the
 * terminal `prompt_result` frame ends the run, and the last assistant
 * `message_end` carries the reply the plan is parsed from.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import { type IpcErrorCode, ipcErrorCode } from "../shared/ipc-error-codes";
import type { IpcModelSetupRunResult } from "../shared/ipc-types";
import {
	buildModelSetupPrompt,
	MODEL_SETUP_TIMEOUT_MS,
	type ModelSetupActivity,
	type ModelSetupRequest,
	ModelSetupRequestSchema,
	type ModelSetupStatus,
	parseModelSetupPlan,
} from "../shared/model-setup";
import { ompNeedsShell, ompPathEnv, ompSpawnArgs, ompSpawnCommand } from "./omp-runtime";

const PROMPT_ID = "model-setup";
const EVENTS_ID = "events";
/** Session events the run reads; message deltas and tool output stay in omp. */
const EVENTS = ["tool_execution_start", "message_end"];
const MAX_STDERR_BYTES = 64 * 1024;
const EXIT_GRACE_MS = 5_000;

/** Stock argv for the research job: no session file, research tools only, nothing user-installed loaded. */
export function modelSetupArgs(researchModel: string): string[] {
	return [
		"--mode",
		"rpc",
		"--no-session",
		"--model",
		researchModel,
		"--thinking",
		"auto",
		"--tools",
		"web_search,read",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-lsp",
		"--no-title",
	];
}

/** The stdin frames: only the events the run reads, then the prompt. */
export function modelSetupInput(request: ModelSetupRequest): string {
	return [
		{ id: EVENTS_ID, type: "set_event_filter", events: EVENTS, messageUpdates: "delta" },
		{ id: PROMPT_ID, type: "prompt", message: buildModelSetupPrompt(request) },
	]
		.map(frame => `${JSON.stringify(frame)}\n`)
		.join("");
}

/** The stock frames the run reads (rpc-types.ts / pi-agent-core `AgentEvent`); anything else is ignored. */
const Frame = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("tool_execution_start"),
		toolName: z.string(),
		args: z.record(z.unknown()).optional(),
		intent: z.string().optional(),
	}),
	z.object({
		type: z.literal("message_end"),
		message: z.object({
			role: z.string(),
			content: z.union([z.string(), z.array(z.unknown())]).optional(),
			stopReason: z.string().optional(),
			errorMessage: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("response"),
		id: z.string().optional(),
		success: z.boolean(),
		error: z.string().optional(),
	}),
	z.object({
		type: z.literal("prompt_result"),
		id: z.string().optional(),
		status: z.string(),
		error: z.object({ message: z.string() }).optional(),
	}),
]);
const TextPart = z.object({ type: z.literal("text"), text: z.string() });

function activityOf(toolName: string, args: Record<string, unknown>, intent?: string): ModelSetupActivity {
	const detail = [intent, args.query, args.url, args.path].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	if (!detail) return { tool: toolName };
	const line = detail.trim();
	return { tool: toolName, detail: line.length > 200 ? `${line.slice(0, 199)}…` : line };
}

/** How the run ended, from its `prompt_result` (or the reply that failed). */
export type ResearchOutcome = { ok: true; text: string } | { ok: false; error: string };

/**
 * Reads the run's stdout one JSON line at a time: the latest tool call for
 * the progress line, the last assistant reply, and the terminal outcome.
 */
export class ResearchStream {
	activity: ModelSetupActivity | undefined;
	outcome: ResearchOutcome | undefined;
	#finalText = "";
	#finalError: string | undefined;

	push(line: string): void {
		if (this.outcome || !line.trim()) return;
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			return;
		}
		const parsed = Frame.safeParse(json);
		if (!parsed.success) return;
		const frame = parsed.data;
		switch (frame.type) {
			case "tool_execution_start":
				this.activity = activityOf(frame.toolName, frame.args ?? {}, frame.intent);
				return;
			case "message_end": {
				const { message } = frame;
				if (message.role !== "assistant") return;
				const text = Array.isArray(message.content)
					? message.content.flatMap(part => {
							const textPart = TextPart.safeParse(part);
							return textPart.success ? [textPart.data.text] : [];
						})
					: [message.content ?? ""];
				if (text.join("").trim()) this.#finalText = text.join("");
				const failed = message.stopReason === "error" || message.stopReason === "aborted";
				this.#finalError = failed ? message.errorMessage || `Request ${message.stopReason}` : undefined;
				return;
			}
			case "response":
				if (!frame.success && (frame.id === PROMPT_ID || frame.id === EVENTS_ID))
					this.outcome = { ok: false, error: frame.error || "omp rejected the research prompt" };
				return;
			case "prompt_result":
				if (frame.id !== PROMPT_ID) return;
				if (frame.status === "completed" && !this.#finalError) {
					this.outcome = this.#finalText.trim()
						? { ok: true, text: this.#finalText }
						: { ok: false, error: "The research model returned no reply" };
					return;
				}
				this.outcome = {
					ok: false,
					error: frame.error?.message || this.#finalError || `Research ${frame.status}`,
				};
				return;
		}
	}
}

function failure(
	error: string,
	extra: { code?: IpcErrorCode; stderr?: string; reply?: string; cancelled?: boolean } = {},
): IpcModelSetupRunResult {
	return {
		success: false,
		error,
		...(extra.code ? { code: extra.code } : {}),
		...(extra.stderr ? { stderr: extra.stderr } : {}),
		...(extra.reply ? { reply: extra.reply } : {}),
		...(extra.cancelled ? { cancelled: true } : {}),
	};
}

export class ModelSetupRunner {
	#child: ChildProcess | null = null;
	#startedAt = 0;
	#stream: ResearchStream | null = null;
	#terminationReason: { error: string; cancelled: boolean } | null = null;

	get running(): boolean {
		return this.#child !== null;
	}

	status(): ModelSetupStatus {
		if (!this.#child) return { running: false };
		const activity = this.#stream?.activity;
		return { running: true, startedAt: this.#startedAt, ...(activity ? { activity } : {}) };
	}

	abort(): boolean {
		return this.#terminate("Research cancelled", true);
	}

	#terminate(error: string, cancelled: boolean): boolean {
		const child = this.#child;
		if (!child) return false;
		this.#terminationReason = { error, cancelled };
		child.stdin?.end();
		child.kill("SIGTERM");
		const killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, 2_000);
		killTimer.unref();
		return true;
	}

	async run(ompBin: string, input: unknown, env: NodeJS.ProcessEnv): Promise<IpcModelSetupRunResult> {
		if (this.#child) return failure("Model research is already running", { code: "model_setup_running" });
		const parsed = ModelSetupRequestSchema.safeParse(input);
		if (!parsed.success)
			return failure(`Invalid model setup request: ${parsed.error.issues[0]?.message ?? ""}`, {
				code: "model_setup_invalid",
			});
		const request = parsed.data;
		this.#terminationReason = null;
		const stream = new ResearchStream();
		const child = spawn(ompSpawnCommand(ompBin), ompSpawnArgs(ompBin, modelSetupArgs(request.researchModel)), {
			cwd: tmpdir(),
			env: { ...env, PATH: ompPathEnv(ompBin, env.PATH ?? ""), PI_NOTIFICATIONS: "off" },
			shell: ompNeedsShell(ompBin),
			// stdin stays an open pipe: RPC mode exits when it closes, so a crashed
			// or force-killed app never leaves the research running.
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.#child = child;
		this.#stream = stream;
		this.#startedAt = Date.now();
		let stderr = "";
		let pending = "";
		let settled = false;
		const { promise, resolve } = Promise.withResolvers<IpcModelSetupRunResult>();
		const timeout = setTimeout(() => {
			this.#terminate("Model research timed out after 10 minutes", false);
		}, MODEL_SETUP_TIMEOUT_MS);
		timeout.unref();
		const stderrText = () => stderr.trim() || undefined;
		const finish = (result: IpcModelSetupRunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			this.#child = null;
			this.#stream = null;
			// The job is done: closing stdin ends omp; a stuck one is killed.
			child.stdin?.end();
			if (child.exitCode === null && child.signalCode === null) {
				const exitTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
				}, EXIT_GRACE_MS);
				exitTimer.unref();
			}
			resolve(result);
		};
		const settle = () => {
			const outcome = stream.outcome;
			if (!outcome) return;
			if (!outcome.ok) {
				finish(failure(outcome.error, { stderr: stderrText() }));
				return;
			}
			try {
				const { plan, dropped } = parseModelSetupPlan(outcome.text, request);
				finish({ success: true, plan, dropped });
			} catch (error) {
				const code = ipcErrorCode(error);
				finish(
					failure(error instanceof Error ? error.message : String(error), {
						...(code ? { code } : {}),
						reply: outcome.text.slice(0, 4_000),
					}),
				);
			}
		};
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				stream.push(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
			settle();
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
		});
		child.stdin?.on("error", () => {});
		child.once("error", error => finish(failure(error.message, { stderr: stderrText() })));
		child.once("close", exitCode => {
			if (pending) stream.push(pending);
			pending = "";
			settle();
			const reason = this.#terminationReason;
			if (reason) {
				finish(failure(reason.error, { stderr: stderrText(), cancelled: reason.cancelled }));
				return;
			}
			const firstLine = stderrText()?.split("\n")[0];
			finish(
				failure(
					`omp exited (${exitCode ?? "signal"}) before the research finished${firstLine ? `: ${firstLine}` : ""}`,
					{
						stderr: stderrText(),
					},
				),
			);
		});
		child.stdin?.write(modelSetupInput(request));
		return promise;
	}
}
