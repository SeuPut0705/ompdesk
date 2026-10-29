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
	keepSectionsOnRestore,
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

/** A stock session as its restore drives it: the prompt the agent holds is what the continued turn sends. */
class RestoredSession {
	readonly baseSystemPrompt = ["base", "context"];
	prompt: string[] = this.baseSystemPrompt;
	sent: string[] | undefined;
	get systemPrompt(): string[] {
		return this.prompt;
	}
	readonly agent = { setSystemPrompt: (prompt: string[]) => (this.prompt = prompt) };
	readonly extensionRunner: { createContext(): PromptSectionContext };
	constructor(
		readonly continues: boolean,
		kind: "main" | "sub" = "main",
	) {
		this.extensionRunner = { createContext: () => ({ ...context, agent: { kind } }) };
	}
	async restoreInterruptedTurn(): Promise<boolean> {
		if (this.continues) this.sent = this.prompt;
		return this.continues;
	}
}

describe("gui-bridge sections of a turn stock's restore continues", () => {
	// 27 Oct 2026: revived subagents and the restored parent turn went on without the sections (stock runs the hook
	// for a prompt, never for a continued turn), so their first requests missed the cache and the reply language.
	it("continues a restored turn with the sections a prompt of that session would send", async () => {
		installAll();
		setReplyLanguage({ language: "Korean" });
		keepSectionsOnRestore(RestoredSession.prototype);
		const main = new RestoredSession(true);
		expect(await main.restoreInterruptedTurn()).toBe(true);
		expect(main.sent).toEqual([...withTurnSections(main.baseSystemPrompt, context)]);
		expect(main.sent?.at(-1)).toContain("<reply-language>");
		const sub = new RestoredSession(true, "sub");
		await sub.restoreInterruptedTurn();
		expect(sub.sent?.at(-1)).toContain("<reply-language>");
	});

	it("leaves the prompt alone when the restore continues nothing, and wraps the restore once", async () => {
		installAll();
		setReplyLanguage({ language: "Korean" });
		keepSectionsOnRestore(RestoredSession.prototype);
		keepSectionsOnRestore(RestoredSession.prototype);
		const idle = new RestoredSession(false);
		expect(await idle.restoreInterruptedTurn()).toBe(false);
		expect(idle.prompt).toBe(idle.baseSystemPrompt);
		const main = new RestoredSession(true);
		await main.restoreInterruptedTurn();
		expect(main.sent?.filter(part => part.includes("<reply-language>"))).toHaveLength(1);
	});
});

describe("gui-bridge turn prompt: a prompt and a restored turn send the same sections", () => {
	const languages = [null, "Korean"] as const;
	const styles = ["default", "concise"] as const;
	const profiles = [
		{ name: "", experience: null },
		{ name: "Seu", experience: "expert" },
	] as const;
	const cases = languages.flatMap(language =>
		styles.flatMap(style =>
			profiles.flatMap(profile => (["main", "sub"] as const).map(kind => ({ language, style, profile, kind }))),
		),
	);
	it.each(cases)(
		"language $language, style $style, profile $profile.name, $kind agent",
		async ({ language, style, profile, kind }) => {
			const handlers = installAll();
			setReplyLanguage({ language });
			setOutputStyle({ style });
			setUserProfile(profile);
			keepSectionsOnRestore(RestoredSession.prototype);
			const ctx: PromptSectionContext = { ...context, agent: { kind } };
			// A prompt: stock runs every `before_agent_start` handler in turn over the base prompt.
			let live: string[] = ["base", "context"];
			for (const handler of handlers)
				live = handler({ systemPrompt: live, prompt: "go on" }, ctx)?.systemPrompt ?? live;
			// A turn stock's restore continues gets them without a prompt.
			const restored = new RestoredSession(true, kind);
			await restored.restoreInterruptedTurn();
			expect(restored.sent).toEqual(live);
		},
	);
});
