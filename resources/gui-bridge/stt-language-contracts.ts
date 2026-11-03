/** `stt_prepare` (voice.ts): the shapes main and the renderer read. Dependency-free. */

export type SttModelState =
	| { state: "ready" }
	| { state: "downloading"; percent: number }
	/** The last download `stt_prepare` started failed; reported once, so the next one tries again. */
	| { state: "failed"; error: string };

/** The language heard (a code; null when none is set), the model the rule picks for it, and where its weights stand. */
export type SttPrepareResult = { language: string | null; modelKey: string } & SttModelState;
