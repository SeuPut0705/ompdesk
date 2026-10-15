/**
 * Keys meant for the conversation, wherever focus sits in a session pane: a
 * printable key (or an IME composition start) typed while focus is on the
 * transcript or tool chrome moves focus to the composer first, so the
 * character lands there; PageUp/PageDown in the composer page the transcript
 * unless a completion list or the composer's own scrollback takes them.
 * Dialogs, menus, listboxes and prompt cards (1–9 pick a row) keep their keys.
 */
export function installPaneKeys(
	pane: HTMLElement,
	page: (direction: "up" | "down", event: KeyboardEvent) => void,
): () => void {
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (!target || target.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-prompt-card]')) return;
		const composer = pane.querySelector<HTMLTextAreaElement>(".omp-composer-input");
		if (!composer) return;
		if (target === composer) {
			if (event.key !== "PageUp" && event.key !== "PageDown") return;
			if (pane.querySelector('.omp-composer-anchor [role="listbox"]')) return;
			const up = event.key === "PageUp";
			if (up ? composer.scrollTop > 0 : composer.scrollTop + composer.clientHeight < composer.scrollHeight) return;
			page(up ? "up" : "down", event);
			return;
		}
		const printable = (event.key.length === 1 && event.key !== " ") || event.key === "Process";
		if (!printable || target.isContentEditable || target.closest("input, textarea, select") || composer.disabled)
			return;
		composer.focus({ preventScroll: true });
	};
	pane.addEventListener("keydown", onKeyDown, true);
	return () => pane.removeEventListener("keydown", onKeyDown, true);
}
