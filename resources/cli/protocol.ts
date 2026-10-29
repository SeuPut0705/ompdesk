/**
 * The OMPdesk control socket's wire contract, shared by main (`src/main/control-socket/`) and the `ompdesk` CLI
 * (`resources/cli/ompdesk.ts`, run by bun from the app's resources). Dependency-free: the CLI runs it outside the app.
 *
 * Inspired by Herdr's socket API (https://herdr.dev, Apache-2.0): JSON lines over a per-user local socket,
 * server-owned waits, `agent_blocked` and `events_lost`. No Herdr code is copied.
 *
 * Transport: one JSON object per line, UTF-8, each at most `MAX_FRAME_BYTES`. The first request on a connection is
 * `hello` with the install's token; anything else first, or a wrong token, is answered `unauthorized` and the
 * connection closes. Requests carry a client-chosen `id`; their responses carry it back and may come in any order.
 * A `subscribe` request is answered once (`ok`), then its events arrive as `EventFrame`s carrying the request's id
 * in `sub`, until the connection closes or the subscription ends with an `events_lost` error frame.
 */

export const CONTROL_PROTOCOL_VERSION = 1;

/** The socket's path (a Unix socket file, or a Windows named pipe), set for every process OMPdesk spawns. */
export const CONTROL_SOCKET_ENV = "OMPDESK_SOCKET";
/** The folder holding `endpoint.json` and `token`, set for every process OMPdesk spawns (a test or custom profile). */
export const CONTROL_DIR_ENV = "OMPDESK_CONTROL_DIR";
/** Names the outside caller (its sessions' provenance and its card title); `[a-z0-9_-]`, at most 32. */
export const CONTROL_CALLER_ENV = "OMPDESK_CALLER";

export const ENDPOINT_FILE = "endpoint.json";
export const TOKEN_FILE = "token";
export const POSIX_SOCKET_FILE = "control.sock";
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const CALLER_NAME = /^[a-z0-9_-]{1,32}$/;
export const DEFAULT_CALLER = "cli";

/** `endpoint.json`: where this computer's running OMPdesk listens. */
export interface Endpoint {
	version: typeof CONTROL_PROTOCOL_VERSION;
	socket: string;
	pid: number;
}

/**
 * A session as the waits see it. `blocked`: it waits on the person (a question, a tool approval, a plan up for
 * review); `working`: a turn runs; `idle`: neither; `starting`: its omp is on its way; `stopped`: its omp exited or
 * failed.
 */
export type SessionState = "working" | "blocked" | "idle" | "starting" | "stopped";
export const SESSION_STATES: readonly SessionState[] = ["working", "blocked", "idle", "starting", "stopped"];

/**
 * What a wait waits for. `idle` and `blocked`: the session is in that state (at once when it already is); `done`: a
 * turn ended after the wait began; `any`: the next change of state or a turn's end.
 */
export type WaitUntil = "idle" | "blocked" | "done" | "any";
export const WAIT_UNTIL: readonly WaitUntil[] = ["idle", "blocked", "done", "any"];

export interface SessionStatus {
	/** The tab id: every tool and every later request names the session by it. */
	session: string;
	title: string;
	state: SessionState;
}

export interface WaitResult extends SessionStatus {
	/** What satisfied the wait. */
	matched: WaitUntil | "settled";
	/** Present when a turn ended during the wait: its stock stop reason ("stop", "error", "aborted", …). */
	stopReason?: string;
}

export interface SendResult {
	/** The send tool's receipt, as an agent in a session reads it. */
	receipt: string;
	/** With `wait`: the state the session settled in after it was seen to start. */
	waited?: WaitResult;
}

export type ControlRequest =
	| { id: number; method: "hello"; token: string; protocol: number; caller?: string; cwd?: string }
	/** One `ompdesk_*` control tool call, exactly as an agent in a session makes it. */
	| { id: number; method: "tool"; tool: string; args?: unknown }
	| { id: number; method: "state"; session: string }
	/** Without `until`: the session settles (idle or blocked), at once when it already has. */
	| { id: number; method: "wait"; session: string; until?: WaitUntil; timeoutMs?: number }
	/**
	 * `ompdesk_session_send`, refused with `agent_blocked` while the session waits on the person unless `force`.
	 * With `wait`, the answer comes only after the session was seen working or blocked (within `START_WAIT_MS`, else
	 * `agent_prompt_stalled`) and then reached `wait.until` (default: settled).
	 */
	| {
			id: number;
			method: "send";
			session: string;
			message: string;
			delivery?: "follow_up" | "steer";
			requestId?: string;
			force?: boolean;
			wait?: { until?: WaitUntil; timeoutMs?: number };
	  }
	| { id: number; method: "subscribe" };

export type ControlMethod = ControlRequest["method"];

export type ControlErrorCode =
	| "unauthorized"
	| "bad_request"
	| "unknown_method"
	| "protocol_mismatch"
	| "session_not_found"
	| "session_gone"
	| "agent_blocked"
	| "agent_prompt_stalled"
	| "timeout"
	| "tool_failed"
	| "events_lost"
	| "unavailable";

export interface ControlError {
	code: ControlErrorCode;
	message: string;
}

/** `tool`'s result: the tool's own text, and whether the tool reported a failure. */
export interface ToolResult {
	text: string;
	isError: boolean;
}

export type ControlResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; error: ControlError };

/** How long a send-and-wait waits to see the session start working (or ask) before `agent_prompt_stalled`. */
export const START_WAIT_MS = 5_000;

export type ControlEvent =
	| { type: "session_state"; session: string; title: string; state: SessionState; previous: SessionState | null }
	| { type: "ask"; session: string; title: string; requestId: string; text: string }
	| { type: "turn_finished"; session: string; title: string; stopReason: string }
	| { type: "session_closed"; session: string }
	/** A report a session this caller opened sent it (`ompdesk_report`), as the text an opener's agent would read. */
	| { type: "report"; to: string; text: string };

export type EventFrame =
	| { sub: number; seq: number; event: ControlEvent }
	| { sub: number; error: ControlError & { lost?: number } };

export function isControlResponse(frame: unknown): frame is ControlResponse {
	return typeof frame === "object" && frame !== null && "id" in frame && "ok" in frame;
}
