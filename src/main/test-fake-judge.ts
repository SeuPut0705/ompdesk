/**
 * A fake stock `judgment` module for the judge-assist tests (resources/gui-bridge/modes/judge-assist-engine.ts
 * `setJudgeAssistStockLoader`): what stock's judge answers is a function the test sets, every request and every
 * `resolveJudge` dependency set is recorded, and `native` stands for `hasNativeJudge`.
 */
import type { JudgeAssistStock } from "../../resources/gui-bridge/modes/judge-assist-engine";

export interface FakeJudge {
	stock: JudgeAssistStock;
	/** What `hasNativeJudge` answers; read on every judgment. */
	native: { current: boolean };
	/** The answers for a request; may throw or never settle. */
	answer: { current: (request: unknown, signal: AbortSignal) => Promise<unknown> };
	/** The dependency set of each `resolveJudge` call. */
	deps: unknown[];
	/** Each judged request. */
	requests: unknown[];
	/** The managers `journalJudgmentUsage` was given, and the ledger callback it returned. */
	journaled: { managers: unknown[]; onUsage: (usage: unknown) => void };
	/** What `sharedJudgmentCache` returns. */
	cache: object;
	/** Whether the chain's primary model takes images natively (`nativeJudgmentImageBounds` is defined for it). */
	takesImages: { current: boolean };
	/** The model `primaryModel()` answers. */
	primary: { provider: string; id: string };
}

export function fakeJudge(answer: FakeJudge["answer"]["current"]): FakeJudge {
	const native = { current: true };
	const answers = { current: answer };
	const deps: unknown[] = [];
	const requests: unknown[] = [];
	const journaled: FakeJudge["journaled"] = { managers: [], onUsage: () => {} };
	const cache = { shared: true };
	const takesImages = { current: true };
	const primary = { provider: "jev", id: "jev-latest" };
	const stock: JudgeAssistStock = {
		hasNativeJudge: () => native.current,
		resolveJudge: dependencies => {
			deps.push(dependencies);
			return {
				primaryModel: () => primary,
				judge: async (request, options) => {
					requests.push(request);
					return { answers: await answers.current(request, options.signal) };
				},
			};
		},
		nativeJudgmentImageBounds: model => (model === primary && takesImages.current ? {} : undefined),
		sharedJudgmentCache: () => cache,
		journalJudgmentUsage: manager => {
			journaled.managers.push(manager);
			return journaled.onUsage;
		},
	};
	return { stock, native, answer: answers, deps, requests, journaled, cache, takesImages, primary };
}

/** The answer to the needs-user question (judge-assist-core.ts `needsUserRequest`) at probability `p`. */
export const needsAnswer = (p: number) => ({ needs: { type: "noul", noul: p } });

/** The answer to the title question (`titleFitRequest`). */
export const titleAnswer = (choice: "A" | "B" | "same") => ({ better: { type: "choice", choice } });

/** The answers to the two preview questions (`PREVIEW_QUESTIONS`). */
export const previewAnswer = (error: number, empty: number) => ({
	error: { type: "noul", noul: error },
	empty: { type: "noul", noul: empty },
});

/** The answers to memory recall's questions (judge-assist-core.ts `recallRequest`), one probability per snippet. */
export const recallAnswer = (...probabilities: number[]) =>
	Object.fromEntries(probabilities.map((p, index) => [`s${index}`, { type: "noul", noul: p }]));
