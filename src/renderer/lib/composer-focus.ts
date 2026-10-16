/**
 * The focused session pane's composer field (InputArea's textarea, `data-composer-input`). A pane holds
 * other text fields too (an ask card's answer, a queue row being edited, a subagent's steer box), so
 * "the first textarea in the pane" is not the composer.
 */
export function activeComposerInput(): HTMLTextAreaElement | null {
	return document.querySelector<HTMLTextAreaElement>(
		'.omp-session-pane[data-active="true"] textarea[data-composer-input]',
	);
}
