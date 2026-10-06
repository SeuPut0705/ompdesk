/**
 * Select — pick one value from a short, fixed list inside a form or settings
 * row. A styled native <select>: the OS popup is accessible and keyboard
 * complete on macOS and Windows for free.
 *
 * Use Select for ≤ ~15 static options that need no icons or descriptions.
 * Long, searchable or rich lists (models, sessions, themes) are pickers
 * (Dialog, placement "top"); action lists are menus (MenuButton). Same
 * control scale and border treatment as Input, so mixed rows line up.
 */

import { ChevronDown } from "lucide-react";
import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";
import { cx } from "../../lib/format";
import { FieldShell, type FieldSize, fieldStateClasses } from "./Input";

const SIZE: Record<FieldSize, string> = {
	sm: "h-(--sc-control-sm) pl-2.5 pr-8 text-sc-sm",
	md: "h-(--sc-control-md) pl-3 pr-8 text-sc-md",
	lg: "h-(--sc-control-lg) pl-3 pr-9 text-sc-md",
};

export interface SelectOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
	label?: ReactNode;
	hint?: ReactNode;
	error?: string;
	controlSize?: FieldSize;
	/** Options as data; or pass <option> children. */
	options?: readonly SelectOption[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
	{ label, hint, error, controlSize = "md", options, className, children, ...rest },
	ref,
) {
	return (
		<FieldShell error={error} hint={hint} label={label}>
			<span className="relative block">
				<select
					aria-invalid={error ? true : undefined}
					className={cx(
						"w-full cursor-pointer appearance-none rounded-(--sc-radius-md) border bg-(--sc-field) text-(--sc-text) transition-[border-color,box-shadow] duration-(--sc-duration-fast) focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
						SIZE[controlSize],
						fieldStateClasses(Boolean(error)),
						className,
					)}
					ref={ref}
					{...rest}
				>
					{options?.map(option => (
						<option disabled={option.disabled} key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
					{children}
				</select>
				<ChevronDown
					aria-hidden
					className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-(--sc-text-muted)"
					size={14}
				/>
			</span>
		</FieldShell>
	);
});
