/**
 * A CodeMirror text field: long-form prompts (the agent editor's
 * instructions, Markdown) and the Files viewer's Edit (any text file, with line
 * numbers and ⌘S/Ctrl+S). CodeMirror is imported when the first editor mounts,
 * not at app startup. Uncontrolled after mount: `value` seeds the document and
 * `onChange` reports edits; remount (change `key`) to load another document.
 */

import type { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { Spinner } from "./Spinner";

export type TextEditorLanguage = "markdown" | "json" | "text";

export interface TextEditorProps {
	value: string;
	onChange: (value: string) => void;
	/** Accessible name of the editing surface. */
	ariaLabel: string;
	language: TextEditorLanguage;
	/** Id of the element describing the field (hint or error). */
	describedBy?: string;
	invalid?: boolean;
	/** A gutter with line numbers, and no soft wrap (source files). */
	lineNumbers?: boolean;
	/** ⌘S / Ctrl+S inside the editor. */
	onSave?: () => void;
	/** Focus the text once CodeMirror has loaded. */
	autoFocus?: boolean;
	className?: string;
}

export function TextEditor({
	value,
	onChange,
	ariaLabel,
	language,
	describedBy,
	invalid,
	lineNumbers,
	onSave,
	autoFocus,
	className,
}: TextEditorProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const initialRef = useRef(value);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const [ready, setReady] = useState(false);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let view: EditorView | null = null;
		let disposed = false;
		void Promise.all([
			import("@codemirror/view"),
			import("@codemirror/commands"),
			language === "markdown" ? import("@codemirror/lang-markdown").then(module => module.markdown()) : null,
			language === "json" ? import("@codemirror/lang-json").then(module => module.json()) : null,
		]).then(([views, commands, markdown, json]) => {
			if (disposed) return;
			const { EditorView, keymap } = views;
			const { defaultKeymap, history, historyKeymap, indentWithTab } = commands;
			view = new EditorView({
				doc: initialRef.current,
				extensions: [
					history(),
					keymap.of([
						{
							key: "Mod-s",
							preventDefault: true,
							run: () => {
								onSaveRef.current?.();
								return onSaveRef.current !== undefined;
							},
						},
						...defaultKeymap,
						...historyKeymap,
						indentWithTab,
					]),
					...(markdown ? [markdown] : []),
					...(json ? [json] : []),
					...(lineNumbers ? [views.lineNumbers(), views.highlightActiveLineGutter()] : [EditorView.lineWrapping]),
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
						".cm-gutters": {
							backgroundColor: "var(--sc-field)",
							color: "var(--sc-text-subtle)",
							borderRight: "1px solid var(--sc-divider)",
						},
						".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--sc-text)" },
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
			if (autoFocus) view.focus();
			setReady(true);
		});
		return () => {
			disposed = true;
			view?.destroy();
		};
	}, [ariaLabel, describedBy, language, lineNumbers, autoFocus]);

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
