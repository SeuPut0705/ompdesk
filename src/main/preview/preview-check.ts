/**
 * Preview check: after `gui_visualize open` loads a page, the judge model looks at that one page and says whether
 * it shows an error message or nothing at all (resources/gui-bridge/modes/judge-assist-contracts.ts; the numbers:
 * 22 agent-made pages, error ≥ 0.5 or empty ≥ 0.8 found 13/13 broken pages with 0 false alarms, p50 409 ms).
 *
 * Only an addition: the judge answers while stock's `judge` role chain resolves first to a native decision model
 * and the `judgeAssist` pref is on. A switch that is off, no native judge, an error, a timeout or an answer of
 * "did not decide" all end as `null` here, so the tool answers byte for byte as it did before and no notice shows.
 *
 * Privacy: the capture is `capturePage()` of the one preview page that shows the visual (main/preview/host.ts),
 * never the app window, another preview tab or a window of the user, and only while that page is on screen. It is
 * never a page the user browses: a visual is a page the agent just asked the Preview to show.
 */
import type {
	PreviewCheckResult,
	PreviewProblem as PreviewVerdict,
} from "../../../resources/gui-bridge/modes/judge-assist-contracts";
import type { RpcClient } from "../rpc-client";
import type { VisualPages } from "./visuals";

export type { PreviewVerdict };

/** The longer side of the picture sent to the judge; keeps the request small. */
export const PREVIEW_CHECK_IMAGE_MAX = 1280;
/** A page that finished loading paints its last frame within this long (late scripts, fonts, layout). */
export const PREVIEW_CHECK_SETTLE_MS = 300;
/** Until the page is on screen, loaded and settled; later the capture is given up. */
export const PREVIEW_CHECK_CAPTURE_MS = 2000;
/** The whole check (probe + page + settle + judge) holds the tool's answer at most this long. */
export const PREVIEW_CHECK_TOTAL_MS = 4000;
/** Asking the tab's omp whether a native judge would answer at all; no answer in time counts as "no". */
export const PREVIEW_CHECK_PROBE_MS = 500;

export interface PreviewImage {
	data: string;
	mimeType: "image/png";
}

export interface PreviewCheckDeps {
	/** The `judgeAssist` pref: with the switch off nothing is captured. */
	enabled(): boolean;
	/**
	 * Whether the tab's omp has a native judge (stock `hasNativeJudge`, no model call). Without one the check ends here:
	 * no waiting for the page, no capture, so a user with the switch on but no native judge loses no time.
	 */
	available(budgetMs: number): Promise<boolean>;
	/** The visual's own page as a PNG once it is on screen and settled; null when there is none within `budgetMs`. */
	capture(visualId: string, version: number, budgetMs: number): Promise<PreviewImage | null>;
	/** The tab's omp judges the picture; null when the request failed. */
	judge(image: PreviewImage, budgetMs: number): Promise<PreviewCheckResult | null>;
	/** Show the quiet notice on the page that shows `version` of the visual. */
	flag(visualId: string, version: number, problem: PreviewVerdict): void;
}

/** What the agent reads under the tool result; English because tool results are model-facing. */
export function previewHint(problem: PreviewVerdict): string {
	const seen = problem === "error" ? "the page shows an error message." : "the page looks blank (nothing rendered).";
	return `Preview check: ${seen} Look at it with gui_visualize or fix the page.`;
}

/** `promise`'s value, or null once `ms` passed (its late answer is dropped). */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<null>(resolve => {
		timer = setTimeout(() => resolve(null), ms);
	});
	try {
		return await Promise.race([promise, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** The part of Electron's `NativeImage` the picture for the judge needs. */
export interface CapturedImage {
	isEmpty(): boolean;
	getSize(): { width: number; height: number };
	resize(options: { width: number; height: number; quality: "good" }): CapturedImage;
	toPNG(): Buffer;
}

/** The capture as a PNG whose longer side is at most `PREVIEW_CHECK_IMAGE_MAX`; null for an empty capture. */
export function judgeImage(image: CapturedImage): PreviewImage | null {
	// A page that is not painted (hidden, zero-sized) captures as nothing; that is no evidence of a blank page.
	if (image.isEmpty()) return null;
	const { width, height } = image.getSize();
	const longer = Math.max(width, height);
	const fitted =
		longer > PREVIEW_CHECK_IMAGE_MAX
			? image.resize({
					width: Math.max(1, Math.round((width * PREVIEW_CHECK_IMAGE_MAX) / longer)),
					height: Math.max(1, Math.round((height * PREVIEW_CHECK_IMAGE_MAX) / longer)),
					quality: "good",
				})
			: image;
	return { data: fitted.toPNG().toString("base64"), mimeType: "image/png" };
}

/**
 * Whether the page of `version` of `visualId` shows an error or nothing, within `PREVIEW_CHECK_TOTAL_MS`; on a
 * problem the page also gets its notice. Never rejects and never takes longer: every other outcome is `null`.
 */
export async function checkVisualPage(
	deps: PreviewCheckDeps,
	visualId: string,
	version: number,
): Promise<PreviewVerdict | null> {
	if (!deps.enabled()) return null;
	const started = Date.now();
	// An answer after the deadline is dropped: the tool has replied, and the code-rule path shows no notice.
	let open = true;
	const decide = async (): Promise<PreviewVerdict | null> => {
		try {
			const available = await withDeadline(deps.available(PREVIEW_CHECK_PROBE_MS), PREVIEW_CHECK_PROBE_MS);
			if (available !== true || !open) return null;
			const image = await deps.capture(visualId, version, PREVIEW_CHECK_CAPTURE_MS);
			if (!image || !open) return null;
			const result = await deps.judge(image, Math.max(0, PREVIEW_CHECK_TOTAL_MS - (Date.now() - started)));
			if (!open || !result?.judged || !result.problem) return null;
			deps.flag(visualId, version, result.problem);
			return result.problem;
		} catch {
			return null;
		}
	};
	try {
		return await withDeadline(decide(), PREVIEW_CHECK_TOTAL_MS);
	} finally {
		open = false;
	}
}

/**
 * The check of a tab's visual: the pages of its window do the capture, the tab's own omp the judging (a local
 * command, main/local/judge-assist.ts: its judge, its quota). `rpc` is null while the tab's omp is not running.
 */
export function createTabCheck(options: {
	enabled: () => boolean;
	pages: Pick<VisualPages, "capture" | "flag">;
	rpc: Pick<RpcClient, "command"> | null;
}): (visualId: string, version: number) => Promise<PreviewVerdict | null> {
	const { enabled, pages, rpc } = options;
	return (visualId, version) =>
		checkVisualPage(
			{
				enabled,
				available: async budgetMs => {
					const response = await rpc?.command({ type: "judge_available" }, budgetMs);
					return (
						response?.success === true &&
						(response.data as { available?: unknown } | undefined)?.available === true
					);
				},
				capture: (id, shown, budgetMs) => pages.capture(id, shown, budgetMs),
				judge: async (image, budgetMs) => {
					const response = await rpc?.command({ type: "judge_preview_check", image }, budgetMs);
					if (!response?.success) return null;
					const data = response.data as Partial<PreviewCheckResult> | undefined;
					const problem = data?.problem === "error" || data?.problem === "blank" ? data.problem : null;
					return { problem, judged: data?.judged === true };
				},
				flag: (id, shown, problem) => pages.flag(id, shown, problem),
			},
			visualId,
			version,
		);
}
