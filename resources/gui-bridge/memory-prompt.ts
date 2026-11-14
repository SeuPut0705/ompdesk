/**
 * What the memory extension and the app both need to know about a session: what the session is about (the title a
 * session page is filed under), whether the session is a child (a subagent, or a session another agent opened) that
 * must neither create nor consume a handoff, the conclusion a turn ended on, and the checkout its folder belongs to.
 *
 * Prompt classification has one Rust implementation (`core/src/aimemory/prompt_policy.rs`), compiled into the
 * embedded WASM consumed by `memory-policy.ts`. The memory build embeds that module, its bytes and the redactor
 * into the generated terminal extension, so the same policy works while OMPdesk is closed.
 */

import { memoryPromptFacts } from "./memory-policy";
import { redactDiagnosticsText } from "./redactor";

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
	const { body, agentMessage, subagentAssignment } = memoryPromptFacts(prompt);
	return { body, agentMessage, subagentAssignment };
}

/** The first line of `text` that says something about the task, or undefined. */
export function firstMeaningfulLine(text: string): string | undefined {
	return memoryPromptFacts(text).firstLine ?? undefined;
}

/** A page title that names no task: the wrapper's tag, stock's prefix, the preamble, or the id the page fell back to. */
export function isJunkTitle(title: string | undefined): boolean {
	return memoryPromptFacts(title ?? "").junk;
}

export interface PromptTitleOptions {
	/** The omp session's own title (`ctx.sessionManager.getSessionName()`), for a session's first prompt only. */
	sessionName?: string;
}

/** The assignment's own `Title:` line (the task named in the person's language), or undefined. */
export function explicitTitle(prompt: string): string | undefined {
	return memoryPromptFacts(prompt).explicit ?? undefined;
}

/**
 * What a prompt is about, in the order of how sure we are: the assignment's own `Title:` line, else the omp session's
 * title, else the first meaningful line once the wrapper and the known prefixes are stripped. Undefined for a prompt
 * that has nothing to say (the wrapper alone, an empty text).
 */
export function promptTitle(prompt: string, options: PromptTitleOptions = {}): string | undefined {
	return memoryPromptFacts(prompt, options.sessionName).title ?? undefined;
}

/** An agent (not a person) wrote this prompt: another session's wrapped message, or a subagent's assignment. */
export function isAgentPrompt(prompt: string): boolean {
	return memoryPromptFacts(prompt).agent;
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
