/**
 * useCompletionMenu: derives the completion menu from the draft around the
 * caret. Provider chain (TUI getSuggestions order): slash-arg → github-ref →
 * slash names → `$` skills → @mention → ^model → emoji. First provider with items wins; async
 * providers (emoji buckets, the builtin argument RPC) resolve through a cancel
 * token + debounce. A builtin's argument candidates and its inline argument
 * hint come from stock (`get_command_arg_completions`); other commands show
 * their advertised input hint until an argument is typed.
 */

import { useEffect, useState } from "react";
import type { AvailableCommand, AvailableModelsResult, ModelInfo } from "../../../../shared/rpc-types";
import { getEmojiSuggestions } from "../../../lib/emoji";
import { fuzzyScore } from "../../../lib/fuzzy-score";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { fileMentionFor } from "./composer-files";
import {
	MAX_LIST_MENU_ITEMS,
	MAX_MENU_ITEMS,
	MENTION_FS_MAX_ENTRIES,
	MENTION_SCHEMES,
	type MentionSource,
	mentionDirOf,
	mentionListingOf,
	mentionToken,
	searchMentionFiles,
} from "./input-area-utils";

/** Wait before a typed folder of a cut-off `@` listing is asked for on its own. */
const MENTION_DIR_DEBOUNCE_MS = 150;
/** Hangul a menu token may end in: a keyboard left in Korean types jamo, an IME is composing syllables. */
const HANGUL = "\\u1100-\\u11ff\\u3130-\\u318f\\uac00-\\ud7a3";
/** `/name` at a word boundary: the name, then any Hangul that follows it (see the menu's range note). */
const SLASH_TOKEN = new RegExp(`(^|\\s)/([\\w:.-]*)([${HANGUL}]*)$`, "i");
/** `$name`, same shape. */
const SKILL_TOKEN = new RegExp(`(^|\\s)\\$([\\w.~/-]*)([${HANGUL}]*)$`);

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
	/** `[start, end)` UTF-16 spans of `label` the typed query matched, for the row to highlight. */
	highlights?: [number, number][];
}

/** What a menu says under its rows: the keys that work in it, and notes on rows that are not shown. */
export interface CompletionFooter {
	hints: { keys: string; label: string }[];
	notes: string[];
}

/** Completion menu state: the winning provider's items + replace range. */
export interface CompletionMenu {
	source: "slash-arg" | "github-ref" | "command" | "skill" | "mention" | "model" | "emoji";
	rangeStart: number;
	rangeEnd: number;
	items: CompletionItem[];
	index: number;
	/** Rows the provider found; more than `items.length` when its cap cut the list (the footer says so). */
	total?: number;
	/** The `@` file listing is incomplete (main's walk hit its entry cap): a longer typed path still finds the rest. */
	truncated?: boolean;
	footer?: CompletionFooter;
}

/** Same provider, range and rows: a re-derivation that changes nothing the user sees. */
export function sameCompletionMenu(a: CompletionMenu, b: CompletionMenu): boolean {
	return (
		a.source === b.source &&
		a.rangeStart === b.rangeStart &&
		a.rangeEnd === b.rangeEnd &&
		a.total === b.total &&
		a.truncated === b.truncated &&
		a.items.length === b.items.length &&
		a.items.every((item, index) => {
			const other = b.items[index];
			return (
				item.value === other?.value &&
				item.label === other.label &&
				JSON.stringify(item.highlights) === JSON.stringify(other.highlights)
			);
		})
	);
}

/** Replace only the provider's prefix; never consume text after the live caret. */
export function applyCompletion(text: string, cursor: number, menu: CompletionMenu, item: CompletionItem) {
	if (cursor !== menu.rangeEnd) return null;
	return {
		text: `${text.slice(0, menu.rangeStart)}${item.value}${text.slice(cursor)}`,
		caret: menu.rangeStart + item.value.length,
	};
}

/**
 * Whether a slash token typed after prompt text (`prose … /tok`) offers the skill `name`: stock's
 * `midPromptSkillTokenMatches` (pi-tui autocomplete.ts), copied because stock cannot run in the renderer.
 * The bare `/` and any prefix of `skill:` list every skill, an explicit `skill:…` query matches the name or
 * description as a subsequence, anything else must start the bare name or one of its hyphen segments
 * (`/hum` → `skill:humanizer`, `/last` → `skill:research-last30days`): a stray `/word` in prose opens nothing.
 */
export function midPromptSkillMatches(token: string, name: string, description = ""): boolean {
	const lowerToken = token.toLowerCase();
	const lowerName = name.toLowerCase();
	if ("skill:".startsWith(lowerToken)) return true;
	if (lowerToken.startsWith("skill:")) {
		const subsequenceOf = (target: string) => {
			let matched = 0;
			for (let index = 0; index < target.length && matched < lowerToken.length; index++)
				if (target[index] === lowerToken[matched]) matched++;
			return matched === lowerToken.length;
		};
		return subsequenceOf(lowerName) || subsequenceOf(description.toLowerCase());
	}
	return lowerName.startsWith("skill:") && `-${lowerName.slice("skill:".length)}`.includes(`-${lowerToken}`);
}

/**
 * The `/` menu's rows for a typed name: exact name or alias first, then prefix, then substring (typing
 * `/plan` + Enter must pick /plan, not an earlier-listed `/skill:…-plan`), each in the order stock lists
 * its commands. An empty name keeps every command.
 */
export function rankSlashCommands(commands: AvailableCommand[], query: string): AvailableCommand[] {
	const rank = (command: AvailableCommand): number => {
		if (!query) return 0;
		const names = [command.name, ...(command.aliases ?? [])].map(name => name.toLowerCase());
		if (names.includes(query)) return 0;
		if (names.some(name => name.startsWith(query))) return 1;
		return names.some(name => name.includes(query)) ? 2 : -1;
	};
	return commands
		.map((command, index) => ({ command, index, rank: rank(command) }))
		.filter(entry => entry.rank >= 0)
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(entry => entry.command);
}

/**
 * The name of a slash command the draft opens with that no command (or alias) has, or null: `/zzzz` and
 * `/zzzz more` are sent to the agent as plain prompts, so the composer says so before Enter. Null until
 * the command list is known.
 */
export function unknownSlashCommand(text: string, commands: AvailableCommand[]): string | null {
	const name = /^\/([\w:.-]+)(?=\s|$)/.exec(text)?.[1];
	if (!name || commands.length === 0) return null;
	const lower = name.toLowerCase();
	const known = commands.some(
		command => command.name.toLowerCase() === lower || command.aliases?.some(alias => alias.toLowerCase() === lower),
	);
	return known ? null : name;
}

/** What may follow the trigger character inside each menu's token (the trigger included in the pattern). */
const MENU_TOKEN: Partial<Record<CompletionMenu["source"], RegExp>> = {
	command: new RegExp(`^/[\\w:.-]*[${HANGUL}]*$`, "i"),
	skill: new RegExp(`^\\$[\\w.~/-]*[${HANGUL}]*$`),
	mention: /^@(?:"[^"]*|[^\s"'=]*)$/,
	model: /^\^[^\s^]*$/,
	"github-ref": /^#\d*$/,
	emoji: /^:[\w+-]*$/,
};

/**
 * Whether ←/→ at `caret` leaves the open menu's token in place: the caret lands inside it (after the
 * trigger character, before the first character that is not part of the token), so the menu stays and is
 * derived again for the new caret; only an arrow that steps out of the token (before `@`, onto a space)
 * closes it. A slash command's argument menu spans the rest of its line.
 */
export function arrowKeepsMenu(
	text: string,
	menu: Pick<CompletionMenu, "source" | "rangeStart">,
	key: "ArrowLeft" | "ArrowRight",
	caret: number,
): boolean {
	// A character outside the BMP is two code units: the caret steps over both.
	const step =
		key === "ArrowLeft"
			? -(caret >= 2 && /[\uDC00-\uDFFF]/.test(text.charAt(caret - 1)) ? 2 : 1)
			: /[\uD800-\uDBFF]/.test(text.charAt(caret))
				? 2
				: 1;
	const next = caret + step;
	if (next < menu.rangeStart || next > text.length) return false;
	const body = text.slice(menu.rangeStart, next);
	if (menu.source === "slash-arg") return !body.includes("\n");
	return MENU_TOKEN[menu.source]?.test(body) ?? false;
}

export function useCompletionMenu({
	text,
	filePaths,
	commands,
	emojiAutocomplete,
	textareaRef,
	setMenu,
}: {
	text: string;
	filePaths: string[];
	commands: AvailableCommand[];
	emojiAutocomplete: boolean;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	setMenu: (menu: CompletionMenu | null) => void;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const models = useModelStore(state => state.availableModels);
	/** Contextual argument hint under the composer (TUI ghost-text parity). */
	const [argHint, setArgHint] = useState("");
	const [selection, setSelection] = useState("");
	/** Bumped when a folder listing of a cut-off `@` walk lands, so the menu is derived again with it. */
	const [dirTick, setDirTick] = useState(0);
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		const update = () => setSelection(`${el.selectionStart}:${el.selectionEnd}`);
		el.addEventListener("select", update);
		el.addEventListener("keyup", update);
		el.addEventListener("click", update);
		return () => {
			el.removeEventListener("select", update);
			el.removeEventListener("keyup", update);
			el.removeEventListener("click", update);
		};
	}, [textareaRef]);
	// Derive the completion menu from the draft around the caret. Provider
	// chain (TUI getSuggestions order): slash-arg → github-ref → slash names →
	// @mention → emoji. First provider with items wins; async providers (emoji
	// buckets, dynamic arg RPC) resolve through a cancel token + debounce.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `selection` is the caret mirror; the effect reads `el.selectionStart` directly and re-runs on that state change.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			setMenu(null);
			return;
		}
		let cancelled = false;
		let timer: number | undefined;
		const cursor = el.selectionStart ?? text.length;
		const before = text.slice(0, cursor);
		const live = () => !cancelled && (el.selectionStart ?? text.length) === cursor;
		const apply = (result: Omit<CompletionMenu, "index" | "rangeEnd" | "footer"> | null) => {
			if (!live()) return;
			if (!result || result.items.length === 0) {
				setMenu(null);
				return;
			}
			const notes: string[] = [];
			const unseen = (result.total ?? 0) - result.items.length;
			if (unseen > 0) notes.push(t("input.menu.more", { count: unseen }));
			if (result.truncated) {
				notes.push(t("input.menu.filesTruncated", { count: MENTION_FS_MAX_ENTRIES.toLocaleString() }));
			}
			const hints = [
				{ keys: "↑↓", label: t("input.menu.hintMove") },
				{ keys: "Tab ↵", label: t("input.menu.hintPick") },
				{ keys: "Esc", label: t("input.menu.hintClose") },
			];
			setMenu({ ...result, rangeEnd: cursor, index: 0, footer: { hints, notes } });
		};
		setArgHint("");
		if (el.selectionEnd !== cursor) {
			apply(null);
			return;
		}

		// 1. Slash-command ARGUMENTS: "/cmd <args>" with the slash at buffer start.
		const argMatch = /^\/([a-z-]+)\s(.*)$/i.exec(before);
		if (argMatch) {
			const name = (argMatch[1] ?? "").toLowerCase();
			const command = commands.find(
				candidate =>
					candidate.name.toLowerCase() === name || candidate.aliases?.some(alias => alias.toLowerCase() === name),
			);
			if (command && command.allowArgs === false) {
				apply(null); // args not accepted — hard close (TUI parity)
				return () => {
					cancelled = true;
				};
			}
			if (command) {
				const argPrefix = argMatch[2] ?? "";
				const rangeStart = cursor - argPrefix.length;
				const atEnd = cursor === text.length;
				// Stock's static inline hint: the advertised input hint until an argument is typed.
				const staticHint = atEnd && argPrefix.trim() === "" ? (command.input?.hint ?? "") : "";
				if (command.source !== "builtin") {
					setArgHint(staticHint);
					apply(null);
					return () => {
						cancelled = true;
					};
				}
				timer = window.setTimeout(() => {
					void rpc.getCommandArgCompletions(command.name, argPrefix).then(response => {
						if (!live()) return;
						const data = response.success
							? (response.data as { items?: CompletionItem[]; hint?: string | null } | undefined)
							: undefined;
						setArgHint(atEnd ? (data?.hint ?? staticHint) : "");
						apply(data?.items?.length ? { source: "slash-arg", rangeStart, items: data.items } : null);
					});
				}, 120);
				return () => {
					cancelled = true;
					clearTimeout(timer);
				};
			}
			// No such command: the draft goes to the agent as plain text, which the hint says.
			const unknown = unknownSlashCommand(before, commands);
			if (unknown && cursor === text.length) setArgHint(t("input.slash.unknown", { name: `/${unknown}` }));
		}

		// 2. GitHub #ref: standalone #<positive-int> at a token boundary (no network).
		const refMatch = /(?:^|[\s"'`(<=])(?:(pr|pull|issue)(\s+))?#([1-9]\d*)$/i.exec(before);
		if (refMatch) {
			const qualifier = refMatch[1]?.toLowerCase();
			const number = refMatch[3] ?? "";
			const rangeStart = cursor - number.length - 1; // include the '#'
			const items =
				qualifier === "pr" || qualifier === "pull"
					? [{ value: `pr://${number} `, label: `pr://${number}` }]
					: qualifier === "issue"
						? [{ value: `issue://${number} `, label: `issue://${number}` }]
						: [
								{
									value: `pr://${number} `,
									label: `pr://${number}`,
									description: t("input.githubPullRequest"),
								},
								{
									value: `issue://${number} `,
									label: `issue://${number}`,
									description: t("input.githubIssue"),
								},
							];
			apply({ source: "github-ref", rangeStart, items });
			return () => {
				cancelled = true;
			};
		}

		// 3. Slash command NAMES at a word boundary: every command at the start of the draft, only
		// skills after prompt text (stock's mid-prompt skill lookup), so `hello /re` opens no command menu.
		// Hangul after the name (a keyboard left in Korean, or a syllable still being composed) keeps the
		// menu open on the name typed so far; a pick replaces the Hangul too.
		const cmdMatch = SLASH_TOKEN.exec(before);
		if (cmdMatch) {
			const typed = cmdMatch[2] ?? "";
			const query = typed.toLowerCase();
			const rangeStart = cursor - typed.length - (cmdMatch[3] ?? "").length - 1;
			if (before.slice(0, rangeStart).trim() !== "") {
				const matched = commands.filter(
					command =>
						command.name.startsWith("skill:") && midPromptSkillMatches(query, command.name, command.description),
				);
				const shown = query ? matched.slice(0, MAX_LIST_MENU_ITEMS) : matched;
				apply({
					source: "command",
					rangeStart,
					items: shown.map(command => ({
						value: `/${command.name} `,
						label: `/${command.name}`,
						description: command.description,
					})),
					total: matched.length,
				});
				return () => {
					cancelled = true;
				};
			}
			const matched = rankSlashCommands(commands, query);
			if (matched.length === 0 && !cmdMatch[3]) {
				const unknown = unknownSlashCommand(before, commands);
				if (unknown && cursor === text.length) setArgHint(t("input.slash.unknown", { name: `/${unknown}` }));
			}
			// With nothing typed the menu lists every command (it scrolls); a typed query keeps the best few.
			const shown = query ? matched.slice(0, MAX_LIST_MENU_ITEMS) : matched;
			apply({
				source: "command",
				rangeStart,
				items: shown.map(command => {
					const at = query ? command.name.toLowerCase().indexOf(query) : -1;
					return {
						value: `/${command.name} `,
						label: `/${command.name}`,
						description: command.description,
						highlights: at >= 0 ? [[1 + at, 1 + at + query.length]] : [],
					};
				}),
				total: matched.length,
			});
			return () => {
				cancelled = true;
			};
		}

		// 4. `$` skill palette anywhere in the draft: picks insert stock's own
		// mid-prompt `/skill:<name>` token, which stock invokes with the
		// surrounding prose as its arguments. No skill on → a hint, no menu.
		const skillMatch = SKILL_TOKEN.exec(before);
		if (skillMatch) {
			const typed = skillMatch[2] ?? "";
			const query = typed.toLowerCase();
			const skills = commands.filter(command => command.name.startsWith("skill:"));
			if (skills.length === 0 && commands.length > 0) setArgHint(t("input.skills.none"));
			// Name prefix first, then substring; stock's list order within each.
			const matched = skills
				.map(command => {
					const bare = command.name.slice("skill:".length);
					return { command, bare, at: bare.toLowerCase().indexOf(query) };
				})
				.filter(skill => skill.at >= 0)
				.sort((a, b) => Number(a.at > 0) - Number(b.at > 0));
			const shown = query ? matched.slice(0, MAX_LIST_MENU_ITEMS) : matched;
			apply({
				source: "skill",
				rangeStart: cursor - typed.length - (skillMatch[3] ?? "").length - 1,
				items: shown.map(({ command, bare, at }) => ({
					value: `/skill:${bare} `,
					label: `$${bare}`,
					description: command.description,
					highlights: query ? [[1 + at, 1 + at + query.length]] : [],
				})),
				total: matched.length,
			});
			return () => {
				cancelled = true;
			};
		}

		// 5. @ mention: workspace files (ranked by file name, word starts, runs, Hangul initials) above
		// internal URL schemes. A picked path with a space goes in quoted (`@"My Report.md"`), the form
		// stock's mention parser reads whole.
		const mention = mentionToken(before);
		if (mention) {
			// macOS file names may be decomposed (NFD) while typed Hangul is composed (NFC).
			const q = mention.query.normalize("NFC");
			const listing = mentionListingOf(filePaths);
			const sources: MentionSource[] = [
				{ paths: filePaths, nfc: listing?.nfc ?? filePaths.map(path => path.normalize("NFC")) },
			];
			// A walk the entry cap cut still has every file reachable: a typed folder is listed on its own.
			let truncated = listing?.truncated ?? false;
			const dir = listing?.truncated ? mentionDirOf(q) : null;
			if (listing && dir) {
				const loaded = listing.dir(dir);
				if (loaded) {
					sources.push({ paths: loaded.extra, nfc: loaded.extra.map(path => path.normalize("NFC")) });
					truncated = loaded.truncated;
				} else {
					timer = window.setTimeout(() => {
						void listing.loadDir(dir).then(() => {
							if (!cancelled) setDirTick(tick => tick + 1);
						});
					}, MENTION_DIR_DEBOUNCE_MS);
				}
			}
			const { matches, total } = searchMentionFiles(q, sources);
			const items: CompletionItem[] = matches.map(({ path, label, ranges }) => ({
				value: `${fileMentionFor(path, "")} `,
				label,
				highlights: ranges,
			}));
			const lowerQuery = q.toLowerCase();
			let schemes = 0;
			for (const scheme of MENTION_SCHEMES) {
				const at = scheme.toLowerCase().indexOf(lowerQuery);
				if (at < 0) continue;
				schemes++;
				items.push({ value: scheme, label: scheme, highlights: lowerQuery ? [[at, at + lowerQuery.length]] : [] });
			}
			// No row to hang the notice on: it goes in the hint line under the field.
			if (truncated && items.length === 0) {
				setArgHint(t("input.menu.filesTruncated", { count: MENTION_FS_MAX_ENTRIES.toLocaleString() }));
			}
			apply({ source: "mention", rangeStart: mention.start, items, total: total + schemes, truncated });
			return () => {
				cancelled = true;
				window.clearTimeout(timer);
			};
		}

		// 6. Model delegation uses the same whitespace-delimited ^selector syntax
		// as tui/prompt/model-mention-syntax.ts. The sidecar owns model scope and
		// identity policy; never infer selectors from display names in the GUI.
		const modelMatch = /(?:^|\s)(\^[^\s^]*)$/.exec(before);
		if (modelMatch) {
			const prefix = modelMatch[1];
			const rangeStart = cursor - prefix.length;
			const query = prefix.slice(1);
			const showModels = (available: ModelInfo[]) => {
				const scored = available.flatMap(model => {
					const selector = `${model.provider}/${model.id}`;
					const score = fuzzyScore(query, `${selector} ${model.name ?? ""}`);
					return score === null ? [] : [{ model, selector, score }];
				});
				scored.sort((a, b) => b.score - a.score);
				apply({
					source: "model",
					rangeStart,
					items: scored.slice(0, MAX_MENU_ITEMS).map(({ model, selector }) => ({
						value: `^${selector} `,
						label: `^${selector}`,
						description: model.name || model.id,
					})),
				});
			};
			if (models.length > 0) showModels(models);
			else {
				apply(null);
				timer = window.setTimeout(() => {
					// Forced: a non-forced read is answered by a still-fresh cache row,
					// which hides the model a just-added provider contributed.
					void rpc
						.getAvailableModels(true)
						.then(response => {
							if (cancelled) return;
							const data = response.success ? (response.data as AvailableModelsResult | undefined) : undefined;
							showModels(data?.models ?? []);
						})
						.catch(() => {
							if (!cancelled) apply(null);
						});
				}, 120);
			}
			return () => {
				cancelled = true;
				window.clearTimeout(timer);
			};
		}

		// 7. Emoji (async; the bucket JSON lazy-loads on first trigger).
		if (emojiAutocomplete) {
			void getEmojiSuggestions(before).then(result => {
				if (!result) {
					apply(null);
					return;
				}
				apply({ source: "emoji", rangeStart: cursor - result.prefix.length, items: result.items });
			});
			return () => {
				cancelled = true;
			};
		}

		apply(null);
		return () => {
			cancelled = true;
		};
	}, [text, selection, models, filePaths, commands, emojiAutocomplete, textareaRef, setMenu, t, rpc, dirTick]);
	return argHint;
}
