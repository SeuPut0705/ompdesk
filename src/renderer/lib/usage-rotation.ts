import type { UsageReport } from "../../shared/rpc-types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The rotation's answers that carry a line; the rest (one account, no account yet, no model) say nothing. */
const ROTATION_REASONS: ReadonlySet<string> = new Set([
	"better",
	"near-limit",
	"much-better",
	"same",
	"within-margin",
	"mid-turn",
	"no-better",
	"usage-unreadable",
	"explicit",
	"restricted",
	"policy",
	"blocked",
	"subagents",
	"cold",
	"no-choice",
	"target-limited",
	"pin-refused",
	"mode",
	"unknown-provenance",
]);

/**
 * Why this session is on the account of its card, in words (en/ko keys `usage.rotation.*`); null without a line. Read by
 * Insights › Usage (`UsageQuotas`) and the sidebar's usage block (`SidebarUsage`), kept apart from both so the sidebar
 * does not load the Insights page.
 */
export function rotationReason(rotation: UsageReport["rotation"], t: Translate): string | null {
	return rotation && ROTATION_REASONS.has(rotation.why) ? t(`usage.rotation.${rotation.why}`) : null;
}
