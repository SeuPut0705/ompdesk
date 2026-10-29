/**
 * `ompdesk`: drives a running OMPdesk from a terminal, a script or another agent CLI, the way OMPdesk's own agents
 * use the `ompdesk_*` host tools. Run by bun (`bun ompdesk.ts <command>`); only `node:` modules and `./protocol`.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
	CALLER_NAME,
	CONTROL_CALLER_ENV,
	CONTROL_DIR_ENV,
	CONTROL_OFF_ENV,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SOCKET_ENV,
	type ControlError,
	type ControlEvent,
	type ControlRequest,
	type ControlResponse,
	ENDPOINT_FILE,
	type EventFrame,
	MAX_FRAME_BYTES,
	type SendResult,
	type SessionStatus,
	TOKEN_FILE,
	type ToolResult,
	WAIT_UNTIL,
	type WaitResult,
} from "./protocol";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_RUNNING = 3;

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
/** A request without its `id` (the connection numbers them). */
type Wire = Distribute<ControlRequest>;
export type Body = Exclude<Wire, { method: "hello" }>;

export interface RunCommand {
	kind: "run";
	body: Body;
	/** `-` was given: main reads stdin and puts it at `path` of the body (parsed as JSON when `json`). */
	stdin?: { path: string[]; json: boolean };
	socket?: string;
	caller?: string;
	json: boolean;
}
export interface HelpCommand {
	kind: "help";
	topic?: string;
}
export type Command = RunCommand | HelpCommand;
export interface UsageError {
	kind: "usage";
	message: string;
}

type Kind = "s" | "b" | "n" | "m";
interface Parsed {
	v: Record<string, unknown>;
	pos: string[];
}
interface Built {
	body: Body;
	stdin?: RunCommand["stdin"];
}
interface Spec {
	usage: string;
	summary: string;
	flags: Record<string, Kind>;
	min: number;
	max: number;
	build(p: Parsed): Built;
}

class Usage extends Error {}
const fail = (message: string): never => {
	throw new Usage(message);
};

const key = (flag: string): string => flag.replace(/-/g, "_");
const str = (p: Parsed, flag: string): string | undefined => p.v[flag] as string | undefined;
const bool = (p: Parsed, flag: string): boolean | undefined => (p.v[flag] === true ? true : undefined);
const num = (p: Parsed, flag: string): number | undefined => p.v[flag] as number | undefined;
const list = (p: Parsed, flag: string): string[] | undefined => p.v[flag] as string[] | undefined;

/** The named flags that were given, as a tool's args (flag `request-id` is `request_id`). */
function args(p: Parsed, names: string[], rename: Record<string, string> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const name of names) if (p.v[name] !== undefined) out[rename[name] ?? key(name)] = p.v[name];
	return out;
}
const tool = (name: string, a: Record<string, unknown>): Built => ({ body: { method: "tool", tool: name, args: a } });

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
	if (value === undefined) return undefined;
	if (!(allowed as readonly string[]).includes(value)) fail(`--${flag} is one of ${allowed.join(", ")}`);
	return value as T;
}

function parseJson(text: string, what: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return fail(`${what} is not valid JSON`);
	}
}

/** A positional that may be `-` (read stdin): the value goes at `path`, or is left to main. */
function textArg(value: string | undefined, built: Built, path: string[], target: Record<string, unknown>): Built {
	if (value === undefined) return built;
	const field = path[path.length - 1] as string;
	if (value === "-") return { ...built, stdin: { path, json: false } };
	target[field] = value;
	return built;
}

const SPECS: Record<string, Spec> = {
	sessions: {
		usage: "sessions [--scope window|app|stored] [--device D] [--folder TEXT] [--status running|waiting|idle] [--mine] [--query TEXT] [--limit N]",
		summary: "List sessions (ompdesk_sessions).",
		flags: { scope: "s", device: "s", folder: "s", status: "s", mine: "b", query: "s", limit: "n" },
		min: 0,
		max: 0,
		build: p => {
			oneOf(str(p, "scope"), ["window", "app", "stored"], "scope");
			oneOf(str(p, "status"), ["running", "waiting", "idle"], "status");
			return tool("ompdesk_sessions", args(p, ["scope", "device", "folder", "status", "mine", "query", "limit"]));
		},
	},
	open: {
		usage: "open [MESSAGE|-] [--folder F] [--device D] [--model M] [--mode plan|goal] [--worktree [--branch B] [--base REF]] [--reopen ID [--restore]] [--show background|focus|split-right|split-down]",
		summary: "Open a session (ompdesk_session_open); MESSAGE `-` reads stdin.",
		flags: {
			folder: "s",
			device: "s",
			model: "s",
			mode: "s",
			worktree: "b",
			branch: "s",
			base: "s",
			reopen: "s",
			restore: "b",
			show: "s",
		},
		min: 0,
		max: 1,
		build: p => {
			oneOf(str(p, "mode"), ["plan", "goal"], "mode");
			oneOf(str(p, "show"), ["background", "focus", "split-right", "split-down"], "show");
			const a = args(p, ["folder", "device", "model", "mode", "reopen", "restore", "show"]);
			const branch = str(p, "branch");
			const base = str(p, "base");
			if (branch !== undefined || base !== undefined) {
				a.worktree = { ...(branch !== undefined && { branch }), ...(base !== undefined && { base }) };
			} else if (bool(p, "worktree")) a.worktree = true;
			return textArg(p.pos[0], tool("ompdesk_session_open", a), ["args", "message"], a);
		},
	},
	send: {
		usage: "send SESSION MESSAGE|- [--steer] [--request-id ID] [--force] [--wait] [--until idle|blocked|done|any] [--timeout SECONDS]",
		summary: "Message a session; --wait returns after its turn. Refused while it waits on the person unless --force.",
		flags: { steer: "b", "request-id": "s", force: "b", wait: "b", until: "s", timeout: "n" },
		min: 2,
		max: 2,
		build: p => {
			const until = oneOf(str(p, "until"), WAIT_UNTIL, "until");
			const timeout = num(p, "timeout");
			const wait = bool(p, "wait") || until !== undefined || timeout !== undefined;
			const body: Extract<Body, { method: "send" }> = {
				method: "send",
				session: p.pos[0] as string,
				message: p.pos[1] === "-" ? "" : (p.pos[1] as string),
				...(bool(p, "steer") && { delivery: "steer" as const }),
				...(str(p, "request-id") !== undefined && { requestId: str(p, "request-id") }),
				...(bool(p, "force") && { force: true }),
				...(wait && {
					wait: {
						...(until !== undefined && { until }),
						...(timeout !== undefined && { timeoutMs: timeout * 1000 }),
					},
				}),
			};
			return p.pos[1] === "-" ? { body, stdin: { path: ["message"], json: false } } : { body };
		},
	},
	wait: {
		usage: "wait SESSION [--until idle|blocked|done|any] [--timeout SECONDS]",
		summary: "Wait for a session to settle (idle or blocked), or for --until.",
		flags: { until: "s", timeout: "n" },
		min: 1,
		max: 1,
		build: p => {
			const until = oneOf(str(p, "until"), WAIT_UNTIL, "until");
			const timeout = num(p, "timeout");
			return {
				body: {
					method: "wait",
					session: p.pos[0] as string,
					...(until !== undefined && { until }),
					...(timeout !== undefined && { timeoutMs: timeout * 1000 }),
				},
			};
		},
	},
	state: {
		usage: "state SESSION",
		summary: "A session's state: working, blocked, idle, starting or stopped.",
		flags: {},
		min: 1,
		max: 1,
		build: p => ({ body: { method: "state", session: p.pos[0] as string } }),
	},
	result: {
		usage: "result SESSION... [--wait] [--until all|any] [--timeout SECONDS]",
		summary: "A session's last answer (ompdesk_session_result).",
		flags: { wait: "b", until: "s", timeout: "n" },
		min: 1,
		max: Number.POSITIVE_INFINITY,
		build: p => {
			oneOf(str(p, "until"), ["all", "any"], "until");
			const a = args(p, ["wait", "until"], {});
			if (num(p, "timeout") !== undefined) a.timeout_seconds = num(p, "timeout");
			if (p.pos.length === 1) a.session = p.pos[0];
			else a.sessions = p.pos;
			return tool("ompdesk_session_result", a);
		},
	},
	read: {
		usage: "read SESSION [--limit N] [--before CURSOR]",
		summary: "Read a session's transcript, newest first (ompdesk_session_read).",
		flags: { limit: "n", before: "s" },
		min: 1,
		max: 1,
		build: p => tool("ompdesk_session_read", { session: p.pos[0], ...args(p, ["limit", "before"]) }),
	},
	answer: {
		usage: "answer SESSION [--request ID] [--choice TEXT] [--approve | --deny] [--text TEXT|-] [--answers JSON]",
		summary: "Answer a session's question or approval (ompdesk_session_answer).",
		flags: { request: "s", choice: "s", approve: "b", deny: "b", text: "s", answers: "s" },
		min: 1,
		max: 1,
		build: p => {
			if (bool(p, "approve") && bool(p, "deny")) fail("--approve and --deny exclude each other");
			const a: Record<string, unknown> = { session: p.pos[0], ...args(p, ["request", "choice"]) };
			if (bool(p, "approve")) a.approve = true;
			if (bool(p, "deny")) a.approve = false;
			if (str(p, "answers") !== undefined) a.answers = parseJson(str(p, "answers") as string, "--answers");
			return str(p, "text") === "-"
				? { ...tool("ompdesk_session_answer", a), stdin: { path: ["args", "text"], json: false } }
				: tool("ompdesk_session_answer", { ...a, ...args(p, ["text"]) });
		},
	},
	stop: {
		usage: "stop SESSION [--close] [--delete] [--device D]",
		summary: "Stop a session's work; --close closes its tab, --delete removes it.",
		flags: { close: "b", delete: "b", device: "s" },
		min: 1,
		max: 1,
		build: p => tool("ompdesk_session_stop", { session: p.pos[0], ...args(p, ["close", "delete", "device"]) }),
	},
	show: {
		usage: "show SESSION [--how focus|split-right|split-down]",
		summary: "Bring a session's tab forward (ompdesk_tab_focus).",
		flags: { how: "s" },
		min: 1,
		max: 1,
		build: p => {
			oneOf(str(p, "how"), ["focus", "split-right", "split-down"], "how");
			return tool("ompdesk_tab_focus", { session: p.pos[0], ...args(p, ["how"]) });
		},
	},
	notify: {
		usage: "notify TITLE [--body TEXT]",
		summary: "Raise a notification for the person (ompdesk_notify).",
		flags: { body: "s" },
		min: 1,
		max: 1,
		build: p => tool("ompdesk_notify", { title: p.pos[0], ...args(p, ["body"]) }),
	},
	compare: {
		usage: "compare [SESSION...] [--criteria TEXT]...",
		summary: "Evidence and a ranked verdict over sessions (ompdesk_compare).",
		flags: { criteria: "m" },
		min: 0,
		max: Number.POSITIVE_INFINITY,
		build: p => tool("ompdesk_compare", { ...(p.pos.length > 0 && { sessions: p.pos }), ...args(p, ["criteria"]) }),
	},
	merge: {
		usage: "merge SESSION",
		summary: "Merge a session's worktree branch (ompdesk_merge).",
		flags: {},
		min: 1,
		max: 1,
		build: p => tool("ompdesk_merge", { session: p.pos[0] }),
	},
	report: {
		usage: "report KIND TEXT|- [--file F]... [--pass CMD]... [--fail CMD]... [--to SESSION] [--dispatch ID] [--id ID]",
		summary: "Send a report (ompdesk_report): kind progress, done, blocked, question, review or note.",
		flags: { file: "m", pass: "m", fail: "m", to: "s", dispatch: "s", id: "s" },
		min: 2,
		max: 2,
		build: p => {
			const a: Record<string, unknown> = { kind: p.pos[0], ...args(p, ["to", "dispatch", "id"]) };
			if (list(p, "file")) a.files = list(p, "file");
			const checks = [
				...(list(p, "pass") ?? []).map(command => ({ command, passed: true })),
				...(list(p, "fail") ?? []).map(command => ({ command, passed: false })),
			];
			if (checks.length > 0) a.checks = checks;
			return textArg(p.pos[1], tool("ompdesk_report", a), ["args", "text"], a);
		},
	},
	schedule: {
		usage: "schedule create|list|cancel [--name N] [--prompt TEXT|-] [--folder F] [--every-minutes N | --daily-at HH:MM [--days 0,1,..]] [--model M] [--id ID] [--device D]",
		summary: "Recurring runs (ompdesk_schedule).",
		flags: {
			name: "s",
			prompt: "s",
			folder: "s",
			"every-minutes": "n",
			"daily-at": "s",
			days: "s",
			model: "s",
			id: "s",
			device: "s",
		},
		min: 1,
		max: 1,
		build: p => {
			const action = oneOf(p.pos[0], ["create", "list", "cancel"], "action") as string;
			const a: Record<string, unknown> = {
				action,
				...args(p, ["name", "folder", "every-minutes", "daily-at", "model", "id", "device"]),
			};
			const days = str(p, "days");
			if (days !== undefined) {
				a.days = days.split(",").map(day => {
					const n = Number(day);
					return Number.isInteger(n) ? n : fail("--days is a comma list of 0-6");
				});
			}
			return str(p, "prompt") === "-"
				? { ...tool("ompdesk_schedule", a), stdin: { path: ["args", "prompt"], json: false } }
				: tool("ompdesk_schedule", { ...a, ...args(p, ["prompt"]) });
		},
	},
	autopilot: {
		usage: "autopilot start|status|stop [SESSION] [--folder F] [--device D] [--guide TEXT] [--ship commit|push|release] [--branch NAME [--new-branch]] [--now]",
		summary: "Endless repo improvement (ompdesk_autopilot); `stop` and `status` name a session.",
		flags: { folder: "s", device: "s", guide: "s", ship: "s", branch: "s", "new-branch": "b", now: "b" },
		min: 1,
		max: 2,
		build: p => {
			const action = oneOf(p.pos[0], ["start", "status", "stop"], "action") as string;
			oneOf(str(p, "ship"), ["commit", "push", "release"], "ship");
			const a: Record<string, unknown> = { action, ...args(p, ["folder", "device", "guide", "ship", "now"]) };
			if (p.pos[1] !== undefined) a.session = p.pos[1];
			const branch = str(p, "branch");
			if (bool(p, "new-branch")) a.branch = { kind: "new", ...(branch !== undefined && { name: branch }) };
			else if (branch !== undefined) a.branch = { kind: "existing", name: branch };
			return tool("ompdesk_autopilot", a);
		},
	},
	app: {
		usage: "app list [--area A] [--query TEXT]  |  app ACTION [JSON|-]",
		summary:
			"List (ompdesk_app_list) or run (ompdesk_app) an OMPdesk setting or view action; JSON is the action's args.",
		flags: { area: "s", query: "s" },
		min: 1,
		max: 2,
		build: p => {
			if (p.pos[0] === "list") {
				if (p.pos.length > 1) fail("app list takes no argument");
				return tool("ompdesk_app_list", args(p, ["area", "query"]));
			}
			if (str(p, "area") !== undefined || str(p, "query") !== undefined) fail("--area and --query go with app list");
			const inner = p.pos[1];
			const built = tool("ompdesk_app", { action: p.pos[0] });
			if (inner === undefined) return built;
			if (inner === "-") return { ...built, stdin: { path: ["args", "args"], json: true } };
			return tool("ompdesk_app", { action: p.pos[0], args: parseJson(inner, "the action args") });
		},
	},
	call: {
		usage: "call TOOL [JSON|-]",
		summary: "Call any ompdesk_* tool with raw JSON args.",
		flags: {},
		min: 1,
		max: 2,
		build: p => {
			const name = p.pos[0] as string;
			const inner = p.pos[1];
			if (inner === undefined) return tool(name, {});
			if (inner === "-") return { ...tool(name, {}), stdin: { path: ["args"], json: true } };
			return tool(name, parseJson(inner, "the args") as Record<string, unknown>);
		},
	},
	events: {
		usage: "events",
		summary: "Print one line per event (state changes, asks, finished turns, reports) until interrupted.",
		flags: {},
		min: 0,
		max: 0,
		build: () => ({ body: { method: "subscribe" } }),
	},
};

const GLOBAL_FLAGS = "[--json] [--socket PATH] [--caller NAME]";

export function helpText(topic?: string): string {
	if (topic !== undefined && topic !== "help") {
		const spec = SPECS[topic];
		if (spec) return `ompdesk ${spec.usage}\n${spec.summary}\nFlags for every command: ${GLOBAL_FLAGS}\n`;
		return `ompdesk: unknown command "${topic}"\n${helpText()}`;
	}
	const rows = Object.entries(SPECS).map(([name, spec]) => `  ${name.padEnd(10)}${spec.summary}`);
	return [
		"ompdesk: drive a running OMPdesk from a terminal, a script or another agent. Works inside or outside OMPdesk.",
		"",
		`Usage: ompdesk <command> [args] ${GLOBAL_FLAGS}`,
		"",
		...rows,
		"  help      `ompdesk help <command>` shows a command's flags.",
		"",
		"A message argument of `-` reads it from stdin. --json prints the raw result (or {ok:false,error}) as JSON.",
		"Exit codes: 0 ok, 1 failed (tool error, agent_blocked, timeout, session_gone, events_lost), 2 usage, 3 OMPdesk not running or refused.",
		"",
	].join("\n");
}

function optionsFor(spec: Spec): NonNullable<Parameters<typeof parseArgs>[0]>["options"] {
	const options: NonNullable<Parameters<typeof parseArgs>[0]>["options"] = {
		json: { type: "boolean" },
		help: { type: "boolean", short: "h" },
		socket: { type: "string" },
		caller: { type: "string" },
	};
	for (const [flag, kind] of Object.entries(spec.flags)) {
		options[flag] =
			kind === "b" ? { type: "boolean" } : kind === "m" ? { type: "string", multiple: true } : { type: "string" };
	}
	return options;
}

export function parse(argv: readonly string[]): Command | UsageError {
	const [name, ...rest] = argv;
	if (name === undefined || name === "--help" || name === "-h") return { kind: "help" };
	if (name === "help")
		return rest.length > 1 ? { kind: "usage", message: "help takes one command" } : { kind: "help", topic: rest[0] };
	const spec = SPECS[name];
	if (!spec) return { kind: "usage", message: `unknown command "${name}"` };
	try {
		const parsed = parseArgs({ args: rest, options: optionsFor(spec), allowPositionals: true, strict: true });
		const values: Record<string, string | boolean | (string | boolean)[] | undefined> = parsed.values;
		const positionals = parsed.positionals;
		if (values.help) return { kind: "help", topic: name };
		const v: Record<string, unknown> = {};
		for (const [flag, kind] of Object.entries(spec.flags)) {
			const value = values[flag];
			if (value === undefined) continue;
			if (kind === "n") {
				const n = Number(value);
				if (!Number.isFinite(n) || n < 0 || (value as string).trim() === "") fail(`--${flag} is a number`);
				v[flag] = n;
			} else v[flag] = value;
		}
		if (positionals.length < spec.min) fail(`${name} needs ${spec.usage.split(/\s+/)[1] ?? "an argument"}`);
		if (positionals.length > spec.max) fail(`${name} takes at most ${spec.max} argument${spec.max === 1 ? "" : "s"}`);
		const built = spec.build({ v, pos: positionals });
		return {
			kind: "run",
			body: built.body,
			...(built.stdin && { stdin: built.stdin }),
			...(typeof values.socket === "string" && { socket: values.socket }),
			...(typeof values.caller === "string" && { caller: values.caller }),
			json: values.json === true,
		};
	} catch (error) {
		return {
			kind: "usage",
			message: error instanceof Error ? error.message.replace(/\. If you want to use .*$/, "") : String(error),
		};
	}
}

export function controlDir(env: Record<string, string | undefined>, platform: string, home: string): string {
	const explicit = env[CONTROL_DIR_ENV];
	if (explicit) return explicit;
	if (platform === "darwin") return join(home, "Library", "Application Support", "ompdesk", "control");
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "ompdesk", "control");
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "ompdesk", "control");
}

export interface Io {
	stdout(text: string): void;
	stderr(text: string): void;
	readStdin(): Promise<string>;
	env: Record<string, string | undefined>;
	platform: string;
	home: string;
	cwd: string;
	/** Ends `events` (the process's SIGINT). */
	signal?: AbortSignal;
	/** This user's uid (tests); absent: `process.getuid`. */
	getuid?: () => number;
}

class Refused extends Error {}
interface Connection {
	request(body: Wire): Promise<ControlResponse>;
	onFrame(handler: (frame: EventFrame) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

function open(path: string): Promise<Connection> {
	return new Promise((resolve, reject) => {
		const socket: Socket = createConnection(path);
		let next = 1;
		let buffer = "";
		let closed = false;
		const pending = new Map<number, (response: ControlResponse) => void>();
		let frameHandler: (frame: EventFrame) => void = () => {};
		let closeHandler: () => void = () => {};
		const goneResponse = (id: number): ControlResponse => ({
			id,
			ok: false,
			error: { code: "unavailable", message: "OMPdesk closed the connection" },
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				if (line.trim() === "") continue;
				let frame: unknown;
				try {
					frame = JSON.parse(line);
				} catch {
					continue;
				}
				if (typeof frame !== "object" || frame === null) continue;
				if ("sub" in frame) frameHandler(frame as EventFrame);
				else if ("id" in frame && "ok" in frame) {
					const response = frame as ControlResponse;
					pending.get(response.id)?.(response);
					pending.delete(response.id);
				}
			}
			if (buffer.length > MAX_FRAME_BYTES) socket.destroy();
		});
		const finish = () => {
			if (closed) return;
			closed = true;
			for (const [id, settle] of pending) settle(goneResponse(id));
			pending.clear();
			closeHandler();
		};
		socket.on("close", finish);
		let connected = false;
		socket.once("connect", () => {
			connected = true;
			resolve({
				request: body =>
					new Promise(settle => {
						if (closed) return settle(goneResponse(0));
						const id = next++;
						pending.set(id, settle);
						socket.write(`${JSON.stringify({ ...body, id })}\n`);
					}),
				onFrame: handler => {
					frameHandler = handler;
				},
				onClose: handler => {
					closeHandler = handler;
				},
				close: () => socket.destroy(),
			});
		});
		socket.on("error", error => {
			if (!connected) reject(new Refused(`OMPdesk is not running (${error.message})`));
			else socket.destroy();
		});
	});
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
	let at = target;
	for (const part of path.slice(0, -1)) {
		const next = at[part];
		if (typeof next === "object" && next !== null) at = next as Record<string, unknown>;
		else {
			const made: Record<string, unknown> = {};
			at[part] = made;
			at = made;
		}
	}
	at[path[path.length - 1] as string] = value;
}

/**
 * POSIX: the socket, its folder and the token must be this user's alone before the token goes anywhere, so a socket
 * another user planted (or one whose folder others can write) never receives it. Windows has no such check from Node
 * (a pipe's server cannot be identified); there the pipe's name is unguessable and published only in this user's files.
 */
function ownerOnly(path: string, what: string, io: Io): void {
	if (io.platform === "win32") return;
	const uid = (io.getuid ?? process.getuid)?.();
	const stat = lstatSync(path);
	if (uid !== undefined && stat.uid !== uid) throw new Refused(`refused: ${what} ${path} belongs to another user`);
	if ((stat.mode & 0o077) !== 0) throw new Refused(`refused: ${what} ${path} is open to other users`);
}

function readEndpoint(command: RunCommand, io: Io): { path: string; token: string } {
	if (io.env[CONTROL_OFF_ENV] === "1")
		throw new Refused(
			"OMPdesk control is off in a session OMPdesk runs for another device (a paired computer or the phone page)",
		);
	const dir = controlDir(io.env, io.platform, io.home);
	const tokenFile = join(dir, TOKEN_FILE);
	let path = command.socket ?? io.env[CONTROL_SOCKET_ENV];
	if (!path) {
		const file = join(dir, ENDPOINT_FILE);
		if (!existsSync(file)) throw new Refused(`OMPdesk is not running (no ${file})`);
		try {
			const endpoint: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (
				typeof endpoint === "object" &&
				endpoint !== null &&
				"socket" in endpoint &&
				typeof endpoint.socket === "string"
			) {
				path = endpoint.socket;
			}
		} catch {
			throw new Refused(`${file} is unreadable`);
		}
		if (!path) throw new Refused(`${file} names no socket`);
	}
	if (!existsSync(tokenFile)) throw new Refused(`OMPdesk is not running or its token is missing (${tokenFile})`);
	if (io.platform !== "win32" && !existsSync(path)) throw new Refused(`OMPdesk is not running (no ${path})`);
	ownerOnly(dirname(path), "socket folder", io);
	ownerOnly(path, "socket", io);
	ownerOnly(tokenFile, "token", io);
	return { path, token: readFileSync(tokenFile, "utf8").trim() };
}

function callerName(command: RunCommand, io: Io): string | undefined {
	const name = command.caller ?? io.env[CONTROL_CALLER_ENV];
	return name !== undefined && CALLER_NAME.test(name) ? name : undefined;
}

function line(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

function status(s: SessionStatus): string {
	return `${s.session}  ${s.state}  ${s.title}`;
}
function waited(w: WaitResult): string {
	return `${status(w)}  (${w.matched}${w.stopReason ? `, stop reason ${w.stopReason}` : ""})`;
}

export function formatEvent(event: ControlEvent): string {
	switch (event.type) {
		case "session_state":
			return `session_state ${event.session} ${event.previous ?? "-"} -> ${event.state}  ${event.title}`;
		case "ask":
			return `ask ${event.session} ${event.requestId}  ${event.title}: ${event.text.replace(/\s+/g, " ")}`;
		case "turn_finished":
			return `turn_finished ${event.session} ${event.stopReason}  ${event.title}`;
		case "session_closed":
			return `session_closed ${event.session}`;
		case "report":
			return `report to ${event.to}: ${event.text.replace(/\s+/g, " ")}`;
	}
}

function render(body: Body, result: unknown): string {
	switch (body.method) {
		case "tool":
			return (result as ToolResult).text;
		case "state":
			return status(result as SessionStatus);
		case "wait":
			return waited(result as WaitResult);
		case "send": {
			const sent = result as SendResult;
			return sent.waited ? `${sent.receipt}\n${waited(sent.waited)}` : sent.receipt;
		}
		default:
			return JSON.stringify(result);
	}
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
	const command = parse(argv);
	if (command.kind === "usage") {
		io.stderr(`ompdesk: ${command.message}\nRun \`ompdesk help\` for the commands.\n`);
		return EXIT_USAGE;
	}
	if (command.kind === "help") {
		io.stdout(helpText(command.topic));
		return command.topic !== undefined && command.topic !== "help" && !SPECS[command.topic] ? EXIT_USAGE : EXIT_OK;
	}

	const body = structuredClone(command.body) as Body;
	if (command.stdin) {
		let text = await io.readStdin();
		if (!command.stdin.json) text = text.replace(/\n$/, "");
		let value: unknown = text;
		if (command.stdin.json) {
			try {
				value = JSON.parse(text);
			} catch {
				io.stderr("ompdesk: stdin is not valid JSON\n");
				return EXIT_USAGE;
			}
		}
		setPath(body as unknown as Record<string, unknown>, command.stdin.path, value);
	}

	const failure = (error: ControlError): number => {
		if (command.json) io.stdout(`${JSON.stringify({ ok: false, error })}\n`);
		io.stderr(`ompdesk: ${error.code}: ${error.message}\n`);
		return error.code === "unauthorized" || error.code === "protocol_mismatch" ? EXIT_NOT_RUNNING : EXIT_FAILED;
	};

	let connection: Connection;
	try {
		const endpoint = readEndpoint(command, io);
		connection = await open(endpoint.path);
		const hello = await connection.request({
			method: "hello",
			token: endpoint.token,
			protocol: CONTROL_PROTOCOL_VERSION,
			caller: callerName(command, io),
			cwd: io.cwd,
		});
		if (!hello.ok) {
			connection.close();
			return failure(hello.error);
		}
	} catch (error) {
		io.stderr(`ompdesk: ${error instanceof Error ? error.message : String(error)}\n`);
		if (command.json)
			io.stdout(
				`${JSON.stringify({ ok: false, error: { code: "unavailable", message: "OMPdesk is not running" } })}\n`,
			);
		return EXIT_NOT_RUNNING;
	}

	try {
		if (body.method === "subscribe") return await follow(connection, body, command, io, failure);
		const response = await connection.request(body);
		if (!response.ok) return failure(response.error);
		if (command.json) io.stdout(`${JSON.stringify(response.result)}\n`);
		if (body.method === "tool" && (response.result as ToolResult).isError) {
			io.stderr(line(`ompdesk: ${(response.result as ToolResult).text}`));
			return EXIT_FAILED;
		}
		if (!command.json) io.stdout(line(render(body, response.result)));
		return EXIT_OK;
	} finally {
		connection.close();
	}
}

function follow(
	connection: Connection,
	body: Body,
	command: RunCommand,
	io: Io,
	failure: (error: ControlError) => number,
): Promise<number> {
	return new Promise(resolve => {
		let done = false;
		const end = (code: number) => {
			if (done) return;
			done = true;
			resolve(code);
		};
		connection.onFrame(frame => {
			if ("error" in frame) {
				const lost =
					frame.error.code === "events_lost" && frame.error.lost !== undefined
						? ` (${frame.error.lost} lost)`
						: "";
				end(failure({ code: frame.error.code, message: frame.error.message + lost }));
			} else io.stdout(command.json ? `${JSON.stringify(frame.event)}\n` : `${formatEvent(frame.event)}\n`);
		});
		connection.onClose(() => {
			io.stderr("ompdesk: OMPdesk closed the connection\n");
			end(EXIT_NOT_RUNNING);
		});
		io.signal?.addEventListener("abort", () => end(EXIT_OK), { once: true });
		void connection.request(body).then(response => {
			if (!response.ok) end(failure(response.error));
		});
	});
}

async function readAllStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function isEntry(): boolean {
	const meta = import.meta as ImportMeta & { main?: boolean };
	if (typeof meta.main === "boolean") return meta.main;
	return process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
}

if (isEntry()) {
	const abort = new AbortController();
	process.once("SIGINT", () => abort.abort());
	const code = await main(process.argv.slice(2), {
		stdout: text => void process.stdout.write(text),
		stderr: text => void process.stderr.write(text),
		readStdin: readAllStdin,
		env: process.env,
		platform: process.platform,
		home: homedir(),
		cwd: process.cwd(),
		signal: abort.signal,
	});
	process.exitCode = code;
	// A subscription or a pipe may keep the loop alive; the answer is in.
	setTimeout(() => process.exit(code), 50).unref?.();
}
