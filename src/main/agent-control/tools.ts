/**
 * The OMPdesk control host tools (contract in `src/shared/agent-control.ts`): their stock `set_host_tools`
 * definitions and the argument schemas `service.ts` parses a call with. Usage guidance for the model lives in the
 * built-in skill `resources/omp-builtin/skills/ompdesk/SKILL.md`; each description here stays short because stock
 * lists every host tool in the session's xd:// device notice.
 */
import { z } from "zod";
import { MAX_AGENT_SESSIONS, MAX_OPENS_PER_TURN, AGENT_CONTROL_TOOLS as T } from "../../shared/agent-control";
import type { HostToolDefinition } from "../../shared/rpc-types";

/** `ompdesk_session_result` waits at most this long by default, and never longer than the maximum. */
export const RESULT_WAIT_DEFAULT_SECONDS = 600;
export const RESULT_WAIT_MAX_SECONDS = 3600;
/** A returned answer is cut to this many characters (the session keeps the whole of it). */
export const RESULT_MAX_CHARS = 20_000;
/** With several sessions in one `ompdesk_session_result` call each answer is cut to this many characters. */
export const RESULT_TABLE_ANSWER_CHARS = 1_500;
/** `ompdesk_session_read` returns at most this many characters and this many messages per page. */
export const READ_MAX_CHARS = 16_000;
export const READ_DEFAULT_MESSAGES = 12;
export const READ_MAX_MESSAGES = 40;
/** A message another session receives is at most this long. */
export const MESSAGE_MAX_CHARS = 50_000;
/** Sessions one `ompdesk_session_result` call may wait on. */
export const RESULT_MAX_SESSIONS = 8;

const SESSION = {
	type: "string",
	description: "Session id as ompdesk_sessions lists it (a unique prefix is enough).",
} as const;
const PLACEMENT = ["focus", "split-right", "split-down"] as const;

const OPEN_ONE = {
	message: { type: "string", description: "First message; the session starts working on it at once." },
	folder: {
		type: "string",
		description: "Working folder (absolute, or relative to yours); default your own folder.",
	},
	model: {
		type: "string",
		description: "Model as provider/id or an id from the model list; default the session's default model.",
	},
	mode: {
		type: "string",
		enum: ["plan", "goal"],
		description: "plan: plan mode first. goal: the message becomes the session's goal (needs message).",
	},
	worktree: {
		anyOf: [
			{ type: "boolean" },
			{
				type: "object",
				properties: {
					branch: { type: "string", description: "Branch name; default omp/agent/<slug>." },
					base: { type: "string", description: "Start ref; default the HEAD of your folder's repo." },
				},
				additionalProperties: false,
			},
		],
		description:
			"true: give the session its own git worktree and branch, so parallel sessions never edit the same files.",
	},
} as const;

export const AGENT_CONTROL_DEFINITIONS: readonly HostToolDefinition[] = [
	{
		name: T.list,
		label: "OMPdesk sessions",
		description:
			"List every session open in this OMPdesk window (not only the ones you opened): id, title, folder, state (running with its current step, waiting for the user's answer, idle), running subagents, todo progress and the start of each one's last answer. Sessions the user hid from agents show as private. See skill://ompdesk.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: T.open,
		label: "Open OMPdesk session",
		description: `Open new sessions (tabs) so they work in parallel with you; returns their ids. Give one session's fields, or sessions: [...] to fan out (at most ${MAX_OPENS_PER_TURN} per turn, ${MAX_AGENT_SESSIONS} you opened open at once). See skill://ompdesk.`,
		parameters: {
			type: "object",
			properties: {
				...OPEN_ONE,
				sessions: {
					type: "array",
					items: { type: "object", properties: OPEN_ONE, additionalProperties: false },
					description: "Several sessions in one call; instead of the single-session fields.",
				},
				show: {
					type: "string",
					enum: ["background", ...PLACEMENT],
					description:
						"background (default) keeps the user's view; focus switches to the first; split-* shows it beside.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: T.send,
		label: "Message OMPdesk session",
		description:
			"Send a message to any other open session. An idle session starts on it; a running one gets it as steer (now, between steps) or follow_up (queued until its turn ends, the default). The session sees it as sent by you, an agent, with your session's title. It cannot answer that session's pending question: only the user does. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				message: { type: "string" },
				delivery: {
					type: "string",
					enum: ["follow_up", "steer"],
					description: "For a running session; default follow_up.",
				},
			},
			required: ["session", "message"],
			additionalProperties: false,
		},
	},
	{
		name: T.result,
		label: "Read OMPdesk session result",
		description:
			"Read the last answer and state of one session (session) or several at once (sessions: a compact table). wait: true waits until they have finished (until all, the default, or any), one needs the user's answer, or the timeout passes. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				sessions: {
					type: "array",
					items: { type: "string" },
					description: `Several session ids (at most ${RESULT_MAX_SESSIONS}); instead of session.`,
				},
				wait: { type: "boolean", description: "Wait for the state change first; default false." },
				until: {
					type: "string",
					enum: ["all", "any"],
					description: "With wait and several sessions: all finished (default) or the first one.",
				},
				timeout_seconds: {
					type: "integer",
					minimum: 1,
					maximum: RESULT_WAIT_MAX_SECONDS,
					description: `With wait: how long to wait; default ${RESULT_WAIT_DEFAULT_SECONDS}.`,
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: T.read,
		label: "Read OMPdesk session transcript",
		description:
			"Read the most recent messages of another session's transcript (user, assistant, tool calls; bounded). Pass the returned before cursor to page further back. Read-only. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				limit: {
					type: "integer",
					minimum: 1,
					maximum: READ_MAX_MESSAGES,
					description: `Messages per page; default ${READ_DEFAULT_MESSAGES}.`,
				},
				before: { type: "string", description: "The cursor a previous page returned, for the page before it." },
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.focus,
		label: "Show OMPdesk session",
		description: "Show a session to the user: switch to its tab, or open it beside the current view as a split.",
		parameters: {
			type: "object",
			properties: { session: SESSION, how: { type: "string", enum: PLACEMENT, description: "Default focus." } },
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.notify,
		label: "Notify the user",
		description:
			"Show the user a system notification (for work that finished or needs them while they look elsewhere); clicking it opens this session.",
		parameters: {
			type: "object",
			properties: { title: { type: "string" }, body: { type: "string" } },
			required: ["title"],
			additionalProperties: false,
		},
	},
	{
		name: T.answer,
		label: "Answer OMPdesk session question",
		description:
			"Answer the question another session is waiting on (shown by ompdesk_sessions as waiting for the user's answer). The answer is marked as given by an agent. A tool approval is approved only if the user allowed agents to (Settings), else the user must; deny always works. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				request: { type: "string", description: "Request id when several wait; default the oldest." },
				choice: { type: "string", description: "The option to pick (select questions, Approve or Deny)." },
				approve: {
					type: "boolean",
					description: "Yes/no for a confirmation, or Approve/Deny for a tool approval.",
				},
				text: { type: "string", description: "Typed answer (input and editor prompts)." },
				answers: {
					type: "array",
					description: "For a multi-question ask: one entry per question.",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Question id." },
							selected: { type: "array", items: { type: "string" } },
							text: { type: "string", description: "Custom answer." },
						},
						additionalProperties: false,
					},
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.stop,
		label: "Stop OMPdesk session",
		description:
			"Stop another session's running work; close: true also closes its tab (the session stays saved), delete: true also deletes the saved session. Sessions you opened: no question asked. Other sessions: the user confirms first (a refusal is final) unless they turned that off.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				close: { type: "boolean", description: "Also close the tab; default false." },
				delete: { type: "boolean", description: "Also delete the saved session; default false." },
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
];

const sessionArg = z.string().trim().min(1).max(200);
const placement = z.enum(PLACEMENT);

const worktreeArg = z.union([
	z.boolean(),
	z
		.object({
			branch: z.string().trim().min(1).max(200).optional(),
			base: z.string().trim().min(1).max(200).optional(),
		})
		.strict(),
]);

const openOne = z
	.object({
		message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
		folder: z.string().trim().min(1).max(4096).optional(),
		model: z.string().trim().min(1).max(200).optional(),
		mode: z.enum(["plan", "goal"]).optional(),
		worktree: worktreeArg.optional(),
	})
	.strict()
	.refine(args => args.mode !== "goal" || args.message !== undefined, {
		message: "mode goal needs a message: it becomes the goal",
	});

export type OpenOne = z.infer<typeof openOne>;

export const ARGS = {
	[T.list]: z.object({}).strict(),
	[T.open]: z
		.object({
			message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
			folder: z.string().trim().min(1).max(4096).optional(),
			model: z.string().trim().min(1).max(200).optional(),
			mode: z.enum(["plan", "goal"]).optional(),
			worktree: worktreeArg.optional(),
			sessions: z.array(openOne).min(1).max(MAX_OPENS_PER_TURN).optional(),
			show: z.enum(["background", ...PLACEMENT]).optional(),
		})
		.strict()
		.refine(
			args =>
				args.sessions === undefined ||
				(args.message === undefined &&
					args.folder === undefined &&
					args.model === undefined &&
					args.mode === undefined &&
					args.worktree === undefined),
			{ message: "give either the single-session fields or sessions, not both" },
		)
		.refine(args => args.mode !== "goal" || args.message !== undefined, {
			message: "mode goal needs a message: it becomes the goal",
		}),
	[T.send]: z
		.object({
			session: sessionArg,
			message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
			delivery: z.enum(["follow_up", "steer"]).optional(),
		})
		.strict(),
	[T.result]: z
		.object({
			session: sessionArg.optional(),
			sessions: z.array(sessionArg).min(1).max(RESULT_MAX_SESSIONS).optional(),
			wait: z.boolean().optional(),
			until: z.enum(["all", "any"]).optional(),
			timeout_seconds: z.number().int().min(1).max(RESULT_WAIT_MAX_SECONDS).optional(),
		})
		.strict()
		.refine(args => (args.session === undefined) !== (args.sessions === undefined), {
			message: "give session or sessions (one of them)",
		}),
	[T.read]: z
		.object({
			session: sessionArg,
			limit: z.number().int().min(1).max(READ_MAX_MESSAGES).optional(),
			before: z.string().min(1).max(500).optional(),
		})
		.strict(),
	[T.answer]: z
		.object({
			session: sessionArg,
			request: z.string().min(1).max(200).optional(),
			choice: z.string().min(1).max(500).optional(),
			approve: z.boolean().optional(),
			text: z.string().max(20_000).optional(),
			answers: z
				.array(
					z
						.object({
							id: z.string().min(1).max(200).optional(),
							selected: z.array(z.string().max(500)).max(20).optional(),
							text: z.string().max(20_000).optional(),
						})
						.strict(),
				)
				.max(20)
				.optional(),
		})
		.strict(),
	[T.focus]: z.object({ session: sessionArg, how: placement.optional() }).strict(),
	[T.notify]: z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(2000).optional() }).strict(),
	[T.stop]: z.object({ session: sessionArg, close: z.boolean().optional(), delete: z.boolean().optional() }).strict(),
} as const;

export type AnswerArgs = z.infer<(typeof ARGS)[typeof T.answer]>;
