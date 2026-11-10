/**
 * The dictation bar's wait for the speech model a take's language needs: the bridge's `stt_prepare`. Only
 * `recordAndTranscribe` (`voice.ts`) imports it, dynamically, so the phone's first screen does not carry it.
 */
import type { SttPrepareResult } from "../../../resources/gui-bridge/stt-language-contracts";

/** How often the bar asks again while the speech model downloads. */
const PREPARE_POLL_MS = 500;

type SttPrepared =
	| { kind: "ready" }
	/** The model the language needs could not be had: the bridge goes on with the selected dictation model. */
	| { kind: "failed"; language: string | null; error: string }
	/** An omp without `stt_prepare`: nothing to wait for. */
	| { kind: "unsupported" };

type PrepareReply = { success: true; data?: unknown } | { success: false; error: string; code?: string };

/** The bridge's answer; a command that throws is a failed answer. */
async function askPrepare(): Promise<PrepareReply> {
	try {
		return await window.omp.rpc.sttPrepare();
	} catch (cause) {
		return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

/**
 * Get the speech model the take's language needs: ask the bridge, and while it downloads tell `onProgress` and ask
 * again every {@link PREPARE_POLL_MS} until it is here, failed, or `stopped()`.
 */
export async function prepareRecognition(
	onProgress: (language: string | null, percent: number) => void,
	stopped: () => boolean,
): Promise<SttPrepared> {
	for (;;) {
		const reply = await askPrepare();
		if (!reply.success) {
			// An omp without `stt_prepare`, or a paired host's older bridge ("Unknown bridge method").
			if (
				reply.code === "unsupported_omp" ||
				/unsupported_omp|unknown[ _]command|unknown bridge method/i.test(reply.error)
			)
				return { kind: "unsupported" };
			return { kind: "failed", language: null, error: reply.error };
		}
		const data = reply.data as SttPrepareResult | undefined;
		if (!data || data.state === "ready") return { kind: "ready" };
		if (data.state === "failed") return { kind: "failed", language: data.language, error: data.error };
		onProgress(data.language, data.percent);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, PREPARE_POLL_MS);
		await promise;
		if (stopped()) return { kind: "ready" };
	}
}
