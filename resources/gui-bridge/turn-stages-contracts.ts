/**
 * Turn-stage tracing (turn-stages-core.ts): dependency-free contracts main imports.
 *
 * A model call whose first output came late, or that ended aborted or errored with none, and a prompt whose setup
 * ended late without starting its run, is one bridge → main frame `turn_stages`; main writes it as one
 * `gui-runtime.jsonl` line (source `turn-stages`, src/main/turn-stages-log.ts). A normal turn sends nothing.
 */

/** Bridge → main frame type. It reaches no window. */
export const TURN_STAGES_EVENT = "turn_stages";

/** A model call is late when its first output came more than this long after the prompt (or, after a tool batch, its `turn_start`). */
export const LATE_FIRST_OUTPUT_MS = 30_000;

/** Test hook: shortens {@link LATE_FIRST_OUTPUT_MS} (milliseconds) so a stock run does not wait 30 s. */
export const TURN_STAGES_LATE_ENV = "OMP_GUI_TURN_STAGES_LATE_MS";

/**
 * The points a prompt passes, in the order they normally come. Each is `at.<name>` in the line: ms since the prompt
 * (the `input` hook of a typed prompt, else the session's `prompt` call; a run outside one: its own first event).
 * - `handlers_start` / `handlers_end`: stock's `before_agent_start` handlers of every extension (first start, last end).
 * - `agent_start`: the run began (stock's preparation, auto thinking and any pre-prompt compaction are over).
 * - `turn_start`: the model call began.
 * - `provider_request`: the last `before_provider_request` hook (the request is built; stock sends it next). Stock's
 *   Anthropic provider sends it up to 11 times by itself (a first-event timeout or a refused connection is retried
 *   with a 0.5 s doubling backoff, 8 s at most) without another hook, so this is the start of the whole request phase.
 * - `stream_open`: the assistant message opened (the provider stream's first event reached the agent loop). Measured
 *   on omp 18.13.2 with a silent, refusing or aborted request it is the failure's own message, a moment before the
 *   run's end, so the gap before it is the request phase, not the stream's opening.
 * - `provider_response`: the last `after_provider_response` hook (response headers arrived).
 * - `first_output`: the first streamed event of the assistant message.
 * - `compaction` / `compaction_end`: a compaction pass ran inside the wait.
 * - `agent_end`: the run ended.
 * - `setup_end`: the prompt's `prompt` call returned or threw before `agent_start` (Stop, a newer prompt, a refusal,
 *   a failure): stock emits no agent event for it.
 */
export const TURN_STAGE_NAMES = [
	"handlers_start",
	"handlers_end",
	"agent_start",
	"turn_start",
	"provider_request",
	"stream_open",
	"provider_response",
	"first_output",
	"compaction",
	"compaction_end",
	"agent_end",
	"setup_end",
] as const;

export type TurnStageName = (typeof TURN_STAGE_NAMES)[number];

/** OMPdesk's own work inside the wait, in ms (`memoryRecallMs`, `sectionsMs` in the line). */
export type TurnSlowSpot = "memoryRecallMs" | "sectionsMs";

/** `gui-runtime.jsonl` keeps at most this many `details` keys (runtime-log-core.ts `MAX_DETAIL_KEYS`). */
export const TURN_STAGES_MAX_DETAILS = 24;

export type TurnStagesDetails = Record<string, string | number | boolean>;

export type TurnStagesFrame = {
	type: typeof TURN_STAGES_EVENT;
	message: string;
	details: TurnStagesDetails;
};
