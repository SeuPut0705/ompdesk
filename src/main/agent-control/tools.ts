/**
 * The OMPdesk control host tools (contract in `src/shared/agent-control.ts`): their stock `set_host_tools`
 * definitions and the argument schemas `service.ts` parses a call with. Usage guidance for the model lives in the
 * built-in skill `resources/omp-builtin/skills/ompdesk/SKILL.md`; each description here stays short because stock
 * lists every host tool in the session's xd:// device notice.
 */
import { z } from "zod";
import { AUTOPILOT_AREAS } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import { AGENT_SCHEDULE_PREFIX, AGENT_CONTROL_TOOLS as T } from "../../shared/agent-control";
import { BOT_ACTIVITY_PAGE } from "../../shared/bot-activity";
import {
	BOT_DECISION_DRAFT_MAX,
	BOT_DECISION_INPUTS_MAX,
	BOT_DECISION_OPTIONS_MAX,
	BOT_DUTY_TEXT_MAX,
	BOT_MEMORY_TEXT_MAX,
	BOT_PERSONA_MAX,
	BOT_TAGLINE_MAX,
} from "../../shared/bot-desk";
import type { HostToolDefinition } from "../../shared/rpc-types";
import { GITHUB_EVENT_KINDS, GITHUB_REPO, SESSION_EVENT_KINDS } from "../../shared/schedules";
import { MAIL_KINDS } from "./mail";

export type ReportArgs = {
	kind: (typeof MAIL_KINDS)[number];
	text: string;
	files?: string[];
	checks?: { command: string; passed: boolean }[];
	to?: string;
	dispatch?: string;
	id?: string;
};

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

const SESSION = {
	type: "string",
	description:
		"The session: its id as ompdesk_sessions lists it (or a unique prefix), an id it had before OMPdesk relaunched, its saved id from scope stored (open or not), or its title (or a unique start of it).",
} as const;
const DEVICE = {
	type: "string",
	description:
		'A paired device (Settings › Devices) by name or id; "local" is this computer. ompdesk_sessions lists them.',
} as const;
const PLACEMENT = ["focus", "split-right", "split-down"] as const;

const OPEN_ONE = {
	message: { type: "string", description: "First message; the session starts working on it at once." },
	folder: {
		type: "string",
		description:
			"Working folder (absolute, or relative to yours); default your own folder. On another device: absolute, default its workspace.",
	},
	device: {
		...DEVICE,
		description: `${DEVICE.description} Default: the device your own session runs on.`,
	},
	reopen: {
		type: "string",
		description:
			"Open a stored session again instead of a new one: its id from ompdesk_sessions scope stored. folder, worktree and mode do not apply.",
	},
	restore: {
		type: "boolean",
		description:
			"With reopen: when the session's folder is gone and OMPdesk's disk care saved it, put that worktree back first (its branch, uncommitted work and archived files), then open the session there.",
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
	throwaway: {
		type: "boolean",
		description:
			"true: a one-off session (a lookup, a check). Once its final answer ends with Result: ok and has reached you, OMPdesk closes it and deletes its saved session, on a paired device too. Not with reopen.",
	},
} as const;

export const AGENT_CONTROL_DEFINITIONS: readonly HostToolDefinition[] = [
	{
		name: T.list,
		label: "OMPdesk sessions",
		description:
			"List your open sessions, saved sessions and paired devices.\n" +
			"List sessions: those open in this OMPdesk window (default), in every window of this app (scope app, which includes sessions running on paired devices), or the saved sessions on this computer or a paired device (scope stored: closed ones too, with text search). Each with id, title, folder, device, state (running with its current step, waiting for the user's answer, idle), subagents, todos and the start of its last answer; also the paired devices. Sessions the user hid from agents show as private. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				scope: {
					type: "string",
					enum: ["window", "app", "stored"],
					description: "window (default), app (every window), or stored (saved sessions, open or not).",
				},
				device: { ...DEVICE, description: `${DEVICE.description} Only that device's sessions.` },
				folder: { type: "string", description: "Only sessions whose folder contains this text." },
				status: {
					type: "string",
					enum: ["running", "waiting", "idle"],
					description: "Open sessions only: running, waiting for the user, or idle.",
				},
				mine: { type: "boolean", description: "Only the sessions you opened." },
				query: {
					type: "string",
					description: "Text to find in titles (and, with scope stored, in the conversations).",
				},
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Rows at most; default 30." },
			},
			additionalProperties: false,
		},
	},
	{
		name: T.open,
		label: "Open OMPdesk session",
		description:
			"Open new sessions (tabs) to work in parallel with you; returns ids.\n" +
			`Open new sessions (tabs) so they work in parallel with you; returns their ids. Give one session's fields, or sessions: [...] to fan out. See skill://ompdesk.`,
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
			"Send a message to another open session.\n" +
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
				request_id: {
					type: "string",
					description:
						"Your id for this message; sending again with the same id never delivers it twice (returns the first receipt).",
				},
			},
			required: ["session", "message"],
			additionalProperties: false,
		},
	},
	{
		name: T.report,
		label: "Report to OMPdesk opener",
		description:
			"Report progress or results to the session that opened you.\n" +
			"Tell the session that opened you (or a sibling it opened) about your work, instead of waiting to be asked; or tell a session working in the same checkout (the <shared-checkout> section names it) what you are about to do, or ask it to commit or hold off. Every report reaches a working session between its steps (its tool calls are not cut, a `wait` returns on it). kind: progress (a short status; coalesced; never wakes an idle session), done (the work is finished: summary, changed files, checks you ran; wakes it when idle), question or blocked (you need its decision; wakes it when idle; do not guess meanwhile), review (ready for its review; wakes it when idle), note (to a sibling or a session in the same checkout: e.g. 'I am committing src/a.ts'; never wakes an idle session). See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["progress", "done", "blocked", "question", "review", "note"] },
				text: { type: "string", description: "What to tell; for done, the summary." },
				files: { type: "array", items: { type: "string" }, description: "done: files you changed." },
				checks: {
					type: "array",
					items: {
						type: "object",
						properties: { command: { type: "string" }, passed: { type: "boolean" } },
						required: ["command", "passed"],
						additionalProperties: false,
					},
					description: "done: the checks you ran and whether each passed.",
				},
				to: {
					type: "string",
					description:
						"A sibling's session id (opened by the same session), or a session working in the same checkout; default the session that opened you.",
				},
				dispatch: {
					type: "string",
					description: "The dispatch id your task message named; a report for an older dispatch is ignored.",
				},
				id: {
					type: "string",
					description: "Your id for this report; a repeat with the same id is delivered once.",
				},
			},
			required: ["kind", "text"],
			additionalProperties: false,
		},
	},
	{
		name: T.result,
		label: "Read OMPdesk session result",
		description:
			"Read another session's last answer and state, optionally waiting for it.\n" +
			"Read the last answer and state of one session (session) or several at once (sessions: a compact table). wait: true waits until they have finished (until all, the default, or any), one needs the user's answer, or the timeout passes. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				sessions: {
					type: "array",
					items: { type: "string" },
					description: `Several session ids; instead of session.`,
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
			"Read another session's transcript, open or stored.\n" +
			"Read the most recent messages of any session's transcript, open or stored (user, assistant, tool calls; bounded). Pass the returned before cursor to page further back. Read-only. See skill://ompdesk.",
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
		description: "Show a session to the user: switch to its tab or open it as a split.",
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
			"Show the user a system notification when work finishes or needs them.\n" +
			"Show the user a system notification (for work that finished or needs them while they look elsewhere); clicking it opens this session.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				body: { type: "string" },
				kind: {
					type: "string",
					enum: ["progress", "done"],
					description:
						"progress for a step along the way, done (default) for finished work; the owner's bot settings route each kind.",
				},
			},
			required: ["title"],
			additionalProperties: false,
		},
	},
	{
		name: T.answer,
		label: "Answer OMPdesk session question",
		description:
			"Answer the question another session is waiting on.\n" +
			"Answer the question another session is waiting on (shown by ompdesk_sessions as waiting for the user's answer or for plan approval). The answer is marked as given by an agent. A tool approval or a plan approval is approved only if the user allowed agents to (Settings), else the user must; deny and plan feedback always work. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				request: { type: "string", description: "Request id when several wait; default the oldest." },
				choice: {
					type: "string",
					description:
						'The option to pick (select questions; a tool approval: Approve, Deny, or stock\'s "Approve <tool> for this session" when offered, which grants later like calls too). A plan approval: execute (default, fresh context), compact or keep_context.',
				},
				approve: {
					type: "boolean",
					description:
						"Yes/no for a confirmation, Approve/Deny for a tool approval, approve/reject for a plan (reject with text sends it as feedback).",
				},
				text: {
					type: "string",
					description: "Typed answer (input and editor prompts), or a rejected plan's feedback.",
				},
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
		name: T.compare,
		label: "Compare OMPdesk sessions' work",
		description:
			"Compare and judge sessions' work: checks, branches, optional ranked verdict.\n" +
			"Compare and judge sessions' work: for each one the final answer, the checks it ran (test, build, lint commands from its transcript, with their outcome) and, for a git worktree, branch, commits ahead, changed files with line counts and uncommitted work. With criteria, a judge model (your slow role) grades each against them and returns a ranked verdict with reasons and a winner. It runs no tests itself. Default: every worktree session you opened. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				sessions: {
					type: "array",
					items: { type: "string" },
					description: `Session ids, open or stored; default every worktree session you opened.`,
				},
				criteria: {
					type: "array",
					items: { type: "string" },
					description: `Acceptance criteria to judge against; without them nothing is judged.`,
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: T.merge,
		label: "Merge an OMPdesk session's branch",
		description:
			"Merge a worktree session's branch into the parent checkout.\n" +
			"Merge a worktree session's branch into the parent checkout's current branch on the computer the session runs on (a merge commit, never pushed). No card by default; the user confirms first only if they turned off \"Let agents manage other sessions\". A conflict aborts the merge and lists the files. Refuses when the session or the parent has uncommitted changes. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: { session: SESSION },
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.schedule,
		label: "Schedule an OMPdesk run",
		description:
			"Create, list, change or cancel scheduled runs and routines: on a timer, once, or on an event.\n" +
			`Create, list, change or cancel a scheduled run: a prompt that OMPdesk runs as a fresh print-mode session in a folder, only while the app is open on that device (its Settings › Schedules shows it, marked ${AGENT_SCHEDULE_PREFIX.trim()}). device picks the computer it runs on (default: the one your session runs on). create needs name, prompt and exactly one start: every_minutes, daily_at (HH:MM, optional days 0-6), at or in_minutes (once), or on (an event: webhook, github, files, git, session). With target "self" the prompt is instead delivered into your own session each time (a routine of yours, or a follow-up to check later). update changes an agent-made one by id; pause, resume and run (a test run now) act on one; runs shows its run history with failure reasons. No card by default; the user confirms a new one only if they turned off "Let agents manage other sessions". It never runs with auto-approve, and you can change or cancel only agent-made schedules. See skill://ompdesk.`,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["create", "list", "cancel", "update", "pause", "resume", "run", "runs"] },
				name: { type: "string", description: "create, update: a short name." },
				prompt: {
					type: "string",
					description:
						"create, update: what each run is asked; a fresh run has no memory of this conversation. An event run is also told what fired it.",
				},
				folder: {
					type: "string",
					description:
						"create: absolute project folder on that device; default your own (required on another device).",
				},
				every_minutes: {
					type: "integer",
					description: "create, update: repeat every N minutes (at least 5).",
				},
				daily_at: { type: "string", description: "create, update: local time HH:MM, every day or on days." },
				days: {
					type: "array",
					items: { type: "integer" },
					description: "with daily_at: weekdays, 0 = Sunday.",
				},
				at: {
					type: "string",
					description:
						"create, update: once, at this moment (ISO 8601 with an offset, e.g. 2026-11-02T09:00:00+09:00); it then turns itself off.",
				},
				in_minutes: {
					type: "integer",
					description: "create, update: once, this many minutes from now (a follow-up); it then turns itself off.",
				},
				on: {
					type: "object",
					description:
						'create, update: start on an event instead of a clock. {"source":"webhook"} (POST to this computer\'s OMPdesk web server, the answer gives the URL path and key; Mobile web must be on); {"source":"github","repo":"owner/name","events":["pull_request"|"issue"|"ci_failure"|"release"|"push"]} (asked with the user\'s gh every 5 min); {"source":"files","path":"/abs/path"} (a file or folder changed); {"source":"git","repo":"/abs/repo","branch":"main"} (new local commits); {"source":"session","events":["done"|"failed"|"waiting"],"folder":"text"} (another session on this computer finished, failed or waits for the user; never the bot\'s own or ones it opened). Events during a run start one more run after it.',
					properties: {
						source: { type: "string", enum: ["webhook", "github", "files", "git", "session"] },
						repo: { type: "string" },
						events: { type: "array", items: { type: "string" } },
						path: { type: "string" },
						branch: { type: "string" },
						folder: { type: "string" },
					},
					required: ["source"],
					additionalProperties: false,
				},
				model: { type: "string", description: "create, update: provider/id; default omp's default model." },
				device: {
					...DEVICE,
					description: `${DEVICE.description} The computer whose schedules these are. Default: the device your own session runs on.`,
				},
				id: {
					type: "string",
					description: "cancel, update, pause, resume, run, runs: the schedule id list shows.",
				},
				target: {
					type: "string",
					enum: ["self"],
					description:
						'create: "self" delivers the prompt into THIS session at each start, as a message that starts a turn (this session is opened in the background if no tab holds it), instead of running a fresh session: a routine or a follow-up of yours. Give the prompt as a note to yourself, since you keep this conversation. This computer\'s sessions only; no folder, model or device. A repeating or event one runs until you cancel it; a once one turns itself off.',
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: T.autopilot,
		label: "OMPdesk Autopilot",
		description:
			"Start, inspect or stop an unattended Autopilot run on a git repo.\n" +
			`Start, inspect or stop an Autopilot run: an unattended loop that keeps improving a git repo in its own worktree (cycles of audit, change, check, commit; it can push and release when the ship level allows). start opens the run as a new session of yours and returns its id; status reads its cycle, current item, red streak, last commit/push/release and why it paused or ended; stop ends it after the cycle in flight (now: true aborts the turn at once and pauses it). No card by default; the user confirms a start only if they turned off "Let agents manage other sessions", and always for ship release or the repo's default branch. See skill://ompdesk.`,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["start", "status", "stop"] },
				folder: {
					type: "string",
					description:
						"start: absolute project folder on that device; default your own. On this computer it must be open in a session of this window; on a paired device a session there is opened for it when none has it open.",
				},
				device: {
					...DEVICE,
					description: `${DEVICE.description} start: where the run works (its worktree, checks and shipping run on that computer). Default: the device your own session runs on.`,
				},
				guide: {
					type: "string",
					description:
						"start: AUTOPILOT.md text to commit as the run branch's first commit when it differs (default: the repo's own, else one OMPdesk builds; a missing Release section is added from the project's facts).",
				},
				ship: {
					type: "string",
					enum: ["commit", "push", "release"],
					description: "start: how far the run may ship; default commit. release always asks the user.",
				},
				branch: {
					type: "object",
					properties: {
						kind: { type: "string", enum: ["new", "existing"] },
						name: { type: "string", description: "new: optional branch name; existing: the branch to work on." },
					},
					required: ["kind"],
					additionalProperties: false,
					description: "start: where the run commits; default a new autopilot/<date> branch.",
				},
				advanced: {
					type: "object",
					properties: {
						focus: {
							type: "array",
							items: { type: "string", enum: [...AUTOPILOT_AREAS] },
							description: "Areas the cycles favour; default all.",
						},
						cadence: {
							type: "integer",
							description: "With ship release: release every N cycles; default the run decides.",
						},
						remote: {
							type: "string",
							description: "Git remote a push goes to; default origin, else the only remote.",
						},
						limits: {
							type: "object",
							properties: {
								tokens: { type: "number" },
								minutes: { type: "number" },
								cycles: { type: "number" },
								usd: { type: "number" },
							},
							additionalProperties: false,
							description: "Ceilings that pause the run; default none.",
						},
					},
					additionalProperties: false,
					description: "start: optional tuning; anything omitted keeps the Autopilot sheet's defaults.",
				},
				session: {
					type: "string",
					description: "status, stop: the run's session id from start or ompdesk_sessions.",
				},
				now: {
					type: "boolean",
					description: "stop: true aborts the running turn at once (pauses the run); default false.",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: T.stop,
		label: "Stop OMPdesk session",
		description:
			"Stop another session's work; optionally close or delete it.\n" +
			"Stop another session's running work; close: true also closes its tab (the session stays saved), delete: true also deletes the saved session (also one no tab holds: its stored id, or the id its tab had before it closed this launch, with device for a paired device's). Sessions you opened, closed ones included: no question asked. Other sessions: stop and close need no card by default (the user may turn that off); deleting one's saved session always asks the user first (a refusal is final).",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				close: { type: "boolean", description: "Also close the tab; default false." },
				delete: { type: "boolean", description: "Also delete the saved session; default false." },
				device: {
					...DEVICE,
					description: `${DEVICE.description} Where a stored session id is saved; default this computer or the last stored list.`,
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.appList,
		label: "OMPdesk app actions",
		description:
			"List the OMPdesk app actions you can take: settings, panels, usage, models.\n" +
			"List what you can do to OMPdesk itself (settings, side panel, usage, models, saved sessions, updates, sign-in starts) with each action's tier and argument schema. Filter by area or query. See skill://ompdesk/references/app-control.md.",
		parameters: {
			type: "object",
			properties: {
				area: { type: "string", description: "An area such as settings, ui, usage, models, sessions, updates." },
				query: { type: "string", description: "Words to match in an action's id or description." },
			},
			additionalProperties: false,
		},
	},
	{
		name: T.app,
		label: "OMPdesk app action",
		description:
			"Run one OMPdesk app action from ompdesk_app_list.\n" +
			"Do one OMPdesk app action from ompdesk_app_list: change a setting, open a panel, read usage, and so on. Changes are shown to the user with an undo; some actions ask the user first whatever their settings say (they erase data, install code, start a sign-in, change the proxy, expose the computer or end running work); some are never available. See skill://ompdesk/references/app-control.md.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", description: "Action id from ompdesk_app_list, e.g. settings.theme." },
				args: {
					type: "object",
					description: "The action's arguments as its schema says.",
					additionalProperties: true,
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: T.bot,
		label: "OMPdesk bot desk",
		description:
			"The owner's bot: read its desk, post decisions, keep duties and memory.\n" +
			"The desk of the owner's bot, usable only from the bot's own session and its side chats (Settings › Bot); any other session is refused. desk reads your standing duties, memories, the decisions still waiting for the owner and the wakes you scheduled. decide posts what only the owner can decide and returns at once: keep working, the owner's answer arrives later as a message that starts your turn. duty_add records a standing responsibility the owner gave you; it stays in your prompt through a new conversation and a compaction. duty_remove drops one by id. remember keeps one fact about the owner or their work in your memory (in your prompt every turn; the owner can see, edit and forget it); forget drops one by id. identity sets your tagline, persona or avatar (avatar_file: a PNG, JPEG or WebP you made, e.g. with generate_image). visited lists the files and pages you read; activity lists what you did, newest last. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"desk",
						"decide",
						"duty_add",
						"duty_remove",
						"remember",
						"forget",
						"identity",
						"visited",
						"activity",
					],
				},
				question: { type: "string", description: "decide: what the owner is asked, one clear sentence." },
				options: {
					type: "array",
					items: { type: "string" },
					description: `decide: the choices you offer (at most ${BOT_DECISION_OPTIONS_MAX}); omit for a free answer.`,
				},
				context: { type: "string", description: "decide: what the owner needs to know to decide." },
				operation: {
					type: "string",
					description:
						"decide, when the answer approves an action: the exact operation as it would run (the command, the tool call, the release step), shown to the owner verbatim.",
				},
				inputs: {
					type: "object",
					additionalProperties: { type: "string" },
					description: `decide: that operation's inputs by name (a target branch, a version, an amount); at most ${BOT_DECISION_INPUTS_MAX}.`,
				},
				draft: {
					type: "string",
					description:
						"decide: the text you would send or write once approved (an email, a message, notes); the owner may edit it before answering, and the answer carries their version.",
				},
				expires_in_minutes: {
					type: "integer",
					minimum: 1,
					maximum: 10080,
					description:
						"decide: when the answer stops counting (a hold or a deadline that lapses); after it the owner can no longer answer, and you ask again if you still need it.",
				},
				text: {
					type: "string",
					description: "duty_add: the duty, one sentence. remember: the fact, one sentence.",
				},
				id: { type: "string", description: "duty_remove, forget: the id desk shows." },
				tagline: { type: "string", description: "identity: one line under your name." },
				persona: { type: "string", description: "identity: your personality, tone and boundaries." },
				avatar_file: { type: "string", description: "identity: an absolute path to your new avatar picture." },
				limit: { type: "number", description: "visited, activity: entries at most (default 30)." },
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
];

const sessionArg = z.string().trim().min(1).max(200);
const deviceArg = z.string().trim().min(1).max(200);
const placement = z.enum(PLACEMENT);

const positive = z.number().positive().finite();

const autopilotBranch = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(200).optional() }).strict(),
	z.object({ kind: z.literal("existing"), name: z.string().trim().min(1).max(200) }).strict(),
]);

const autopilotAdvanced = z
	.object({
		focus: z.array(z.enum(AUTOPILOT_AREAS)).max(AUTOPILOT_AREAS.length).optional(),
		cadence: z.number().int().min(1).max(100).optional(),
		remote: z
			.string()
			.regex(/^[^\s-][^\s]{0,99}$/, "remote is a git remote name")
			.optional(),
		limits: z
			.object({
				tokens: positive.optional(),
				minutes: positive.optional(),
				cycles: positive.optional(),
				usd: positive.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const autopilotArgs = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("start"),
			folder: z.string().trim().min(1).max(4096).optional(),
			device: deviceArg.optional(),
			guide: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
			ship: z.enum(["commit", "push", "release"]).optional(),
			branch: autopilotBranch.optional(),
			advanced: autopilotAdvanced.optional(),
		})
		.strict(),
	z.object({ action: z.literal("status"), session: sessionArg }).strict(),
	z.object({ action: z.literal("stop"), session: sessionArg, now: z.boolean().optional() }).strict(),
]);

const worktreeArg = z.union([
	z.boolean(),
	z
		.object({
			branch: z.string().trim().min(1).max(200).optional(),
			base: z.string().trim().min(1).max(200).optional(),
		})
		.strict(),
]);

const openFields = {
	message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
	folder: z.string().trim().min(1).max(4096).optional(),
	device: deviceArg.optional(),
	reopen: sessionArg.optional(),
	restore: z.boolean().optional(),
	model: z.string().trim().min(1).max(200).optional(),
	mode: z.enum(["plan", "goal"]).optional(),
	worktree: worktreeArg.optional(),
	throwaway: z.boolean().optional(),
};

const goalNeedsMessage = [
	(args: { mode?: string; message?: string }) => args.mode !== "goal" || args.message !== undefined,
	{ message: "mode goal needs a message: it becomes the goal" },
] as const;
const reopenAlone = [
	(args: {
		reopen?: string;
		restore?: boolean;
		folder?: string;
		worktree?: unknown;
		mode?: string;
		throwaway?: boolean;
	}) =>
		args.reopen === undefined
			? args.restore === undefined
			: args.folder === undefined &&
				args.worktree === undefined &&
				args.mode === undefined &&
				args.throwaway === undefined,
	{
		message:
			"reopen opens a stored session as it was: give no folder, worktree, mode or throwaway with it; restore goes only with reopen",
	},
] as const;

const openOne = z
	.object(openFields)
	.strict()
	.refine(...goalNeedsMessage)
	.refine(...reopenAlone);

export type OpenOne = z.infer<typeof openOne>;

export const ARGS = {
	[T.list]: z
		.object({
			scope: z.enum(["window", "app", "stored"]).optional(),
			device: deviceArg.optional(),
			folder: z.string().trim().min(1).max(4096).optional(),
			status: z.enum(["running", "waiting", "idle"]).optional(),
			mine: z.boolean().optional(),
			query: z.string().trim().min(1).max(500).optional(),
			limit: z.number().int().min(1).max(100).optional(),
		})
		.strict(),
	[T.open]: z
		.object({
			...openFields,
			sessions: z.array(openOne).min(1).optional(),
			show: z.enum(["background", ...PLACEMENT]).optional(),
		})
		.strict()
		.refine(
			args =>
				args.sessions === undefined ||
				Object.keys(openFields).every(key => args[key as keyof typeof openFields] === undefined),
			{ message: "give either the single-session fields or sessions, not both" },
		)
		.refine(...goalNeedsMessage)
		.refine(...reopenAlone),
	[T.send]: z
		.object({
			session: sessionArg,
			message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
			delivery: z.enum(["follow_up", "steer"]).optional(),
			request_id: z.string().trim().min(1).max(200).optional(),
		})
		.strict(),
	[T.report]: z
		.object({
			kind: z.enum(MAIL_KINDS),
			text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
			files: z.array(z.string().trim().min(1).max(1000)).optional(),
			checks: z
				.array(z.object({ command: z.string().trim().min(1).max(1000), passed: z.boolean() }).strict())
				.optional(),
			to: sessionArg.optional(),
			dispatch: z.string().trim().min(1).max(100).optional(),
			id: z.string().trim().min(1).max(200).optional(),
		})
		.strict(),
	[T.result]: z
		.object({
			session: sessionArg.optional(),
			sessions: z.array(sessionArg).min(1).optional(),
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
							selected: z.array(z.string().max(500)).optional(),
							text: z.string().max(20_000).optional(),
						})
						.strict(),
				)
				.optional(),
		})
		.strict(),
	[T.focus]: z.object({ session: sessionArg, how: placement.optional() }).strict(),
	[T.notify]: z
		.object({
			title: z.string().trim().min(1).max(200),
			body: z.string().max(2000).optional(),
			kind: z.enum(["progress", "done"]).optional(),
		})
		.strict(),
	[T.stop]: z
		.object({
			session: sessionArg,
			close: z.boolean().optional(),
			delete: z.boolean().optional(),
			device: deviceArg.optional(),
		})
		.strict(),
	[T.compare]: z
		.object({
			sessions: z.array(sessionArg).min(1).optional(),
			criteria: z.array(z.string().trim().min(1).max(1000)).min(1).optional(),
		})
		.strict(),
	[T.merge]: z.object({ session: sessionArg }).strict(),
	[T.schedule]: z
		.object({
			action: z.enum(["create", "list", "cancel", "update", "pause", "resume", "run", "runs"]),
			name: z.string().trim().min(1).max(60).optional(),
			prompt: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
			folder: z.string().trim().min(1).max(4096).optional(),
			every_minutes: z
				.number()
				.int()
				.min(1)
				.max(7 * 24 * 60)
				.optional(),
			daily_at: z
				.string()
				.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "daily_at is HH:MM (24 hours)")
				.optional(),
			days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
			at: z
				.string()
				.trim()
				.refine(value => Number.isFinite(Date.parse(value)), "at is an ISO 8601 moment")
				.optional(),
			in_minutes: z
				.number()
				.int()
				.min(1)
				.max(7 * 24 * 60)
				.optional(),
			on: z
				.discriminatedUnion("source", [
					z.object({ source: z.literal("webhook") }).strict(),
					z
						.object({
							source: z.literal("github"),
							repo: z.string().trim().regex(GITHUB_REPO, "repo is owner/name"),
							events: z.array(z.enum(GITHUB_EVENT_KINDS)).min(1).max(GITHUB_EVENT_KINDS.length),
						})
						.strict(),
					z.object({ source: z.literal("files"), path: z.string().trim().min(1).max(4096) }).strict(),
					z
						.object({
							source: z.literal("git"),
							repo: z.string().trim().min(1).max(4096).optional(),
							branch: z.string().trim().min(1).max(250),
						})
						.strict(),
					z
						.object({
							source: z.literal("session"),
							events: z.array(z.enum(SESSION_EVENT_KINDS)).min(1).max(SESSION_EVENT_KINDS.length),
							folder: z.string().trim().min(1).max(4096).optional(),
						})
						.strict(),
				])
				.optional(),
			model: z.string().trim().min(1).max(200).optional(),
			id: z.string().trim().min(1).max(200).optional(),
			device: deviceArg.optional(),
			target: z.enum(["self"]).optional(),
		})
		.strict()
		.superRefine((args, ctx) => {
			const problem = (message: string) => ctx.addIssue({ code: "custom", message });
			const starts = [args.every_minutes, args.daily_at, args.at, args.in_minutes, args.on].filter(
				start => start !== undefined,
			).length;
			if (args.days !== undefined && args.daily_at === undefined) problem("days goes with daily_at");
			if (args.action === "create") {
				if (!args.name) problem("create needs name");
				if (!args.prompt) problem("create needs prompt");
				if (starts !== 1) problem("create needs exactly one of every_minutes, daily_at, at, in_minutes or on");
				if (args.target === "self") {
					if (args.folder !== undefined) problem("target self wakes this session: it takes no folder");
					if (args.model !== undefined) problem("target self wakes this session: it takes no model");
					if (args.device !== undefined)
						problem("target self wakes this session on this computer: it takes no device");
				}
			} else {
				if (args.action !== "list" && !args.id) problem(`${args.action} needs id`);
				if (args.action === "update" && starts > 1)
					problem("update takes at most one of every_minutes, daily_at, at, in_minutes or on");
				if (args.action !== "update" && (starts > 0 || args.name || args.prompt || args.model || args.target))
					problem(`${args.action} takes only id (and device)`);
			}
		}),
	[T.autopilot]: autopilotArgs,
	[T.appList]: z
		.object({ area: z.string().trim().max(60).optional(), query: z.string().trim().max(200).optional() })
		.strict(),
	[T.app]: z.object({ action: z.string().trim().min(1).max(100), args: z.record(z.unknown()).optional() }).strict(),
	[T.bot]: z.discriminatedUnion("action", [
		z.object({ action: z.literal("desk") }).strict(),
		z
			.object({
				action: z.literal("decide"),
				question: z.string().trim().min(1).max(2000),
				options: z.array(z.string().trim().min(1).max(200)).max(BOT_DECISION_OPTIONS_MAX).optional(),
				context: z.string().max(4000).optional(),
				operation: z.string().trim().min(1).max(2000).optional(),
				inputs: z
					.record(z.string().trim().min(1).max(80), z.string().max(2000))
					.refine(inputs => Object.keys(inputs).length <= BOT_DECISION_INPUTS_MAX)
					.optional(),
				draft: z.string().max(BOT_DECISION_DRAFT_MAX).optional(),
				expires_in_minutes: z.number().int().min(1).max(10_080).optional(),
			})
			.strict(),
		z.object({ action: z.literal("duty_add"), text: z.string().trim().min(1).max(BOT_DUTY_TEXT_MAX) }).strict(),
		z.object({ action: z.literal("duty_remove"), id: z.string().trim().min(1).max(64) }).strict(),
		z.object({ action: z.literal("remember"), text: z.string().trim().min(1).max(BOT_MEMORY_TEXT_MAX) }).strict(),
		z.object({ action: z.literal("forget"), id: z.string().trim().min(1).max(64) }).strict(),
		z
			.object({
				action: z.literal("identity"),
				tagline: z.string().trim().max(BOT_TAGLINE_MAX).optional(),
				persona: z.string().trim().max(BOT_PERSONA_MAX).optional(),
				avatar_file: z.string().trim().min(1).max(4096).optional(),
			})
			.strict(),
		z
			.object({ action: z.literal("visited"), limit: z.number().int().min(1).max(BOT_ACTIVITY_PAGE).optional() })
			.strict(),
		z
			.object({ action: z.literal("activity"), limit: z.number().int().min(1).max(BOT_ACTIVITY_PAGE).optional() })
			.strict(),
	]),
} as const;

export type ListArgs = z.infer<(typeof ARGS)[typeof T.list]>;

export type AnswerArgs = z.infer<(typeof ARGS)[typeof T.answer]>;

export type ScheduleArgs = z.infer<(typeof ARGS)[typeof T.schedule]>;

export type BotArgs = z.infer<(typeof ARGS)[typeof T.bot]>;

export type AutopilotArgs = z.infer<typeof autopilotArgs>;
