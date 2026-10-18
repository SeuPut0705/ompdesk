/**
 * Props for a press that must not move focus: the composer's field keeps its caret and the soft keyboard while Send,
 * Stop, +, a status chip or the lane chip is tapped. `mousedown` only: cancelling `pointerdown` also cancels the
 * click in WebKit (measured with Playwright WebKit, iPhone 15: every control went dead), while a cancelled
 * synthesized `mousedown` keeps focus in both Chromium and WebKit and lets the click fire.
 */
export const keepFocus = {
	onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
} as const;
