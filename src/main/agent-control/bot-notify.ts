/**
 * Where a notice of the bot's reaches the owner (dots' channel routing, Muse's and Duet's "how often"): each kind
 * (`progress`, `decisions`, `done`) goes to the desktop banner, the paired phones' push, both, or nowhere, as the owner
 * set it on the desk (`BotNotify`), and a progress notice at most once an hour or a day when they asked for that. Every
 * notice the bot's tabs raise passes here: `ompdesk_notify` from the bot or a side chat, a decision it posts, its turn
 * ending, its own question. What the routing held is still in the activity log, so nothing is silently lost.
 */
import type { BotActivityDraft } from "../../shared/bot-activity";
import type { BotNotify, BotNotifyKind } from "../../shared/bot-desk";

const EVERY_MS = { all: 0, hourly: 60 * 60_000, daily: 24 * 60 * 60_000 } as const;

export interface BotNoticeRoute {
	banner: boolean;
	push: boolean;
}

export interface BotNoticeRouterDeps {
	notify(): BotNotify;
	log(draft: BotActivityDraft): void;
	now?: () => number;
}

export class BotNoticeRouter {
	readonly #deps: BotNoticeRouterDeps;
	/** When the last progress notice went out, for `progressEvery`. */
	#lastProgress: number | null = null;

	constructor(deps: BotNoticeRouterDeps) {
		this.#deps = deps;
	}

	/**
	 * Where this notice goes now. `surface` is what the caller delivers: a notice raised once for both (`ompdesk_notify`,
	 * a decision) is logged as sent or held; the banner of a turn's end is logged, the push the same turn raises
	 * separately is not, so one turn is one line.
	 */
	route(kind: BotNotifyKind, title: string, surface: "both" | "banner" | "push" = "both"): BotNoticeRoute {
		const settings = this.#deps.notify();
		const to = settings[kind];
		const now = (this.#deps.now ?? Date.now)();
		const tooSoon =
			kind === "progress" &&
			this.#lastProgress !== null &&
			now - this.#lastProgress < EVERY_MS[settings.progressEvery];
		const route: BotNoticeRoute =
			to === "quiet" || tooSoon
				? { banner: false, push: false }
				: { banner: to === "both" || to === "banner", push: to === "both" || to === "push" };
		if (surface === "push") return route;
		const sent = route.banner || route.push;
		if (sent && kind === "progress") this.#lastProgress = now;
		this.#deps.log({
			kind: "notify",
			action: sent ? "notice_sent" : "notice_held",
			by: "bot",
			text: `${kind}: ${title}`,
		});
		return route;
	}
}
