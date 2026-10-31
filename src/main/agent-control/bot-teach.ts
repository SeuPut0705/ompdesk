/**
 * Teaching the bot by demonstration (the owner's request, 1 Nov 2026; Grok Bot's "record a workflow once"). The owner
 * presses Record, works in OMPdesk as usual and presses Stop: what they did meanwhile reaches the bot as one message
 * that starts its turn, asking it to write a reusable skill with `manage_skill`. Nothing is kept on disk; a relaunch
 * drops a recording.
 *
 * What is recorded, only while it runs and only while the bot is on:
 * - the owner's own prompts to any session but the bot's (an agent's message is never one: `personsPrompt`),
 * - the lines they type in the Terminal panel of a tab this computer runs (assembled from the keystrokes),
 * - at Stop, `git log --oneline --since=<start>` of every folder those sessions work in.
 * Bounded: `TEACH_MAX_PROMPTS`, `TEACH_MAX_LINES`, `TEACH_MAX_COMMITS`, `TEACH_MAX_MS` (then it stops by itself and
 * delivers). A bound shows in the record as `cut at …`, so the bot knows the demonstration was longer.
 *
 * Never a secret. The record goes to a model, so what reaches it passes two gates:
 * - every prompt and every kept terminal line goes through `redactSecretText` (tokens, keys, `Bearer`, URL
 *   passwords, `KEY=value` pairs naming a secret; emails and paths stay, they are the workflow),
 * - a typed line is dropped, leaving `[hidden: …]` in its place, when it was typed where the terminal hides the
 *   typing, which a password is: (a) the last line the terminal printed before the first keystroke asked for one
 *   (`SECRET_PROMPT`: `Password:`, `[sudo] password for x:`, `Enter passphrase for key …:`, a PIN, a token, a
 *   verification code), or (b) the terminal never echoed it. For (b) main watches the terminal's output
 *   (`terminalOutput`, fed by the Terminal IPC) and keeps a line only once the first characters of it turned up in
 *   the output printed since its first keystroke. A line whose echo has not turned up stays hidden, and shows once
 *   it does; the terminal's next line break (or Stop) closes the wait.
 * Known limits: typed lines are reassembled from keystrokes (history recall and tab completion are not seen); a
 * secret in a command that is echoed is found by pattern only; a very short secret typed where something else on the
 * screen holds the same characters is kept.
 */
import { redactSecretText } from "../../../resources/gui-bridge/redactor";
import type { BotTeachRequest, BotTeachResult } from "../../shared/bot-teach";
import { codedError } from "../../shared/ipc-error-codes";
import { gitRaw } from "../local/git/exec";

export const TEACH_MAX_PROMPTS = 200;
export const TEACH_MAX_LINES = 500;
export const TEACH_MAX_COMMITS = 50;
export const TEACH_MAX_MS = 60 * 60_000;
/** One prompt or typed line is cut to this many characters (a pasted log is not the demonstration). */
export const TEACH_PROMPT_CHARS = 1_500;
export const TEACH_LINE_CHARS = 300;

/** What a tab is, as the recorder needs it; `device` is set for a tab a paired computer runs. */
export interface TeachTab {
	title: string;
	cwd: string;
	sessionPath?: string;
	sessionId?: string;
	device?: string;
	deviceName?: string;
}

/** The message that reaches the bot: the record and what it is asked to do with it. */
export interface TeachMail {
	id: string;
	text: string;
	instruction: string;
}

export interface BotTeachDeps {
	/** The owner has the bot on. */
	enabled(): boolean;
	/** The bot's own session file while it is on: its prompts are never recorded. */
	botPath(): string | null;
	tab(tabId: string): TeachTab | null;
	/**
	 * `git log --oneline --since=<since>` of `folder`, newest first, at most `limit` lines; null when `folder` is no
	 * repository (or git cannot run there).
	 */
	commits(folder: string, since: string, limit: number): Promise<string[] | null>;
	/** Hands the bot the record; rejects when it cannot be reached. */
	deliver(mail: TeachMail): Promise<void>;
	/** The recording started or ended: the desk's state changed. */
	changed(): void;
	now(): number;
	log?: (entry: { event: string; [key: string]: unknown }) => void;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}

export const TEACH_INSTRUCTION =
	"The owner just showed you a workflow in OMPdesk (the record above). Turn it into a reusable skill now: write it with your manage_skill tool (action create), named for the task, with a description that says when to use it, and steps general enough to repeat on other input (replace the demonstration's specific names and values with what changes). " +
	"Read a listed session with ompdesk_session_read when its prompts alone do not show what was done. " +
	"Then tell the owner the skill's name and when to use it. Ask with your desk's decide (ompdesk_bot) only if a step is unclear; do not ask about what the record already shows.";

type Event = { at: number; kind: "prompt" | "terminal"; text: string };

interface SessionLog {
	label: TeachTab;
	events: Event[];
}

interface Recording {
	since: number;
	/** Keyed by the session file, or by the tab for a session with none yet. */
	sessions: Map<string, SessionLog>;
	prompts: number;
	lines: number;
	/** What the bounds dropped, for the `cut at` lines. */
	droppedPrompts: number;
	droppedLines: number;
	droppedAfter: number;
	/** What the recorder keeps of each terminal session, by `<tabId>|<terminal id>`. */
	terminals: Map<string, TerminalState>;
	timer: unknown;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function cut(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}… (cut at ${max} characters)`;
}

/**
 * Applies raw terminal input to the line being typed: printable text is added, Backspace (`\x7f`, `\b`), Ctrl-U and
 * Ctrl-W edit it, Ctrl-C drops it, an escape sequence (arrow, function key, mode report) and any other control
 * character are dropped, a bracketed paste keeps its text. Returns the line now being typed and the lines Enter ended
 * (`\r`, `\n`) with something on them.
 */
export function typedLines(pending: string, data: string): { pending: string; lines: string[] } {
	const lines: string[] = [];
	let line = [...pending];
	const chars = [...data];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === "\x1b") {
			const next = chars[i + 1];
			if (next === "[") {
				// CSI: parameter and intermediate bytes, then one final byte.
				let end = i + 2;
				while (end < chars.length && /[\x20-\x3f]/.test(chars[end])) end++;
				i = end;
			} else if (next === "]") {
				// OSC: up to BEL or ESC \.
				let end = i + 2;
				while (end < chars.length && chars[end] !== "\x07" && !(chars[end] === "\x1b" && chars[end + 1] === "\\"))
					end++;
				i = chars[end] === "\x1b" ? end + 1 : end;
			} else if (next === "O") i += 2;
			else i += 1;
			continue;
		}
		if (ch === "\r" || ch === "\n") {
			const text = line.join("").trim();
			if (text) lines.push(text);
			line = [];
		} else if (ch === "\x7f" || ch === "\b") line.pop();
		else if (ch === "\x15" || ch === "\x03") line = [];
		else if (ch === "\x17") {
			while (line.length > 0 && line[line.length - 1] === " ") line.pop();
			while (line.length > 0 && line[line.length - 1] !== " ") line.pop();
		} else if (ch >= " ") line.push(ch);
	}
	return { pending: line.join(""), lines };
}

/** The visible output kept per terminal to see what its last line asked (a prompt that hides the typing). */
const TEACH_TAIL_CHARS = 2_048;
/** What a line being typed keeps of the output since its first keystroke, to look for its echo in. */
const TEACH_SEEN_CHARS = 4_096;
/** A typed line is told apart from nothing by its first this-many characters turning up in the output. */
const TEACH_PROBE_CHARS = 6;
/** An escape sequence cut by a chunk boundary is carried to the next chunk; a longer one is no sequence. */
const ESCAPE_CARRY_CHARS = 256;

export const TEACH_HIDDEN_AT_PROMPT = "[hidden: typed at a password prompt]";
export const TEACH_HIDDEN_NO_ECHO = "[hidden: typed where the terminal showed nothing, as at a password prompt]";

/** The last line of the output asks for a secret: `Password:`, `[sudo] password for x:`, `Enter passphrase for key '…':`, `PIN?`, `Verification code:`. */
const SECRET_PROMPT =
	/\b(?:pass(?:word|phrase|code)?|passwd|pin|token|secret|api[ _-]?key|one[- ]?time|otp|(?:verification|security|authenticat\w*|sms|mfa|totp)\s+code|2fa|credentials?)\b[^\n]*[:?>]\s*$/i;

/** What one line being typed knows: what the terminal's last line asked at its first keystroke, and what came after. */
interface Typing {
	atSecretPrompt: boolean;
	/** The visible output since the first keystroke, from its start (the echo comes first), at most `TEACH_SEEN_CHARS`. */
	seen: string;
}

/** A finished line whose echo has not been seen: it stays hidden unless the terminal prints it. */
interface Awaiting {
	event: Event;
	/** What the event shows once the echo is seen (secrets already redacted). */
	kept: string;
	probe: string;
	seen: string;
}

/** What the recorder keeps of one terminal session, by `<tabId>|<terminal id>`. */
interface TerminalState {
	/** Keystrokes not yet ended by Enter. */
	typing: string;
	line: Typing | null;
	/** The end of the visible output (no escapes, no control characters but newlines). */
	tail: string;
	/** The start of an escape sequence a chunk ended in the middle of. */
	carry: string;
	/** The highest stream offset seen: viewers poll the same terminal, so one stretch of output arrives repeatedly. */
	offset: number | null;
	awaiting: Awaiting[];
}

function startTyping(term: TerminalState): Typing {
	const lastLine = term.tail.slice(term.tail.lastIndexOf("\n") + 1).trim();
	return { atSecretPrompt: SECRET_PROMPT.test(lastLine), seen: "" };
}

/**
 * What a terminal shows of raw PTY output: CSI and OSC sequences, other escapes and control characters (carriage
 * return, bell) are dropped; newlines stay, and so do backspaces, which `printed` applies. `carry` is an escape
 * sequence the chunk ended in the middle of, to be put in front of the next chunk.
 */
export function visibleOutput(carry: string, chunk: string): { text: string; carry: string } {
	const data = carry + chunk;
	let text = "";
	let i = 0;
	const cutOff = (from: number) => ({
		text,
		carry: data.length - from <= ESCAPE_CARRY_CHARS ? data.slice(from) : "",
	});
	while (i < data.length) {
		const ch = data[i] as string;
		if (ch !== "\x1b") {
			if (ch === "\n" || ch === "\b" || (ch >= " " && ch !== "\x7f" && (ch < "\x80" || ch > "\x9f"))) text += ch;
			i++;
			continue;
		}
		const next = data[i + 1];
		if (next === undefined) return cutOff(i);
		if (next === "[") {
			let end = i + 2;
			while (end < data.length && /[\x20-\x3f]/.test(data[end] as string)) end++;
			if (end >= data.length) return cutOff(i);
			i = end + 1;
		} else if (next === "]") {
			let end = i + 2;
			while (end < data.length && data[end] !== "\x07" && !(data[end] === "\x1b" && data[end + 1] === "\\")) {
				if (data[end] === "\x1b" && end + 1 >= data.length) return cutOff(i);
				end++;
			}
			if (end >= data.length) return cutOff(i);
			i = data[end] === "\x07" ? end + 1 : end + 2;
		} else if ("()*+#%O".includes(next)) {
			if (i + 2 >= data.length) return cutOff(i);
			i += 3;
		} else i += 2;
	}
	return { text, carry: "" };
}

/** `text` printed after `buffer`: a backspace takes back the character before it on the same line (`\b \b` erases one). */
function printed(buffer: string, text: string): string {
	if (!text.includes("\b")) return buffer + text;
	let out = buffer;
	for (const ch of text) {
		if (ch !== "\b") out += ch;
		else if (out !== "" && !out.endsWith("\n")) out = out.slice(0, -1);
	}
	return out;
}

export class BotTeach {
	readonly #deps: BotTeachDeps;
	#recording: Recording | null = null;
	/** The stop in flight: a second press waits for it instead of delivering twice. */
	#stopping: Promise<BotTeachResult> | null = null;

	constructor(deps: BotTeachDeps) {
		this.#deps = deps;
	}

	/** The recording as the desk shows it; null while none runs or the bot is off. */
	state(): { since: string } | null {
		return this.#recording && this.#deps.enabled() ? { since: new Date(this.#recording.since).toISOString() } : null;
	}

	/** Records from now. A recording already running goes on as it is. */
	start(): void {
		if (!this.#deps.enabled()) throw codedError("bot_off", "The bot is off on this computer");
		if (this.#recording) return;
		const timer = this.#deps.setTimer(() => void this.#autoStop(), TEACH_MAX_MS);
		this.#recording = {
			since: this.#deps.now(),
			sessions: new Map(),
			prompts: 0,
			lines: 0,
			droppedPrompts: 0,
			droppedLines: 0,
			droppedAfter: 0,
			terminals: new Map(),
			timer,
		};
		this.#deps.changed();
	}

	/** Drops the record. */
	cancel(): void {
		if (!this.#recording) return;
		this.#end();
	}

	/**
	 * Ends the recording and hands the bot the record. Nothing recorded delivers nothing (`delivered: false`). A
	 * delivery that fails leaves the recording as it was, so Stop can be pressed again.
	 */
	stop(): Promise<BotTeachResult> {
		this.#stopping ??= this.#stop().finally(() => {
			this.#stopping = null;
		});
		return this.#stopping;
	}

	async #stop(): Promise<BotTeachResult> {
		const recording = this.#recording;
		if (!recording) return { delivered: false };
		if (!this.#deps.enabled()) {
			this.#end();
			throw codedError("bot_off", "The bot is off on this computer");
		}
		const empty = recording.prompts === 0 && recording.lines === 0;
		if (empty) {
			this.#end();
			return { delivered: false };
		}
		const end = this.#deps.now();
		const text = await this.#recordText(recording, end);
		await this.#deps.deliver({ id: `bot-teach-${recording.since}`, text, instruction: TEACH_INSTRUCTION });
		// The owner may have pressed Cancel while the commits were read; the bot has the record by now either way.
		if (this.#recording === recording) this.#end();
		return { delivered: true };
	}

	async #autoStop(): Promise<void> {
		try {
			await this.stop();
		} catch (error) {
			this.#deps.log?.({ event: "teach-auto-stop-failed", error: String(error) });
		}
	}

	#end(): void {
		const recording = this.#recording;
		if (!recording) return;
		this.#recording = null;
		this.#deps.clearTimer(recording.timer);
		this.#deps.changed();
	}

	/** A prompt the owner sent to `tabId`'s session. */
	prompt(tabId: string, message: string): void {
		const recording = this.#active();
		const tab = recording && this.#deps.tab(tabId);
		if (!recording || !tab || this.#isBot(tab)) return;
		const at = this.#deps.now();
		if (!this.#within(recording, at)) return;
		if (recording.prompts >= TEACH_MAX_PROMPTS) {
			recording.droppedPrompts++;
			return;
		}
		recording.prompts++;
		this.#log(recording, tabId, tab, {
			at,
			kind: "prompt",
			text: cut(redactSecretText(message.trim()), TEACH_PROMPT_CHARS),
		});
	}

	/**
	 * Raw input the owner typed in a Terminal panel session of `tabId` (a tab this computer runs). A line is kept only
	 * when the terminal showed it was typed in the open (see the module comment); otherwise its slot in the record
	 * holds a `[hidden: …]` marker and the text is dropped.
	 */
	terminalWrite(tabId: string, terminalId: string, data: string): void {
		const recording = this.#active();
		const tab = recording && this.#deps.tab(tabId);
		if (!recording || !tab || tab.device || this.#isBot(tab)) return;
		const at = this.#deps.now();
		if (!this.#within(recording, at)) return;
		const term = this.#term(recording, tabId, terminalId);
		const { pending, lines } = typedLines(term.typing, data);
		term.typing = pending;
		let typed = term.line ?? startTyping(term);
		for (const line of lines) {
			this.#completed(recording, tabId, tab, term, typed, line, at);
			typed = startTyping(term);
		}
		term.line = pending ? typed : null;
	}

	/**
	 * What a terminal of `tabId` printed, as one viewer's poll or write answered it: `output` is the text of the
	 * session's stream that ends at `offset`. It is what tells a prompt that hides the typing, and an echo, from
	 * nothing. Only the part past the highest offset seen so far is new, because every viewer of a terminal polls it.
	 */
	terminalOutput(tabId: string, terminalId: string, offset: number, output: string): void {
		const recording = this.#active();
		const tab = recording && this.#deps.tab(tabId);
		// A snapshot with no output (the answer to a write) only names where the stream ends: it says nothing new.
		if (!recording || !tab || tab.device || this.#isBot(tab) || output === "") return;
		const term = this.#term(recording, tabId, terminalId);
		if (term.offset !== null && offset <= term.offset) return;
		const fresh = term.offset === null ? output : output.slice(Math.max(0, output.length - (offset - term.offset)));
		term.offset = offset;
		const { text, carry } = visibleOutput(term.carry, fresh);
		term.carry = carry;
		if (text === "") return;
		term.tail = printed(term.tail, text).slice(-TEACH_TAIL_CHARS);
		if (term.line) term.line.seen = printed(term.line.seen, text).slice(0, TEACH_SEEN_CHARS);
		term.awaiting = term.awaiting.filter(entry => {
			entry.seen = printed(entry.seen, text).slice(0, TEACH_SEEN_CHARS);
			if (entry.seen.includes(entry.probe)) {
				entry.event.text = entry.kept;
				return false;
			}
			// The terminal moved on to a new line without ever printing what was typed: nothing more will.
			return !text.includes("\n");
		});
	}

	#term(recording: Recording, tabId: string, terminalId: string): TerminalState {
		const key = `${tabId}|${terminalId}`;
		let term = recording.terminals.get(key);
		if (!term) {
			term = { typing: "", line: null, tail: "", carry: "", offset: null, awaiting: [] };
			recording.terminals.set(key, term);
		}
		return term;
	}

	/** A line Enter ended: stored now, so the record keeps the order, with the text it may show. */
	#completed(
		recording: Recording,
		tabId: string,
		tab: TeachTab,
		term: TerminalState,
		typed: Typing,
		line: string,
		at: number,
	): void {
		if (recording.lines >= TEACH_MAX_LINES) {
			recording.droppedLines++;
			return;
		}
		recording.lines++;
		const event: Event = { at, kind: "terminal", text: TEACH_HIDDEN_NO_ECHO };
		this.#log(recording, tabId, tab, event);
		if (typed.atSecretPrompt) {
			event.text = TEACH_HIDDEN_AT_PROMPT;
			return;
		}
		const kept = cut(redactSecretText(line), TEACH_LINE_CHARS);
		const probe = [...line].slice(0, TEACH_PROBE_CHARS).join("");
		if (typed.seen.includes(probe)) event.text = kept;
		else term.awaiting.push({ event, kept, probe, seen: typed.seen });
	}

	#active(): Recording | null {
		return this.#recording && this.#deps.enabled() ? this.#recording : null;
	}

	#isBot(tab: TeachTab): boolean {
		const bot = this.#deps.botPath();
		return bot !== null && tab.sessionPath === bot;
	}

	/** Past the time bound nothing more is recorded, and the record says so. */
	#within(recording: Recording, at: number): boolean {
		if (at - recording.since <= TEACH_MAX_MS) return true;
		recording.droppedAfter++;
		return false;
	}

	#log(recording: Recording, tabId: string, tab: TeachTab, event: Event): void {
		const key = tab.sessionPath ?? `tab:${tabId}`;
		const log = recording.sessions.get(key);
		if (log) {
			log.label = tab;
			log.events.push(event);
		} else recording.sessions.set(key, { label: tab, events: [event] });
	}

	async #recordText(recording: Recording, end: number): Promise<string> {
		const since = iso(recording.since);
		const lines = [
			"Demonstration record: the owner showed you a workflow in OMPdesk.",
			`Window: ${since} to ${iso(Math.min(end, recording.since + TEACH_MAX_MS))} (UTC).`,
		];
		const cuts: string[] = [];
		if (recording.droppedPrompts > 0)
			cuts.push(`prompts cut at ${TEACH_MAX_PROMPTS}: ${recording.droppedPrompts} later prompt(s) are not listed.`);
		if (recording.droppedLines > 0)
			cuts.push(`terminal lines cut at ${TEACH_MAX_LINES}: ${recording.droppedLines} later line(s) are not listed.`);
		if (recording.droppedAfter > 0)
			cuts.push(
				`time cut at ${iso(recording.since + TEACH_MAX_MS)} (${TEACH_MAX_MS / 60_000} minutes): what the owner did after it is not listed.`,
			);
		for (const cutLine of cuts) lines.push(`Record ${cutLine}`);
		lines.push(
			"",
			`Sessions the owner worked in (${recording.sessions.size}), each with the owner's own prompts and the lines they typed in its terminal, in order. Read a session with ompdesk_session_read to see the tool calls its prompts started.`,
		);
		const folders = new Set<string>();
		for (const { label, events } of recording.sessions.values()) {
			const where = label.device ? ` on ${label.deviceName ?? label.device}` : "";
			const saved = label.sessionId
				? `session id ${label.sessionId}${label.sessionPath ? `, file ${label.sessionPath}` : ""}`
				: label.sessionPath
					? `file ${label.sessionPath}`
					: "not saved yet";
			lines.push("", `Session "${label.title || "untitled"}"${where}: folder ${label.cwd}; ${saved}`);
			for (const event of events)
				lines.push(`  ${iso(event.at)} ${event.kind}: ${event.text.split("\n").join("\n    ")}`);
			if (!label.device) folders.add(label.cwd);
		}
		lines.push("", ...(await this.#commitLines([...folders], since)));
		return lines.join("\n");
	}

	async #commitLines(folders: string[], since: string): Promise<string[]> {
		const out = [`Commits that landed meanwhile (git log --oneline --since=${since}), per folder worked in:`];
		let left = TEACH_MAX_COMMITS;
		let any = false;
		let cutAt = false;
		for (const folder of folders) {
			if (left <= 0) {
				cutAt = true;
				break;
			}
			const commits = await this.#deps.commits(folder, since, left + 1).catch(error => {
				this.#deps.log?.({ event: "teach-git-failed", folder, error: String(error) });
				return null;
			});
			if (!commits || commits.length === 0) continue;
			any = true;
			const kept = commits.slice(0, left);
			if (commits.length > kept.length) cutAt = true;
			left -= kept.length;
			out.push(`  ${folder}`, ...kept.map(commit => `    ${commit}`));
		}
		if (!any) out.push("  none");
		if (cutAt) out.push(`Commits cut at ${TEACH_MAX_COMMITS}: more landed than are listed.`);
		return out;
	}
}

/** `git log --oneline --since=<since>` of `folder` (newest first, at most `limit` lines); null when it is no repository. */
export async function gitCommits(folder: string, since: string, limit: number): Promise<string[] | null> {
	const result = await gitRaw(folder, ["log", "--oneline", "--no-decorate", `--since=${since}`, "-n", String(limit)], {
		timeoutMs: 10_000,
	});
	if (result.code !== 0) return null;
	return result.stdout
		.toString("utf8")
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

/** The IPC and host handler: one entry for `BOT_TEACH` and `host.botDesk.teach`. */
export function teachAction(teach: BotTeach, request: BotTeachRequest): Promise<BotTeachResult> {
	switch (request.action) {
		case "start":
			teach.start();
			return Promise.resolve({ delivered: false });
		case "cancel":
			teach.cancel();
			return Promise.resolve({ delivered: false });
		case "stop":
			return teach.stop();
	}
}
