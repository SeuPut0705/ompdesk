/**
 * Automatic session titles: the guarded bridge methods. The engine (../auto-title-engine.ts) holds the
 * behaviour; this file puts it behind the compatibility guard, so a missing stock internal refuses the
 * methods with `unsupported_omp` (capabilities.ts `autoTitle`), and names the stock module the engine
 * calls. Stock's title functions themselves are methods of the live session (`generateTitle`,
 * `renameTitle`, `setTitleSystemPrompt`), checked by the guard through `REQUIREMENTS.autoTitle.session`.
 */
import { handlers, setAutoTitleStockLoader } from "../auto-title-engine";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { ompPrompt } from "./shared";

// Dynamic, after `guard` checked the feature: a stock export that vanished must fail this feature, not link time.

setAutoTitleStockLoader(async () => {
	const [messages, cards, { prompt }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/session/messages"),
		import("@oh-my-pi/pi-coding-agent/utils/title-card"),
		import("@oh-my-pi/pi-utils"),
	]);
	return {
		operatorTitleText: messages.operatorTitleText,
		// Stock's own text, rendered the way `title-generator.ts` renders its default (`prompt.render(titleSystemPrompt)`).
		titleSystemPrompt: prompt.render(ompPrompt("system/title-system.md")),
		splitCardTitle: cards.splitCardTitle,
		formatCardTitle: cards.formatCardTitle,
	};
});

export const methods: BridgeMethods = guard("autoTitle", handlers);
