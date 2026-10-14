import { useT } from "../../lib/i18n";
import { asNumber, asRecord } from "../../lib/wire-value";

/**
 * Stock's `details.meta` (OutputMeta, pi-tui `tools/output-meta.ts`): the spill
 * wrapper's truncation record. Renderers strip the LLM-facing notice line from
 * the body and restate it here in the UI language.
 */

/** Locale key + params for the truncation notice; the component translates it. */
export interface TruncationNotice {
	key: string;
	params?: Record<string, number>;
}

/** Trailing `[Showing …]` / limits notice line appended by wrappedExecute. */
const GENERATED_NOTICE_RE =
	/^\[(?:Showing .+|\d+ (?:matches|results) limit reached\. .+|Some lines truncated to .+)\]$/;

/** Drop the last line when it is wrappedExecute's generated notice (stock `stripGeneratedOutputNotice`). */
export function stripGeneratedOutputNotice(text: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidate = trimmed.slice(lineStart === -1 ? 0 : lineStart + 1);
	if (!GENERATED_NOTICE_RE.test(candidate)) return text;
	return trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd();
}

/** `meta.truncation` → notice, after stock `formatTruncationMetaNotice`'s line counts. */
export function describeTruncation(truncation: Record<string, unknown>): TruncationNotice | null {
	const total = asNumber(truncation.totalLines);
	const count = asNumber(truncation.outputLines);
	const shownRange = asRecord(truncation.shownRange);
	if (truncation.direction === "middle") {
		return total != null && count != null
			? { key: "tools.bash.truncation.middleCount", params: { count, total } }
			: { key: "tools.bash.truncation.middle" };
	}
	const start = asNumber(shownRange?.start);
	const end = asNumber(shownRange?.end);
	if (start != null && end != null && total != null) {
		return { key: "tools.bash.truncation.range", params: { start, end, total } };
	}
	if (count != null && total != null) return { key: "tools.bash.truncation.count", params: { count, total } };
	return null;
}

/** The truncation record of a result's `details.meta`, if the spill wrapper cut it. */
export function metaTruncation(details: Record<string, unknown> | undefined): TruncationNotice | null {
	const truncation = asRecord(asRecord(details?.meta)?.truncation);
	return truncation ? describeTruncation(truncation) : null;
}

/** One quiet warning line for a truncated result. */
export function TruncationNote({ notice }: { notice: TruncationNotice }) {
	const t = useT();
	return <div className="font-mono text-sc-xs text-(--sc-warning)">[{t(notice.key, notice.params)}]</div>;
}
