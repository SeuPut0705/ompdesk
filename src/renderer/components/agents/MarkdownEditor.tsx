/**
 * A CodeMirror markdown field for long-form prompts (the agent editor's
 * instructions). CodeMirror is imported when the first editor mounts, not at
 * app startup. Uncontrolled after mount: `value` seeds the document and
 * `onChange` reports edits; remount (change `key`) to load another document.
 */

import type { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { Spinner } from "../common";

export interface MarkdownEditorProps {
	value: string;
	onChange: (value: string) => void;
	/** Accessible name of the editing surface. */
	ariaLabel: string;
	/** Id of the element describing the field (hint or error). */
	describedBy?: string;
	invalid?: boolean;
	className?: string;
}

export function MarkdownEditor({ value, onChange, ariaLabel, describedBy, invalid, className }: MarkdownEditorProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const initialRef = useRef(value);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const [ready, setReady] = useState(false);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let view: EditorView | null = null;
		let disposed = false;
		void Promise.all([
			import("@codemirror/view"),
			import("@codemirror/lang-markdown"),
			import("@codemirror/commands"),
		]).then(([{ EditorView, keymap }, { markdown }, { defaultKeymap, history, historyKeymap, indentWithTab }]) => {
			if (disposed) return;
			view = new EditorView({
				doc: initialRef.current,
				extensions: [
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
					markdown(),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({
						"aria-label": ariaLabel,
						"aria-multiline": "true",
						...(describedBy ? { "aria-describedby": describedBy } : {}),
					}),
					EditorView.theme({
						"&": {
							backgroundColor: "var(--sc-field)",
							color: "var(--sc-text)",
							fontSize: "var(--sc-font-sm)",
							height: "100%",
						},
						"&.cm-focused": { outline: "none" },
						".cm-scroller": { fontFamily: "var(--sc-font-mono)", lineHeight: "1.55" },
						".cm-content": { padding: "8px 0", caretColor: "var(--sc-accent)" },
						".cm-line": { padding: "0 12px" },
						".cm-cursor": { borderLeftColor: "var(--sc-accent)" },
						".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
							backgroundColor: "var(--sc-selection) !important",
						},
					}),
					EditorView.updateListener.of(update => {
						if (update.docChanged) onChangeRef.current(update.state.doc.toString());
					}),
				],
				parent: host,
			});
			setReady(true);
		});
		return () => {
			disposed = true;
			view?.destroy();
		};
	}, [ariaLabel, describedBy]);

	return (
		<div
			className={cx(
				"relative overflow-hidden rounded-(--sc-radius-md) border bg-(--sc-field) focus-within:border-(--sc-accent) focus-within:shadow-[0_0_0_3px_var(--sc-focus-glow)]",
				invalid ? "border-(--sc-danger)" : "border-(--sc-border)",
				className,
			)}
		>
			<div className="h-full" ref={hostRef} />
			{!ready && (
				<div className="absolute inset-0 flex items-center justify-center">
					<Spinner size="sm" />
				</div>
			)}
		</div>
	);
}
