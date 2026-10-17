/**
 * Switch — an on/off setting that applies immediately. The single switch
 * implementation; never hand-roll a role="switch" track.
 *
 * - `Switch`: the bare control. Give it a name: `label` (aria-label) when no
 *   visible text names it, or wrap it in SwitchField.
 * - `SwitchField`: label + optional description + switch on the right, the
 *   whole row clickable. Use it for every boolean setting row.
 * Off = outlined track (≥3:1 border) with a muted knob; on = accent track
 * with an accent-foreground knob — the state never depends on color alone.
 * Use a checkbox instead when the choice is only applied on submit.
 */

import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../../lib/format";

export type SwitchSize = "sm" | "md";

const TRACK: Record<SwitchSize, string> = {
	sm: "h-4 w-7",
	md: "h-[18px] w-8",
};

const KNOB: Record<SwitchSize, { off: string; on: string }> = {
	sm: { off: "size-2 translate-x-[3px]", on: "size-3 translate-x-[12px]" },
	md: { off: "size-2.5 translate-x-[3px]", on: "size-3.5 translate-x-[14px]" },
};

export interface SwitchProps
	extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "aria-checked" | "children"> {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	size?: SwitchSize;
	/** Accessible name when no visible label is associated. */
	label?: string;
}

export function Switch({
	checked,
	onCheckedChange,
	size = "md",
	label,
	className,
	disabled,
	onClick,
	...rest
}: SwitchProps) {
	return (
		<button
			aria-checked={checked}
			aria-label={label}
			className={cx(
				"group/switch inline-flex h-(--sc-hit-min) shrink-0 items-center rounded-(--sc-radius-full) disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			disabled={disabled}
			onClick={event => {
				onClick?.(event);
				if (!event.defaultPrevented) onCheckedChange(!checked);
			}}
			role="switch"
			type="button"
			{...rest}
		>
			<span
				aria-hidden
				className={cx(
					"relative inline-flex items-center rounded-(--sc-radius-full) border transition-[background-color,border-color] duration-(--sc-duration-fast)",
					TRACK[size],
					checked
						? "border-transparent bg-(--sc-accent) group-hover/switch:bg-(--sc-accent-hover)"
						: "border-(--sc-border) bg-(--sc-field) group-hover/switch:border-(--sc-border-strong)",
				)}
			>
				<span
					className={cx(
						"rounded-(--sc-radius-full) transition-[transform,width,height,background-color] duration-(--sc-duration-fast) ease-(--sc-ease-standard)",
						checked ? `bg-(--sc-accent-fg) ${KNOB[size].on}` : `bg-(--sc-text-muted) ${KNOB[size].off}`,
					)}
				/>
			</span>
		</button>
	);
}

export interface SwitchFieldProps extends Omit<SwitchProps, "label" | "aria-labelledby" | "aria-describedby"> {
	label: ReactNode;
	description?: ReactNode;
	/** Trailing adornment next to the label (a Badge, usually). */
	badge?: ReactNode;
}

export function SwitchField({ label, description, badge, id, className, disabled, ...rest }: SwitchFieldProps) {
	const autoId = useId();
	const switchId = id ?? autoId;
	const descriptionId = description ? `${switchId}-description` : undefined;
	return (
		<label
			className={cx(
				"flex min-h-10 w-full cursor-pointer items-center justify-between gap-4 rounded-(--sc-radius-md) px-2 py-1.5 hover:bg-(--sc-hover)",
				disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
				className,
			)}
			htmlFor={switchId}
		>
			<span className="min-w-0">
				<span className="flex items-center gap-2 text-sc-md font-medium text-(--sc-text)">
					{label}
					{badge}
				</span>
				{description && (
					<span className="mt-0.5 block text-sc-sm text-(--sc-text-muted)" id={descriptionId}>
						{description}
					</span>
				)}
			</span>
			<Switch aria-describedby={descriptionId} disabled={disabled} id={switchId} {...rest} />
		</label>
	);
}
