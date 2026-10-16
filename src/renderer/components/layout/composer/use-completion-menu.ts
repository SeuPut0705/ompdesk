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
import { MAX_MENTION_FILE_ITEMS, MAX_MENU_ITEMS, MENTION_SCHEMES, mentionToken } from "./input-area-utils";

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

/** Completion menu state: the winning provider's items + replace range. */
export interface CompletionMenu {
	source: "slash-arg" | "github-ref" | "command" | "skill" | "mention" | "model" | "emoji";
	rangeStart: number;
	rangeEnd: number;
	items: CompletionItem[];
	index: number;
}

/** Same provider, range and rows: a re-derivation that changes nothing the user sees. */
export function sameCompletionMenu(a: CompletionMenu, b: CompletionMenu): boolean {
	return (
		a.source === b.source &&
		a.rangeStart === b.rangeStart &&
		a.rangeEnd === b.rangeEnd &&
		a.items.length === b.items.length &&
		a.items.every((item, index) => item.value === b.items[index]?.value && item.label === b.items[index]?.label)
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
		const apply = (result: Omit<CompletionMenu, "index" | "rangeEnd"> | null) => {
			if (!live()) return;
			setMenu(result && result.items.length > 0 ? { ...result, rangeEnd: cursor, index: 0 } : null);
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
		const cmdMatch = /(^|\s)\/([\w:.-]*)$/i.exec(before);
		if (cmdMatch) {
			const query = (cmdMatch[2] ?? "").toLowerCase();
			const rangeStart = cursor - query.length - 1;
			if (before.slice(0, rangeStart).trim() !== "") {
				const items = commands
					.filter(
						command =>
							command.name.startsWith("skill:") &&
							midPromptSkillMatches(query, command.name, command.description),
					)
					.slice(0, MAX_MENU_ITEMS)
					.map(command => ({
						value: `/${command.name} `,
						label: `/${command.name}`,
						description: command.description,
					}));
				apply({ source: "command", rangeStart, items });
				return () => {
					cancelled = true;
				};
			}
			// Exact name/alias first, then prefix, then substring: typing `/plan` +
			// Enter must pick /plan, not an earlier-listed `/skill:…-plan`.
			const rank = (command: AvailableCommand): number => {
				const names = [command.name, ...(command.aliases ?? [])].map(name => name.toLowerCase());
				if (!query) return 0;
				if (names.includes(query)) return 0;
				if (names.some(name => name.startsWith(query))) return 1;
				if (names.some(name => name.includes(query))) return 2;
				return -1;
			};
			const items = commands
				.filter(command => rank(command) >= 0)
				.map((command, index) => ({ command, index, rank: rank(command) }))
				.sort((a, b) => a.rank - b.rank || a.index - b.index)
				.slice(0, MAX_MENU_ITEMS)
				.map(({ command }) => ({
					value: `/${command.name} `,
					label: `/${command.name}`,
					description: command.description,
				}));
			apply({ source: "command", rangeStart, items });
			return () => {
				cancelled = true;
			};
		}

		// 4. `$` skill palette anywhere in the draft: picks insert stock's own
		// mid-prompt `/skill:<name>` token, which stock invokes with the
		// surrounding prose as its arguments. No skill on → a hint, no menu.
		const skillMatch = /(^|\s)\$([\w.~/-]*)$/.exec(before);
		if (skillMatch) {
			const query = (skillMatch[2] ?? "").toLowerCase();
			const skills = commands.filter(command => command.name.startsWith("skill:"));
			if (skills.length === 0 && commands.length > 0) setArgHint(t("input.skills.none"));
			// Name prefix first, then substring; stock's list order within each.
			const items = skills
				.map(command => {
					const bare = command.name.slice("skill:".length);
					const lower = bare.toLowerCase();
					return { command, bare, rank: lower.startsWith(query) ? 0 : lower.includes(query) ? 1 : -1 };
				})
				.filter(skill => skill.rank >= 0)
				.sort((a, b) => a.rank - b.rank)
				.slice(0, MAX_MENU_ITEMS)
				.map(({ command, bare }) => ({
					value: `/skill:${bare} `,
					label: `$${bare}`,
					description: command.description,
				}));
			apply({ source: "skill", rangeStart: cursor - query.length - 1, items });
			return () => {
				cancelled = true;
			};
		}

		// 5. @ mention: workspace files (fuzzy) above internal URL schemes. A picked path with a space
		// goes in quoted (`@"My Report.md"`), the form stock's mention parser reads whole.
		const mention = mentionToken(before);
		if (mention) {
			// macOS file names may be decomposed (NFD) while typed Hangul is composed (NFC).
			const q = mention.query.normalize("NFC");
			const items: CompletionItem[] = [];
			const scored: { path: string; score: number }[] = [];
			for (const path of filePaths) {
				const score = fuzzyScore(q, path.normalize("NFC"));
				if (score !== null) scored.push({ path, score });
			}
			scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
			for (const { path } of scored.slice(0, MAX_MENTION_FILE_ITEMS)) {
				items.push({ value: `${fileMentionFor(path, "")} `, label: path });
			}
			const lowerQuery = q.toLowerCase();
			for (const scheme of MENTION_SCHEMES) {
				if (scheme.toLowerCase().includes(lowerQuery)) items.push({ value: scheme, label: scheme });
			}
			apply({ source: "mention", rangeStart: mention.start, items });
			return () => {
				cancelled = true;
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
	}, [text, selection, models, filePaths, commands, emojiAutocomplete, textareaRef, setMenu, t, rpc]);
	return argHint;
}
