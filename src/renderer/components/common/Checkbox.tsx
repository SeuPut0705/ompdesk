/**
 * Checkbox / Radio — a choice that applies on submit, or one of a set picked from a list (rows to stage, files to
 * import, pools to join). A setting that applies at once is a `Switch` instead.
 *
 * Both are the native input, drawn by the system in the accent colour, so keyboard, form, `indeterminate` and
 * screen-reader behaviour are the browser's own. Give each a name: wrap it in a `<label>` with its text (the usual
 * row: `<label className="flex items-center gap-2"><Checkbox …/>Text</label>`), or pass `aria-label`.
 * `indeterminate` shows the mixed state of a select-all box (a DOM property, not an attribute; set here).
 */

import { type InputHTMLAttributes, type Ref, useCallback } from "react";
import { cx } from "../../lib/format";

const BOX = "size-4 shrink-0 cursor-pointer accent-(--sc-accent) disabled:cursor-not-allowed";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
	/** The mixed state of a select-all box. */
	indeterminate?: boolean;
	ref?: Ref<HTMLInputElement>;
}

export function Checkbox({ indeterminate, className, ref, ...rest }: CheckboxProps) {
	const attach = useCallback(
		(element: HTMLInputElement | null) => {
			if (element) element.indeterminate = indeterminate === true;
			if (typeof ref === "function") ref(element);
			else if (ref) ref.current = element;
		},
		[indeterminate, ref],
	);
	return <input {...rest} className={cx(BOX, className)} ref={attach} type="checkbox" />;
}

export type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function Radio({ className, ...rest }: RadioProps) {
	return <input {...rest} className={cx(BOX, className)} type="radio" />;
}
