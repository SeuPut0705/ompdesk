/**
 * The title editors' auto button (stock's `/rename` without a title, run by the tab's omp through the bridge's
 * `regenerate_title`). One state machine for every editor: the title bar, the rename dialog and the sidebar row.
 *
 * The result is already saved when the answer arrives, so the editor only has to show it; a failure becomes one
 * inline sentence under the field, never a toast.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { RpcResponse } from "../../shared/rpc-types";
import { inlineFailure } from "../lib/error-detail";
import { translate } from "../lib/i18n";

export interface AutoTitle {
	/** A request is running: the button shows a spinner and the editor stays put. */
	pending: boolean;
	/** The last attempt's failure, as one localized sentence; cleared when the next one starts or the field is typed in. */
	error: string | null;
	clearError(): void;
	/** Ask for a title. Resolves with it (already saved), or null after setting `error`. */
	run(): Promise<string | null>;
}

/** `regenerate_session_title` response data (resources/gui-bridge/modes/auto-title-contracts.ts `TitleRegenerateResult`). */
const regeneration = z.object({ title: z.string().nullable(), reason: z.enum(["none", "superseded"]).optional() });

/** What a response holds: the saved title, or the localized sentence for why there is none. */
export function regenerationOutcome(response: RpcResponse): { title: string } | { failure: string } {
	if (!response.success) return { failure: inlineFailure(response, translate("titleAuto.failed")).message };
	const data = regeneration.safeParse(response.data);
	if (data.success && data.data.title) return { title: data.data.title };
	return {
		failure: translate(data.success && data.data.reason === "superseded" ? "titleAuto.superseded" : "titleAuto.none"),
	};
}

export function useAutoTitle(regenerate: () => Promise<RpcResponse>): AutoTitle {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true);
	const busy = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const run = useCallback(async (): Promise<string | null> => {
		if (busy.current) return null;
		busy.current = true;
		setPending(true);
		setError(null);
		try {
			const outcome = regenerationOutcome(await regenerate());
			if ("title" in outcome) return outcome.title;
			if (mounted.current) setError(outcome.failure);
			return null;
		} catch (cause) {
			if (mounted.current) setError(inlineFailure(cause, translate("titleAuto.failed")).message);
			return null;
		} finally {
			busy.current = false;
			if (mounted.current) setPending(false);
		}
	}, [regenerate]);

	const clearError = useCallback(() => setError(null), []);
	return { pending, error, clearError, run };
}
