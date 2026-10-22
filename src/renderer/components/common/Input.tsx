/**
 * Text fields: Input (single line), TextArea (multi-line, optional
 * auto-grow) and SearchField. All forward refs, so react-hook-form
 * register() works directly.
 *
 * Rules: every field has a name — a visible `label` (preferred) or
 * `aria-label`; placeholder text is an example, never the label. Inputs sit
 * on the control scale (`controlSize` sm 28 / md 32 / lg 36) so they line up
 * with Buttons and Selects in the same row. The field boundary uses
 * --sc-border (≥3:1); focus swaps it for the accent plus a soft glow and
 * suppresses the global outline, so there is exactly one focus ring.
 * `hint` explains, `error` replaces the hint and turns the border red.
 */

import { Search, X } from "lucide-react";
import {
	forwardRef,
	type InputHTMLAttributes,
	type ReactNode,
	type TextareaHTMLAttributes,
	useCallback,
	useId,
	useLayoutEffect,
	useRef,
} from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Kbd } from "./Kbd";

export type FieldSize = "sm" | "md" | "lg";

const FIELD_BASE =
	"w-full rounded-(--sc-radius-md) border bg-(--sc-field) text-(--sc-text) placeholder:text-(--sc-text-subtle) transition-[border-color,box-shadow] duration-(--sc-duration-fast) focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

const FIELD_SIZE: Record<FieldSize, string> = {
	sm: "h-(--sc-control-sm) px-2.5 text-sc-sm",
	md: "h-(--sc-control-md) px-3 text-sc-md",
	lg: "h-(--sc-control-lg) px-3 text-sc-md",
};

/** Border + focus treatment shared by every field-like control (Input, TextArea, Select). */
export function fieldStateClasses(error: boolean): string {
	return error
		? "border-(--sc-danger) focus:border-(--sc-danger) focus:shadow-[0_0_0_3px_var(--sc-danger-soft)]"
		: "border-(--sc-border) hover:border-(--sc-border-strong) focus:border-(--sc-accent) focus:shadow-[0_0_0_3px_var(--sc-focus-glow)] disabled:hover:border-(--sc-border)";
}

/**
 * Ids that tie a field's label and its hint or error to the control. The
 * label names the control alone: wrapping the control in a <label> would fold
 * the hint and any trailing button ("Show API key") into its name.
 */
export function useFieldIds(
	id: string | undefined,
	describedBy: string | undefined,
	note: boolean,
): { controlId: string; noteId: string; describedBy: string | undefined } {
	const autoId = useId();
	const controlId = id ?? autoId;
	const noteId = `${controlId}-note`;
	return { controlId, noteId, describedBy: cx(describedBy, note && noteId) || undefined };
}

/** Label above, hint or error below. Used by every field primitive. */
export function FieldShell({
	label,
	error,
	hint,
	controlId,
	noteId,
	className,
	children,
}: {
	label?: ReactNode;
	error?: string;
	hint?: ReactNode;
	/** The control's id (`useFieldIds`): the label points at it. */
	controlId: string;
	/** The hint or error's id, which the control lists in aria-describedby. */
	noteId: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={className}>
			{label && (
				<label className="mb-1.5 block text-sc-sm font-medium text-(--sc-text-secondary)" htmlFor={controlId}>
					{label}
				</label>
			)}
			{children}
			{error ? (
				<span className="mt-1.5 block text-sc-sm text-(--sc-danger)" id={noteId}>
					{error}
				</span>
			) : hint ? (
				<span className="mt-1.5 block text-sc-sm text-(--sc-text-muted)" id={noteId}>
					{hint}
				</span>
			) : null}
		</div>
	);
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	label?: ReactNode;
	error?: string;
	hint?: ReactNode;
	/** Monospace (code, ids, paths). */
	mono?: boolean;
	controlSize?: FieldSize;
	/** Icon inside the field, before the text. */
	leadingIcon?: ReactNode;
	/** Content inside the field, after the text (a unit, a Kbd, an IconButton). */
	trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
	{ label, error, hint, mono, controlSize = "md", leadingIcon, trailing, className, id, ...rest },
	ref,
) {
	const ids = useFieldIds(id, rest["aria-describedby"], Boolean(error || hint));
	const input = (
		<input
			aria-invalid={error ? true : undefined}
			className={cx(
				FIELD_BASE,
				FIELD_SIZE[controlSize],
				fieldStateClasses(Boolean(error)),
				mono && "font-mono",
				leadingIcon ? "pl-8" : undefined,
				trailing ? "pr-9" : undefined,
				className,
			)}
			ref={ref}
			{...rest}
			aria-describedby={ids.describedBy}
			id={ids.controlId}
		/>
	);
	return (
		<FieldShell controlId={ids.controlId} error={error} hint={hint} label={label} noteId={ids.noteId}>
			{leadingIcon || trailing ? (
				<span className="relative block">
					{leadingIcon && (
						<span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-(--sc-text-subtle) [&>svg]:size-(--sc-icon-sm)">
							{leadingIcon}
						</span>
					)}
					{input}
					{trailing && <span className="absolute inset-y-0 right-1 flex items-center">{trailing}</span>}
				</span>
			) : (
				input
			)}
		</FieldShell>
	);
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	label?: ReactNode;
	error?: string;
	hint?: ReactNode;
	mono?: boolean;
	/** Grow height with content instead of scrolling. */
	autoGrow?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
	{ label, error, hint, mono, autoGrow, className, rows = 3, onInput, id, ...rest },
	ref,
) {
	const innerRef = useRef<HTMLTextAreaElement | null>(null);
	const ids = useFieldIds(id, rest["aria-describedby"], Boolean(error || hint));

	const resize = useCallback(() => {
		const el = innerRef.current;
		if (!el || !autoGrow) return;
		el.style.height = "0px";
		// scrollHeight leaves the border out and the box is border-box: without it the field scrolls by its border.
		el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
	}, [autoGrow]);

	useLayoutEffect(resize, [resize]);

	return (
		<FieldShell controlId={ids.controlId} error={error} hint={hint} label={label} noteId={ids.noteId}>
			<textarea
				aria-invalid={error ? true : undefined}
				className={cx(
					FIELD_BASE,
					"resize-none px-3 py-2 text-sc-md leading-(--sc-leading-normal)",
					fieldStateClasses(Boolean(error)),
					mono && "font-mono",
					className,
				)}
				onInput={event => {
					resize();
					onInput?.(event);
				}}
				ref={node => {
					innerRef.current = node;
					if (typeof ref === "function") ref(node);
					else if (ref) ref.current = node;
				}}
				rows={rows}
				{...rest}
				aria-describedby={ids.describedBy}
				id={ids.controlId}
			/>
		</FieldShell>
	);
});

export interface SearchFieldProps
	extends Omit<InputProps, "type" | "leadingIcon" | "trailing" | "label" | "value" | "onChange"> {
	/** Accessible name (visually hidden — the search icon and placeholder carry the meaning). */
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	/** macOS-spelled shortcut hint shown while the field is empty. */
	shortcut?: string;
	/**
	 * The listbox this field drives (a picker): the field becomes its combobox, naming the list and the highlighted
	 * row (`aria-activedescendant`), so the rows need no tab stops and the list is no scroll region keyboards miss.
	 */
	listbox?: { id: string; activeId?: string };
}

/**
 * Search box for filtering a list or picker. Escape clears a non-empty
 * query first (and keeps the keystroke); an empty field lets Escape through
 * to close the surrounding picker.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
	{ label, value, onValueChange, shortcut, onKeyDown, listbox, ...rest },
	ref,
) {
	const t = useT();
	return (
		<Input
			{...rest}
			{...(listbox
				? {
						role: "combobox",
						"aria-autocomplete": "list" as const,
						"aria-controls": listbox.id,
						"aria-expanded": true,
						"aria-activedescendant": listbox.activeId,
					}
				: {})}
			aria-label={label}
			className="[&::-webkit-search-cancel-button]:appearance-none"
			leadingIcon={<Search />}
			onChange={event => onValueChange(event.target.value)}
			onKeyDown={event => {
				onKeyDown?.(event);
				if (event.key === "Escape" && value !== "" && !event.defaultPrevented) {
					event.preventDefault();
					event.stopPropagation();
					onValueChange("");
				}
			}}
			ref={ref}
			trailing={
				value !== "" ? (
					<button
						aria-label={t("common.clear")}
						className="inline-flex size-(--sc-hit-min) items-center justify-center rounded-(--sc-radius-sm) text-(--sc-text-subtle) hover:bg-(--sc-hover) hover:text-(--sc-text)"
						onClick={() => onValueChange("")}
						tabIndex={-1}
						type="button"
					>
						<X size={14} />
					</button>
				) : shortcut ? (
					<Kbd className="pr-1.5" shortcut={shortcut} />
				) : undefined
			}
			type="search"
			value={value}
		/>
	);
});
