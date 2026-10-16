import type { UsageLimit } from "../../shared/rpc-types";

/** The canonical window id, else the middle part of a stock limit id (`anthropic:5h` → `5h`). */
function windowKey(limit: UsageLimit): string {
	return limit.windowId ?? limit.id.split(":")[1] ?? "";
}

/** A window's length in hours from its canonical id, or Infinity for one stock made up. */
function windowHours(limit: UsageLimit): number {
	const id = windowKey(limit);
	const span = /^(\d+)([hd])$/.exec(id);
	if (span) return Number(span[1]) * (span[2] === "h" ? 1 : 24);
	if (id === "daily") return 24;
	if (id === "weekly" || id === "1w") return 168;
	if (id === "monthly") return 720;
	return Number.POSITIVE_INFINITY;
}

/** "5H", "7D": the window's own short name — from its id, else the first word of its label. */
export function shortWindowLabel(limit: UsageLimit): string {
	const id = windowKey(limit);
	const span = /^(\d+)([hd])$/.exec(id);
	if (span) return `${span[1]}${span[2]?.toUpperCase()}`;
	if (id === "daily") return "1D";
	if (id === "weekly" || id === "1w") return "7D";
	if (id === "monthly") return "30D";
	return (limit.windowLabel ?? limit.label).split(/[\s(]/)[0]?.slice(0, 4).toUpperCase() ?? "";
}

/**
 * The windows the row gauges: the two tightest of the account's whole-account limits (a per-model tier such as
 * `7d:opus` only when nothing else is measured), shortest window first. The gauge fills with the share used,
 * as the Settings accounts row does.
 */
export function accountWindows(limits: readonly UsageLimit[]): { limit: UsageLimit; fraction: number }[] {
	const measured = limits.flatMap(limit => {
		const fraction =
			limit.usedFraction ?? (limit.used !== undefined && limit.limit ? limit.used / limit.limit : null);
		return fraction === null ? [] : [{ limit, fraction }];
	});
	const plain = measured.filter(entry => entry.limit.id.split(":").length <= 2);
	return (plain.length > 0 ? plain : measured)
		.sort((a, b) => b.fraction - a.fraction)
		.slice(0, 2)
		.sort((a, b) => windowHours(a.limit) - windowHours(b.limit));
}
