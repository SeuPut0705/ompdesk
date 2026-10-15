/**
 * gui-bridge per-turn prompt sections (resources/gui-bridge/prompt-sections.ts):
 * stock drops what `before_agent_start` appended once the turn ends, so the
 * context inspector rebuilds the next turn's prompt from the sections every
 * mode registered. The inspector shows what the hook sends, once, in install order.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install as installOutputStyle, setOutputStyle } from "../../resources/gui-bridge/modes/output-style";
import { install as installReplyLanguage, setReplyLanguage } from "../../resources/gui-bridge/modes/reply-language";
import { install as installUserProfile, setUserProfile } from "../../resources/gui-bridge/modes/user-profile";
import {
	appendIfMissing,
	type PromptSectionContext,
	type PromptSectionHost,
	withTurnSections,
} from "../../resources/gui-bridge/prompt-sections";

type Handler = Parameters<PromptSectionHost["on"]>[1];

const context: PromptSectionContext = { sessionManager: { getBranch: () => [] }, agent: { kind: "main" } };

function installAll(): Handler[] {
	const handlers: Handler[] = [];
	const host: PromptSectionHost = { on: (_event, handler) => handlers.push(handler) };
	installReplyLanguage(host);
	installOutputStyle(host);
	installUserProfile(host);
	return handlers;
}

function resetModes(): void {
	setReplyLanguage({ language: null });
	setOutputStyle({ style: "default" });
	setUserProfile({ name: "", experience: null });
}

// The spawn environment may carry a language or profile; the defaults are what these tests start from.
beforeEach(resetModes);
afterEach(resetModes);

describe("gui-bridge turn prompt sections", () => {
	it("adds nothing while every mode is at its default", () => {
		installAll();
		const stock = ["base", "context"];
		expect(withTurnSections(stock, context)).toBe(stock);
	});

	it("rebuilds the sections the hook sends for the next turn, in install order", () => {
		const handlers = installAll();
		setReplyLanguage({ language: "Korean" });
		setOutputStyle({ style: "concise" });
		setUserProfile({ name: "Seu", experience: "beginner" });
		const stock = ["base", "context"];

		const shown = withTurnSections(stock, context);
		expect(shown.slice(0, 2)).toEqual(stock);
		expect(shown).toHaveLength(5);
		expect(shown[2]).toContain("<reply-language>");
		expect(shown[3]).toContain("<output-style>");
		expect(shown[4]).toContain("<user-profile>");

		// What the model gets is the same prompt: each hook sees the previous one's output.
		let sent: string[] = stock;
		for (const handler of handlers) sent = handler({ systemPrompt: sent }, context)?.systemPrompt ?? sent;
		expect(sent).toEqual([...shown]);
	});

	it("never repeats a section the prompt already carries", () => {
		installAll();
		setReplyLanguage({ language: "Korean" });
		const once = withTurnSections(["base"], context);
		expect(withTurnSections(once, context)).toBe(once);
		expect(appendIfMissing(["a\nb\nc"], "b")).toEqual(["a\nb\nc"]);
	});

	it("keeps one section per mode when a subagent installs the extension again", () => {
		installAll();
		installAll();
		setReplyLanguage({ language: "Korean" });
		expect(withTurnSections(["base"], context)).toHaveLength(2);
	});
});
