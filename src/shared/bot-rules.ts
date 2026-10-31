/**
 * The owner's action rules for the bot (Settings › Bot, stored in the top-level pref `botRules`). Each rule is an
 * action in the owner's words and what the bot does about it. Dependency-free: main builds the bot's prompt from
 * `botRulesText`, the renderer edits the list.
 *
 * A stored array is the owner's list as it is, even when empty (they deleted every rule). Anything else, never
 * saved or unreadable, reads as `DEFAULT_BOT_RULES`.
 */

export const BOT_RULES_PREF = "botRules";

/**
 * - `auto`: take the action without asking.
 * - `preapproved`: take it only if the owner explicitly asked for it.
 * - `ask`: ask the owner before taking it.
 * - `handoff`: hand the step to the owner.
 */
export const BOT_RULE_BEHAVIORS = ["auto", "preapproved", "ask", "handoff"] as const;
export type BotRuleBehavior = (typeof BOT_RULE_BEHAVIORS)[number];

export interface BotRule {
	id: string;
	action: string;
	behavior: BotRuleBehavior;
}

/** Longest action text and longest list kept, so the prompt line they become stays bounded. */
export const BOT_RULE_ACTION_MAX = 200;
export const BOT_RULES_MAX = 50;

/**
 * English action text. The Settings screen shows a default rule translated while its text is still this one
 * (`botRules.default.<id>` in the locales); an edited rule is the owner's text, shown as written.
 */
export const DEFAULT_BOT_RULES: BotRule[] = [
	{ id: "deploy", action: "Deploy or release", behavior: "ask" },
	{ id: "force-push", action: "Force-push", behavior: "ask" },
	{ id: "delete", action: "Delete data, sessions or branches", behavior: "ask" },
	{ id: "outside-messages", action: "Send messages or post outside this computer", behavior: "ask" },
	{ id: "payments", action: "Make payments or purchases", behavior: "ask" },
	{ id: "secrets", action: "Use or share credentials or secrets", behavior: "ask" },
	{ id: "push", action: "Push to a branch", behavior: "preapproved" },
	{ id: "merge", action: "Merge a branch", behavior: "preapproved" },
	{ id: "edits", action: "Edit code", behavior: "auto" },
	{ id: "tests", action: "Run tests", behavior: "auto" },
	{ id: "open-sessions", action: "Open sessions", behavior: "auto" },
];

export function isBotRuleBehavior(value: unknown): value is BotRuleBehavior {
	return typeof value === "string" && (BOT_RULE_BEHAVIORS as readonly string[]).includes(value);
}

/** One line of text: whitespace runs (newlines included) become a single space, the ends are trimmed. */
export function cleanBotRuleAction(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, BOT_RULE_ACTION_MAX).trim();
}

/** The stored list, or the defaults when nothing usable is stored. Invalid and repeated entries are dropped. */
export function parseBotRules(value: unknown): BotRule[] {
	if (!Array.isArray(value)) return DEFAULT_BOT_RULES.map(rule => ({ ...rule }));
	const rules: BotRule[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (rules.length >= BOT_RULES_MAX) break;
		if (typeof entry !== "object" || entry === null) continue;
		const { id, action, behavior } = entry as Record<string, unknown>;
		if (typeof id !== "string" || id === "" || seen.has(id)) continue;
		if (typeof action !== "string" || !isBotRuleBehavior(behavior)) continue;
		const text = cleanBotRuleAction(action);
		if (text === "") continue;
		seen.add(id);
		rules.push({ id, action: text, behavior });
	}
	return rules;
}

/** An id no rule in `rules` uses. */
export function newBotRuleId(rules: readonly BotRule[]): string {
	const used = new Set(rules.map(rule => rule.id));
	for (;;) {
		const id = `rule-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		if (!used.has(id)) return id;
	}
}

const BEHAVIOR_TEXT: Record<BotRuleBehavior, string> = {
	auto: "take it without asking",
	preapproved: "take it only if the owner explicitly asked for it",
	ask: "ask the owner before taking it",
	handoff: "do not take it; hand the step to the owner",
};

/** One English line per rule, for the bot's prompt. Empty text for no rules. */
export function botRulesText(rules: BotRule[]): string {
	return rules.map(rule => `- ${cleanBotRuleAction(rule.action)}: ${BEHAVIOR_TEXT[rule.behavior]}.`).join("\n");
}
