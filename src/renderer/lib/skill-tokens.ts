/**
 * Stock's mid-prompt skill invocation, read in the renderer so the composer can
 * warn before a token goes out as plain text. A copy of
 * `@oh-my-pi/pi-tui/src/prompt/skill-tokens.ts` (`SKILL_TOKEN_RE`,
 * `allowsSkillTokens`): the renderer cannot import stock, and
 * `skill-tokens.test.ts` pins it to stock's documented cases.
 */
import type { AvailableCommand } from "../../shared/rpc-types";

/** One `/skill:<name>` token delimited by whitespace or line edges (stock `SKILL_TOKEN_RE`). */
const SKILL_TOKEN_RE = /(^|\s)\/skill:([^\s/]+(?:\/[^\s/]+)?)(?=\s|$)/g;

/** Whether the draft begins with a local-execution sigil (`!`, `$ `, `$$ `) that consumes it verbatim. */
function startsWithLocalExecutionPrefix(trimmedStart: string): boolean {
	if (trimmedStart.startsWith("!")) return true;
	if (!trimmedStart.startsWith("$") || trimmedStart.startsWith("${")) return false;
	const next = trimmedStart.charAt(trimmedStart.startsWith("$$") ? 2 : 1);
	return next === "" || next === " " || next === "\t" || next === "\n" || next === "\r";
}

/** Whether `/skill:` tokens in `text` are invocations (stock `allowsSkillTokens`). */
export function allowsSkillTokens(text: string): boolean {
	const trimmedStart = text.trimStart();
	if (trimmedStart.startsWith("/skill:")) return true;
	if (trimmedStart.startsWith("/")) return false;
	return !startsWithLocalExecutionPrefix(trimmedStart);
}

/**
 * Skill names `text` invokes through `/skill:<name>` tokens that the session
 * does not offer (off, or no such skill): stock sends those tokens as plain
 * text. Empty while the command list has not loaded, since nothing is known yet.
 */
export function unavailableSkillTokens(text: string, commands: AvailableCommand[]): string[] {
	if (commands.length === 0 || !allowsSkillTokens(text)) return [];
	const names = new Set([...text.matchAll(SKILL_TOKEN_RE)].map(match => match[2] ?? ""));
	return [...names].filter(name => !commands.some(command => command.name === `skill:${name}`));
}
