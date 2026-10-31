/**
 * gui-bridge agent-control.ts bot role: the owner's bot session journals `ompdesk.bot` with the owner's action rules
 * and its standing duties (`agent_control.bot`, only when either differs from the newest entry), and while an entry is
 * on its branch its main agent's prompt carries the bot role, the newest duties and the newest rules (`ompdesk-bot`);
 * a session with no entry, and the bot's own subagents, never do.
 */
import { describe, expect, it } from "vitest";
import { BOT_ENTRY, botSection, install, methods } from "../../resources/gui-bridge/agent-control";
import type { JournalEntry, PromptSectionContext, PromptSectionHost } from "../../resources/gui-bridge/prompt-sections";
import { botRulesText, DEFAULT_BOT_RULES } from "../shared/bot-rules";

type BridgeEnv = Parameters<NonNullable<(typeof methods)[string]>>[1];
type Handler = Parameters<PromptSectionHost["on"]>[1];

function hook(): Handler {
	const handlers: Handler[] = [];
	install({ on: (_event, handler) => handlers.push(handler) });
	expect(handlers).toHaveLength(1);
	return handlers[0] as Handler;
}

function session(entries: JournalEntry[], kind = "main"): PromptSectionContext {
	return { sessionManager: { getBranch: () => entries }, agent: { kind } };
}

function envOver(journal: JournalEntry[]): BridgeEnv {
	return {
		session: () => ({
			sessionManager: {
				getBranch: () => journal,
				appendCustomEntry: (customType: string, data: unknown) =>
					journal.push({ type: "custom", customType, data }),
			},
		}),
	} as unknown as BridgeEnv;
}

const BASE = ["You are omp."];
const RULES = botRulesText(DEFAULT_BOT_RULES);

describe("bot role", () => {
	it("is in the prompt of a session holding the bot entry, with the owner's rules", () => {
		const entries: JournalEntry[] = [{ type: "custom", customType: BOT_ENTRY, data: { rules: RULES } }];
		const section = hook()({ systemPrompt: BASE }, session(entries))?.systemPrompt;
		expect(section).toEqual([...BASE, botSection(RULES)]);
		const text = botSection(RULES);
		expect(text).toContain("always-on bot");
		expect(text).toContain("ompdesk_session_open");
		expect(text).toContain("ompdesk_notify");
		expect(text).toContain('ompdesk_schedule {"target":"self"}');
		expect(text).toContain("- Make payments or purchases: ask the owner before taking it.");
		expect(text).toContain("- Edit code: take it without asking.");
	});

	it("lists the standing duties, and says none yet when there are none", () => {
		const duties = "- Check the nightly build every morning (id 0a1b2c3d)\n- Watch the release (id 11223344)";
		const entries: JournalEntry[] = [{ type: "custom", customType: BOT_ENTRY, data: { rules: RULES, duties } }];
		const text = hook()({ systemPrompt: BASE }, session(entries))?.systemPrompt?.at(-1) ?? "";
		expect(text).toBe(botSection(RULES, undefined, duties));
		expect(text).toContain(`Standing duties:\n${duties}\nRules:`);
		expect(text).toContain('ompdesk_bot {"action":"decide"}');
		expect(text).toContain('ompdesk_bot {"action":"duty_add"}');
		expect(text).toContain("the owner's answer comes back to you as a message that starts your turn");
		// An entry journaled before the desk existed carries rules only: the section still builds, with no duties.
		const old: JournalEntry[] = [{ type: "custom", customType: BOT_ENTRY, data: { rules: RULES } }];
		const plain = hook()({ systemPrompt: BASE }, session(old))?.systemPrompt?.at(-1) ?? "";
		expect(plain).toContain("Standing duties: none yet.");
		expect(plain).toBe(botSection(RULES));
	});

	it("is not in the prompt of a session without the entry, nor of the bot's subagents", () => {
		const on = hook();
		expect(
			on({ systemPrompt: BASE }, session([{ type: "custom", customType: "ompdesk.agent-answer" }])),
		).toBeUndefined();
		expect(on({ systemPrompt: BASE }, session([]))).toBeUndefined();
		const entries: JournalEntry[] = [{ type: "custom", customType: BOT_ENTRY, data: { rules: RULES } }];
		expect(on({ systemPrompt: BASE }, session(entries, "subagent"))).toBeUndefined();
	});

	it("names the bot by its session's title, the name the owner set", () => {
		const entries: JournalEntry[] = [{ type: "custom", customType: BOT_ENTRY, data: { rules: RULES } }];
		const named: PromptSectionContext = {
			sessionManager: { getBranch: () => entries, getSessionName: () => "  Jarvis  " },
			agent: { kind: "main" },
		};
		const text = hook()({ systemPrompt: BASE }, named)?.systemPrompt?.at(-1) ?? "";
		expect(text).toContain('You are "Jarvis", the owner\'s always-on bot.');
		// An untitled session (or an omp without the getter) keeps the plain role.
		expect(botSection(RULES, "  ")).toContain("You are the owner's always-on bot.");
	});

	it("follows the newest entry when the rules change, and says so when the owner has none", () => {
		const on = hook();
		const entries: JournalEntry[] = [
			{
				type: "custom",
				customType: BOT_ENTRY,
				data: { rules: "- Deploy or release: ask the owner before taking it." },
			},
			{ type: "custom", customType: "ompdesk.agent-answer", data: {} },
			{ type: "custom", customType: BOT_ENTRY, data: { rules: "- Deploy or release: take it without asking." } },
		];
		const section = on({ systemPrompt: BASE }, session(entries))?.systemPrompt?.[1];
		expect(section).toContain("- Deploy or release: take it without asking.");
		expect(section).not.toContain("ask the owner before taking it");
		entries.push({ type: "custom", customType: BOT_ENTRY, data: { rules: "" } });
		expect(on({ systemPrompt: BASE }, session(entries))?.systemPrompt?.[1]).toContain(
			"The owner set no rules: act on your own.",
		);
	});

	it("is journaled by agent_control.bot only when the rules or the duties differ from the newest entry", async () => {
		const journal: JournalEntry[] = [];
		const env = envOver(journal);
		await expect(methods["agent_control.bot"]?.({ rules: RULES }, env)).resolves.toEqual({ changed: true });
		await expect(methods["agent_control.bot"]?.({ rules: RULES }, env)).resolves.toEqual({ changed: false });
		expect(journal).toHaveLength(1);
		expect(journal[0]).toMatchObject({ customType: BOT_ENTRY, data: { rules: RULES } });
		await expect(
			methods["agent_control.bot"]?.({ rules: "- Merge a branch: ask the owner before taking it." }, env),
		).resolves.toEqual({
			changed: true,
		});
		expect(journal).toHaveLength(2);
		// Going back to the earlier text is a change again: the newest entry wins, not any entry.
		await expect(methods["agent_control.bot"]?.({ rules: RULES }, env)).resolves.toEqual({ changed: true });
		expect(journal).toHaveLength(3);
		await expect(methods["agent_control.bot"]?.({ rules: "" }, env)).resolves.toEqual({ changed: true });
		await expect(methods["agent_control.bot"]?.({}, env)).rejects.toThrow("rules");
	});

	it("journals the duties with the rules, once per text, and a caller with no duties tells none", async () => {
		const journal: JournalEntry[] = [];
		const env = envOver(journal);
		const duties = "- Check the nightly build every morning (id 0a1b2c3d)";
		await expect(methods["agent_control.bot"]?.({ rules: RULES, duties }, env)).resolves.toEqual({ changed: true });
		await expect(methods["agent_control.bot"]?.({ rules: RULES, duties }, env)).resolves.toEqual({ changed: false });
		expect(journal.at(-1)).toMatchObject({ customType: BOT_ENTRY, data: { rules: RULES, duties } });
		// The same rules with other duties is a change; so is dropping them.
		await expect(
			methods["agent_control.bot"]?.({ rules: RULES, duties: `${duties}\n- Watch the release (id 11223344)` }, env),
		).resolves.toEqual({ changed: true });
		await expect(methods["agent_control.bot"]?.({ rules: RULES, duties: "" }, env)).resolves.toEqual({
			changed: true,
		});
		await expect(methods["agent_control.bot"]?.({ rules: RULES }, env)).resolves.toEqual({ changed: false });
		expect(journal).toHaveLength(3);
		await expect(methods["agent_control.bot"]?.({ rules: RULES, duties: 7 }, env)).rejects.toThrow("duties");
	});
});
