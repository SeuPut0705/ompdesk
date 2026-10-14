/**
 * Usage-limit titles in the UI language. Stock names each limit in English
 * (`Claude 5 Hour`, `7 Day (Spark)`) and keys it with a stable limit id and a
 * canonical window id (`5h`, `7d`, `monthly`; the status line's contract), so
 * the UI names known limits by id, a bare window by its id, and anything else
 * with stock's own label.
 */

import type { UsageLimit } from "../../shared/rpc-types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Stock limit ids whose label names more than the window (provider brand, model tier). */
const LIMIT_KEYS: Record<string, string> = {
	"anthropic:5h": "usage.limit.5h",
	"anthropic:7d": "usage.limit.weekly",
	"anthropic:7d:opus": "usage.limit.7dOpus",
	"anthropic:7d:sonnet": "usage.limit.7dSonnet",
	"anthropic:7d:fable": "usage.limit.7dFable",
	"anthropic:extra": "usage.limit.extra",
};

/** The window a canonical stock window id names, or `undefined` for an id stock made up per provider. */
export function usageWindowName(windowId: string, t: Translate): string | undefined {
	switch (windowId) {
		case "7d":
		case "1w":
		case "weekly":
			return t("usage.limit.weekly");
		case "daily":
			return t("usage.limit.daily");
		case "monthly":
			return t("usage.limit.monthly");
	}
	const span = /^(\d+)([hd])$/.exec(windowId);
	if (!span) return undefined;
	const count = Number(span[1]);
	return t(span[2] === "h" ? "usage.limit.hours" : "usage.limit.days", { count });
}

/** A limit's title: a known stock id, then a label that is just its window (optionally `(Tier)`), else stock's label. */
export function usageLimitLabel(limit: Pick<UsageLimit, "id" | "label" | "windowId" | "windowLabel">, t: Translate) {
	const key = LIMIT_KEYS[limit.id];
	if (key) return t(key);
	const window = limit.windowId ? usageWindowName(limit.windowId, t) : undefined;
	if (!window || !limit.windowLabel) return limit.label;
	if (limit.label === limit.windowLabel) return window;
	const tier = limit.label.startsWith(`${limit.windowLabel} (`) && limit.label.endsWith(")");
	return tier ? `${window}${limit.label.slice(limit.windowLabel.length)}` : limit.label;
}
