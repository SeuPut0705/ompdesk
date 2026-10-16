/**
 * Jump into the work board of the focused session pane: its first row that waits on the user,
 * else its first row, else the board itself. Returns whether a board took the focus.
 */
export function focusWorkBoard(): boolean {
	const board =
		document.querySelector<HTMLElement>('.omp-session-pane[data-active="true"] [data-work-board-panel]') ??
		document.querySelector<HTMLElement>("[data-work-board-panel]");
	if (!board) return false;
	const target =
		board.querySelector<HTMLElement>("button[data-board-waiting]") ??
		board.querySelector<HTMLElement>("button.omp-work-board-row") ??
		board.querySelector<HTMLElement>("button");
	(target ?? board).focus();
	return true;
}
