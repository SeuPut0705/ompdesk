/**
 * What the memory extension and the app both need to know about a session: what the session is about (the title a
 * session page is filed under), whether the session is a child (a subagent, or a session another agent opened) that
 * must neither create nor consume a handoff, the conclusion a turn ended on, and the checkout its folder belongs to.
 *
 * Imports only `./redactor` on purpose: the ai-memory build embeds both files into the omp extension it generates
 * (`native/memory` `install_hooks.rs`, `include_str!`; the extension drops this one import line, the redactor sits
 * above it). It lives in the gui-bridge folder so every side reads the one rule: the bridge (memory recall names a
 * recalled conclusion by it), main (the one-time retitle, the learning pass) and the tests. The wrapper tag, the
 * `Title:` label and stock's subagent prefix are the same protocol lines `agent-control.ts` and
 * `subagent-title-contracts.ts` read; `memory-prompt.test.ts` keeps the three in step.
 */
import { redactDiagnosticsText } from "./redactor";

const AGENT_MESSAGE_TAG = "ompdesk-agent-message";
const WRAPPED_START = new RegExp(`^<${AGENT_MESSAGE_TAG} from="[^"]*">[ \\t]*(?:\\r?\\n|$)`);
const WRAPPED_END = new RegExp(`(?:\\r?\\n|^)[ \\t]*</${AGENT_MESSAGE_TAG}>[ \\t]*$`);
/** Stock wraps every subagent assignment in `prompts/system/subagent-user-prompt.md`. */
const STOCK_PREFIX = /^Complete assignment thoroughly:[ \t]*(?:\r?\n|$)/i;
/** The preamble ai-memory's own title rule already knows as scaffolding. */
const SUBAGENT_PREAMBLE = /^You are a subagent spawned by another session\.[ \t]*(?:\r?\n|$)/i;
const TITLE_LINE = /^[ \t]*Title:[ \t]*(\S[^\r\n]*?)[ \t]*(?:\r?\n|$)/;
/** A title is one short sentence; anything longer is not a title line. */
const TITLE_MAX = 120;
const UNWRAP_LIMIT = 4;

/** A line that says nothing about the task: a tag on its own, a rule, a code fence. */
const NOISE_LINE = /^(?:<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?>|[-*_=~]{3,}|`{3,}.*)$/;

export interface PromptParts {
	/** The prompt without the agent-message wrapper and stock's subagent prefix. */
	body: string;
	/** It arrived wrapped in `<ompdesk-agent-message>`: another session's agent wrote it. */
	agentMessage: boolean;
	/** It carried stock's "Complete assignment thoroughly:" prefix: a subagent's assignment. */
	subagentAssignment: boolean;
}

/** The prompt's text without the protocol that carried it (both wrappers, in whatever order they nest). */
export function unwrapPrompt(prompt: string): PromptParts {
	let body = prompt.trim();
	let agentMessage = false;
	let subagentAssignment = false;
	for (let round = 0; round < UNWRAP_LIMIT; round++) {
		const start = WRAPPED_START.exec(body);
		if (start) {
			agentMessage = true;
			body = body.slice(start[0].length).replace(WRAPPED_END, "").trim();
			continue;
		}
		const stock = STOCK_PREFIX.exec(body) ?? SUBAGENT_PREAMBLE.exec(body);
		if (stock) {
			subagentAssignment = true;
			body = body.slice(stock[0].length).trim();
			continue;
		}
		break;
	}
	return { body, agentMessage, subagentAssignment };
}

function clip(text: string): string {
	const flat = text.replaceAll(/\s+/g, " ").trim();
	return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat;
}

/** `Title:` label, markdown heading marks and quote/list markers are protocol or typography, never the words. */
function bareLine(line: string): string {
	return line
		.replace(/^[ \t]*Title:[ \t]*/i, "")
		.replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/, "")
		.trim();
}

/**
 * A heading of a single word (`# Target`, `## Context`, `# 목표`) labels a section of a brief, it names no task; the
 * line under it does.
 */
const SECTION_LABEL = /^[ \t]*#{1,6}[ \t]+[^\s#]+[ \t]*:?[ \t]*$/;

/** The first line of `text` that says something about the task, or undefined. */
export function firstMeaningfulLine(text: string): string | undefined {
	let label: string | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || NOISE_LINE.test(line)) continue;
		const bare = bareLine(line);
		if (!bare || NOISE_LINE.test(bare)) continue;
		if (SECTION_LABEL.test(line)) {
			label ??= clip(bare.replace(/:$/, ""));
			continue;
		}
		return clip(bare);
	}
	return label;
}

/** A page title that names no task: the wrapper's tag, stock's prefix, the preamble, or the id the page fell back to. */
export function isJunkTitle(title: string | undefined): boolean {
	const text = (title ?? "").trim();
	if (!text) return true;
	if (text.startsWith(`<${AGENT_MESSAGE_TAG}`) || text.startsWith(`</${AGENT_MESSAGE_TAG}`)) return true;
	if (/^Complete assignment thoroughly:?$/i.test(text)) return true;
	if (/^You are a subagent spawned by another session\.?$/i.test(text)) return true;
	return /^Session [0-9a-f]{8}-[0-9a-f]{4}-/i.test(text) || text === "session";
}

export interface PromptTitleOptions {
	/** The omp session's own title (`ctx.sessionManager.getSessionName()`), for a session's first prompt only. */
	sessionName?: string;
}

/** The assignment's own `Title:` line (the task named in the person's language), or undefined. */
export function explicitTitle(prompt: string): string | undefined {
	const title = TITLE_LINE.exec(unwrapPrompt(prompt).body)?.[1];
	return title && title.length <= TITLE_MAX ? title : undefined;
}

/**
 * What a prompt is about, in the order of how sure we are: the assignment's own `Title:` line, else the omp session's
 * title, else the first meaningful line once the wrapper and the known prefixes are stripped. Undefined for a prompt
 * that has nothing to say (the wrapper alone, an empty text).
 */
export function promptTitle(prompt: string, options: PromptTitleOptions = {}): string | undefined {
	const explicit = explicitTitle(prompt);
	if (explicit) return explicit;
	const name = options.sessionName?.trim();
	if (name && !isJunkTitle(name)) return clip(name);
	return firstMeaningfulLine(unwrapPrompt(prompt).body);
}

/** An agent (not a person) wrote this prompt: another session's wrapped message, or a subagent's assignment. */
export function isAgentPrompt(prompt: string): boolean {
	const parts = unwrapPrompt(prompt);
	return parts.agentMessage || parts.subagentAssignment;
}

/**
 * Whether a session is still agent-driven after `prompt`: true while every prompt it has received was written by an
 * agent. The first prompt decides it (`previous` undefined); a person typing into the session makes it theirs for good.
 */
export function nextAgentDriven(previous: boolean | undefined, prompt: string): boolean {
	return (previous ?? true) && isAgentPrompt(prompt);
}

/** omp's `ctx.agent` (`ExtensionAgentIdentity`), the part this file reads. */
export interface AgentIdentity {
	kind?: string;
	id?: string;
	name?: string;
	parentId?: string;
}

/**
 * The marker a child's hook payloads carry, in the keys ai-memory's server already reads as "this event belongs to a
 * spawned subagent" (`subagentType`, `agent_id`): an omp subagent names its definition and its spawner, a session
 * another agent opened says so. Empty for a session a person drives: those create and consume handoffs.
 */
export function childMarker(agent: AgentIdentity | undefined, agentDriven: boolean): Record<string, string> {
	if (agent?.kind === "sub") {
		const marker: Record<string, string> = { subagentType: agent.name || "sub" };
		const parent = agent.parentId || agent.id;
		if (parent) marker.agent_id = parent;
		return marker;
	}
	return agentDriven ? { subagentType: "agent-opened" } : {};
}

/** Whether a session is a child that must neither create nor consume a handoff. */
export function isChildSession(agent: AgentIdentity | undefined, agentDriven: boolean): boolean {
	return Object.keys(childMarker(agent, agentDriven)).length > 0;
}

/** A turn's stored conclusion is at most this many UTF-8 bytes (ai-memory's own Stop excerpt cap). */
export const CONCLUSION_MAX_BYTES = 2000;

function utf8Length(codePoint: number): number {
	return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutUtf8(text: string, max: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		bytes += utf8Length(char.codePointAt(0) ?? 0);
		if (bytes > max) break;
		end += char.length;
	}
	return text.slice(0, end);
}

/**
 * What a turn ended on: the text parts of the last assistant message in `messages` (omp's `agent_end` messages; no
 * thinking, no tool calls), redacted like a diagnostics report, trimmed and cut to `CONCLUSION_MAX_BYTES`. Undefined
 * when that message says nothing in words.
 */
export function conclusionExcerpt(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: unknown; content?: unknown } | null;
		if (message?.role !== "assistant") continue;
		const parts = Array.isArray(message.content) ? message.content : [];
		const text = parts
			.map(part => (part?.type === "text" && typeof part.text === "string" ? part.text.trim() : ""))
			.filter(Boolean)
			.join("\n\n");
		const excerpt = cutUtf8(redactDiagnosticsText(text).trim(), CONCLUSION_MAX_BYTES).trim();
		return excerpt || undefined;
	}
	return undefined;
}

/** The git command `checkoutParams` reads: the work tree's root and the git dir every worktree of it shares. */
export const CHECKOUT_REV_PARSE_ARGS = [
	"rev-parse",
	"--path-format=absolute",
	"--show-toplevel",
	"--git-common-dir",
] as const;

/** What `checkoutParams` asks of the machine; the extension answers with git and `realpathSync`. */
export interface CheckoutProbe {
	/**
	 * `git -C <cwd> <CHECKOUT_REV_PARSE_ARGS>`'s output; null when git ran and found no work tree there, undefined when
	 * git could not run.
	 */
	revParse(cwd: string): string | null | undefined;
	/** `path` with every link resolved, or undefined when it cannot be read. */
	realpath(path: string): string | undefined;
}

/** The folder holding `path`; undefined when that is a filesystem root (`/`, `C:`), which never holds a checkout. */
function checkoutParent(path: string): string | undefined {
	const trimmed = path.replace(/[\\/]+$/, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (cut <= 0) return undefined;
	const parent = trimmed.slice(0, cut);
	return /^[A-Za-z]:$/.test(parent) ? undefined : parent;
}

/** `root` as the cwd spells it (the cwd's ancestor that is really `root`), else as git printed it. */
function checkoutInCwdSpelling(cwd: string, root: string, probe: CheckoutProbe): string {
	const real = probe.realpath(root);
	if (real === undefined) return root;
	for (let dir: string | undefined = cwd.replace(/[\\/]+$/, ""); dir; dir = checkoutParent(dir)) {
		if (probe.realpath(dir) === real) return dir;
	}
	return root;
}

/**
 * The `repo_root` / `main_repo_root` query parameters ai-memory's server routes an event by, so it never runs git in
 * the event's folder itself: on macOS the server is a launchd job with its own privacy permissions, and its look into
 * a project under Desktop, Documents or Downloads asked the person for that folder after every update. The extension
 * runs inside omp, under the access OMPdesk already has. Roots are spelled in the cwd's namespace (the server compares
 * strings: `/var/…` and `/private/var/…` are the same folder on a Mac), and the main root is the parent of the shared
 * git dir, as the server's own discovery reads it. `{repo_root: ""}` says the cwd is in no checkout; undefined (git
 * missing, an answer it cannot read) lets the server look as before.
 */
export function checkoutParams(cwd: string, probe: CheckoutProbe): Record<string, string> | undefined {
	const output = probe.revParse(cwd);
	if (output === undefined) return undefined;
	if (output === null) return { repo_root: "" };
	const [top, common] = output.split(/\r?\n/).map(line => line.trim());
	const main = common ? checkoutParent(common) : undefined;
	if (!top || !main) return undefined;
	return {
		repo_root: checkoutInCwdSpelling(cwd, top, probe),
		main_repo_root: checkoutInCwdSpelling(cwd, main, probe),
	};
}
