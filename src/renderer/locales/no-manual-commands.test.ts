/**
 * The user's rule (29 Oct 2026): OMPdesk repairs every toolchain fault itself and never asks the person to run a
 * command. No locale string (renderer en/ko, main i18n text) may contain a shell command or tell the person to type one.
 */
import { describe, expect, it } from "vitest";
import { MAIN_TEXT } from "../../main/i18n-text";
import { en } from "./en";
import { ko } from "./ko";

const COMMAND_PATTERNS: readonly RegExp[] = [
	// "the omp update failed" is prose; a quoted `omp update` is a command.
	/`(omp|bun|brew|npm|git|gh|curl|ssh-\w+)\b[^`]*`/,
	/\bbun (upgrade|install|add|i)\b/,
	/\b(brew|winget|npm|pnpm|yarn|pipx|apt(-get)?) (install|upgrade|update|add)\b/,
	/\bcurl\b[^.]*\|\s*(ba)?sh/,
	/\b(irm|iwr)\b.*\|\s*iex/i,
	/\bpowershell\b/i,
	/\bgit (clone|pull|push|config|checkout|fetch|reset)\b/,
	/\bgh (auth|repo|pr) \w+/,
	/\bssh-(add|keygen)\b/,
	/\bxcode-select\b/,
	/\bsudo\b/,
];

/** Key → why a command-like string is allowed. Keep this list short. */
const ALLOWED: Readonly<Record<string, string>> = {
	"input.placeholder.idle": "slash-commands are OMPdesk's own, not a shell",
};

function collect(source: Record<string, unknown>): [string, string][] {
	const found: [string, string][] = [];
	const walk = (value: unknown, key: string) => {
		if (typeof value === "string") found.push([key, value]);
		else if (value && typeof value === "object")
			for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}.${k}` : k);
	};
	walk(source, "");
	return found;
}

describe("no command is ever asked of the person", () => {
	for (const [name, source] of [
		["en", en],
		["ko", ko],
		["main", MAIN_TEXT],
	] as const) {
		it(`${name} strings hold no shell command`, () => {
			const offenders = collect(source as Record<string, unknown>)
				.filter(([key]) => !(key in ALLOWED))
				.filter(([, text]) => COMMAND_PATTERNS.some(pattern => pattern.test(text)))
				.map(([key, text]) => `${key}: ${text}`);
			expect(offenders).toEqual([]);
		});
	}
});
