/**
 * The typed client of the core's model setup research run (`native/ompdesk/crates/core/src/models`): one stock
 * `omp --mode rpc` job with only web_search and read, prompted once with the shared research prompt. The core starts
 * the omp, sends the prompt, reads its event stream and ends it at its budget, at a stop, or when the run is over.
 * This side hands it how to run, as `exec.ts` does for git and gh (the omp, its whole environment, the folder, the
 * budget), checks the request before and reads the plan out of the reply after (`src/shared/model-setup.ts`, the one
 * copy the page shares).
 *
 * `models.setupRun` answers once the omp started; the run then reports by events (`models.setupProgress`,
 * `models.setupDone`) and `models.setupStop` asks it to end. A core that ended took the run with it (its job object,
 * its process group): the run is failed when the next core starts, or cancelled when a stop finds none.
 */
import { tmpdir } from "node:os";
import { type IpcErrorCode, ipcErrorCode } from "../shared/ipc-error-codes";
import type { IpcModelSetupRunResult } from "../shared/ipc-types";
import {
	buildModelSetupPrompt,
	MODEL_SETUP_TIMEOUT_MS,
	type ModelSetupActivity,
	ModelSetupRequestSchema,
	type ModelSetupStatus,
	parseModelSetupPlan,
} from "../shared/model-setup";
import { CoreError, core } from "./core/process";
import { OMP_TELEMETRY_OFF, ompPathEnv } from "./omp-runtime";

/** Past the run's budget: the end of an omp that ran into it (asked, killed 2 s later) and the core round trip. */
const SLACK_MS = 10_000;

/** `models.setupDone`: the research reply, or why there is none. */
type Ended = { reply: string } | { error: string; stderr?: string; cancelled?: boolean };

interface Live {
	startedAt: number;
	activity?: ModelSetupActivity;
	stop(): void;
}

/** Names a run to the core; one counter for every runner of this process. */
let sequence = 0;

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
	#live: Live | null = null;

	get running(): boolean {
		return this.#live !== null;
	}

	status(): ModelSetupStatus {
		const live = this.#live;
		if (!live) return { running: false };
		return { running: true, startedAt: live.startedAt, ...(live.activity ? { activity: live.activity } : {}) };
	}

	abort(): boolean {
		const live = this.#live;
		if (!live) return false;
		live.stop();
		return true;
	}

	async run(ompBin: string, input: unknown, env: NodeJS.ProcessEnv): Promise<IpcModelSetupRunResult> {
		if (this.#live) return failure("Model research is already running", { code: "model_setup_running" });
		const parsed = ModelSetupRequestSchema.safeParse(input);
		if (!parsed.success)
			return failure(`Invalid model setup request: ${parsed.error.issues[0]?.message ?? ""}`, {
				code: "model_setup_invalid",
			});
		const request = parsed.data;
		const run = `${process.pid}.${++sequence}`;
		const ended = Promise.withResolvers<Ended>();
		const host = core();
		const mine =
			<T extends { run: string }>(handle: (data: T) => void) =>
			(data: unknown) => {
				if ((data as T).run === run) handle(data as T);
			};
		const ompEnv: Record<string, string> = {};
		for (const [name, value] of Object.entries({
			...env,
			PATH: ompPathEnv(ompBin, env.PATH ?? ""),
			PI_NOTIFICATIONS: "off",
			...OMP_TELEMETRY_OFF,
		}))
			if (value !== undefined) ompEnv[name] = value;
		const started = host.call("models.setupRun", {
			run,
			bin: ompBin,
			env: ompEnv,
			cwd: tmpdir(),
			researchModel: request.researchModel,
			prompt: buildModelSetupPrompt(request),
			timeoutMs: MODEL_SETUP_TIMEOUT_MS,
		});
		const home = host.pid;
		const live: Live = {
			startedAt: Date.now(),
			// Sent once the core answered the start, so the stop never reaches it before the run it names.
			stop: () => {
				void started.then(
					async () => {
						const stopped =
							host.pid === home &&
							(await host.call<{ stopped: boolean }>("models.setupStop", { run }).then(
								answer => answer.result.stopped,
								() => false,
							));
						// A core without the run has told its end already (this is then nothing new), or is gone.
						if (!stopped) ended.resolve({ error: "Research cancelled", cancelled: true });
					},
					() => {
						// A run that never started has nothing to stop.
					},
				);
			},
		};
		this.#live = live;
		// Heard from the tick the request was sent in: the core's frames arrive in a later one, the end of an omp that
		// comes before the start's answer among them.
		const unsubscribe = [
			host.on(
				"models.setupProgress",
				mine<{ run: string; activity: ModelSetupActivity }>(data => {
					live.activity = data.activity;
				}),
			),
			host.on(
				"models.setupDone",
				mine<{ run: string } & Ended>(data => ended.resolve(data)),
			),
			// A core that started after the one the run was started on holds nothing of it.
			host.on("ready", () => {
				if (host.pid !== home) ended.resolve({ error: "ompdesk-core exited before the research finished" });
			}),
		];
		// The budget is the core's; this only ends the wait for a core that never says how the run ended.
		const lost = setTimeout(() => {
			live.stop();
			ended.resolve({ error: "ompdesk-core did not report the end of the research" });
		}, MODEL_SETUP_TIMEOUT_MS + SLACK_MS);
		lost.unref();
		try {
			await started;
			const end = await ended.promise;
			if ("error" in end) return failure(end.error, { stderr: end.stderr, cancelled: end.cancelled });
			try {
				const { plan, dropped } = parseModelSetupPlan(end.reply, request);
				return { success: true, plan, dropped };
			} catch (error) {
				const code = ipcErrorCode(error);
				return failure(error instanceof Error ? error.message : String(error), {
					...(code ? { code } : {}),
					reply: end.reply.slice(0, 4_000),
				});
			}
		} catch (error) {
			// The start failed. A late answer may have started it after all: nothing of a failed start stays.
			if (error instanceof CoreError && error.code === "timeout")
				host.call("models.setupStop", { run }).catch(() => {});
			return failure(error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(lost);
			for (const off of unsubscribe) off();
			if (this.#live === live) this.#live = null;
		}
	}
}
