/**
 * `?bot=1`: the first tab is the owner's bot (prefs `botEnabled` and `bot` in boot.ts) and its desk holds a duty, a
 * memory and an open decision with an operation, so the bot's bar and decision dock draw for captures.
 */

import { type BotDeskState, EMPTY_BOT_DESK } from "../../shared/bot-desk";

export const BOT_ON = typeof location !== "undefined" && new URLSearchParams(location.search).get("bot") === "1";

const AT = "2026-11-02T09:00:00.000Z";

export const BOT_DESK: BotDeskState = BOT_ON
	? {
			...EMPTY_BOT_DESK,
			identity: { ...EMPTY_BOT_DESK.identity, tagline: "Keeps the release train moving" },
			duties: [{ id: "duty-1", text: "Watch CI on main and rerun a flaky job once", at: AT }],
			memories: [{ id: "memory-1", text: "Releases go out after three user-visible changes", by: "owner", at: AT }],
			decisions: [
				{
					id: "decision-1",
					state: "open",
					question: "Ship v0.95.0 now? Three fixes landed since v0.94.1.",
					options: ["Ship it", "Wait for the theme work"],
					context: "CI is green on main; the nightly e2e passed.",
					operation: "gh workflow run release.yml",
					inputs: { version: "0.95.0" },
					at: AT,
				},
			],
		}
	: EMPTY_BOT_DESK;
