import { createContext } from "react";

/** A step a finding points at; a new object each time, so asking for the same step again acts again. */
export interface StepReveal {
	/** The call's entry key. */
	key: string;
}

/** The step the card's findings last asked to show: the group holding it opens. */
export const StepRevealContext = createContext<StepReveal | null>(null);

/** How long the opened card is waited for: its rows mount a slice per task (`useMountedCount`). */
const TRIES = 40;
const TRY_MS = 50;

/**
 * Shows one step of an opened work card: its tool card is found by the entry key it carries
 * (`data-tool-call-id`), opened when it is closed, and scrolled into the middle of the view. The card
 * may not be mounted yet (the body opened this frame, a big card mounts in slices), so it is looked for
 * for a couple of seconds. Returns the cancel.
 */
export function revealStep(root: ParentNode | null, key: string): () => void {
	let tries = 0;
	let timer: number | undefined;
	const attempt = () => {
		const card = root
			? [...root.querySelectorAll<HTMLElement>("[data-tool-call-id]")].find(el => el.dataset.toolCallId === key)
			: undefined;
		if (card) {
			const header = card.querySelector<HTMLButtonElement>("button[aria-expanded]");
			if (header?.getAttribute("aria-expanded") === "false") header.click();
			// The opened body moves what is below it, so the view settles after the click's own render.
			timer = window.setTimeout(() => card.scrollIntoView?.({ block: "center" }), 0);
			return;
		}
		if (++tries < TRIES) timer = window.setTimeout(attempt, TRY_MS);
	};
	attempt();
	return () => window.clearTimeout(timer);
}
