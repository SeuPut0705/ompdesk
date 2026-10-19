/**
 * Switch — an on/off setting that applies immediately. The single switch
 * implementation; never hand-roll a role="switch" track.
 *
 * - `Switch`: the bare control. Give it a name: `label` (aria-label) when no
 *   visible text names it, or wrap it in SwitchField.
 * - `SwitchField`: one dense row — label, a short description inline or a longer
 *   one behind an (i) tooltip (`SettingInfo`), and the switch at the right, the
 *   whole row clickable. Use it for every boolean setting row.
 * - `SwitchTile`: the same switch as a half-width tile (glyph, short label, (i), switch) for a two-column grid.
 * Off = outlined track (≥3:1 border) with a muted knob; on = accent track
 * with an accent-foreground knob — the state never depends on color alone.
 * Use a checkbox instead when the choice is only applied on submit.
 */

import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../../lib/format";
import { SettingInfo, splitDescription } from "./SettingInfo";

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
	/** Keep even a short string description behind the (i) glyph (a narrow popover has no room for it inline). */
	infoOnly?: boolean;
}

export function SwitchField({
	label,
	description,
	badge,
	infoOnly,
	id,
	className,
	disabled,
	...rest
}: SwitchFieldProps) {
	const autoId = useId();
	const switchId = id ?? autoId;
	const { inline, tip, note } = splitDescription(description, infoOnly);
	const descriptionId = inline !== undefined || note ? `${switchId}-description` : undefined;
	// One dense line: label, a short clause or the (i) glyph, the switch at the right. The glyph sits outside the label
	// so the switch's accessible name stays the label text; its own tooltip text is read from the DOM as `sr-only`.
	return (
		<div
			className={cx(
				"flex min-h-(--sc-control-md) items-center gap-2 rounded-(--sc-radius-md) px-2 py-1 hover:bg-(--sc-hover)",
				disabled && "opacity-60 hover:bg-transparent",
				className,
			)}
			data-switch-field
		>
			<label className={cx("min-w-0 shrink", disabled ? "cursor-not-allowed" : "cursor-pointer")} htmlFor={switchId}>
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<span className="text-sc-md font-medium text-(--sc-text)">{label}</span>
					{badge}
					{inline !== undefined && (
						<span
							className="min-w-0 truncate text-sc-xs break-keep text-(--sc-text-muted)"
							data-setting-desc
							id={descriptionId}
							title={inline}
						>
							{inline}
						</span>
					)}
				</span>
				{note && (
					<span className="block text-sc-xs break-words break-keep text-(--sc-text-muted)" id={descriptionId}>
						{note}
					</span>
				)}
			</label>
			{tip !== undefined && <SettingInfo text={tip} />}
			{/* The empty stretch between label and switch is part of the click target, as the whole row was. */}
			<label
				aria-hidden
				className={cx(
					"min-h-(--sc-control-md) flex-1 self-stretch",
					disabled ? "cursor-not-allowed" : "cursor-pointer",
				)}
				htmlFor={switchId}
			/>
			<Switch aria-describedby={descriptionId} disabled={disabled} id={switchId} {...rest} />
		</div>
	);
}

export interface SwitchTileProps extends Omit<SwitchProps, "label" | "aria-labelledby" | "aria-describedby"> {
	/** A decorative lucide glyph (16 px) before the label. */
	icon: ReactNode;
	/** The short name, one line: it truncates before it wraps. */
	label: string;
	/** The explanation: always behind the (i) glyph (the tile has no room for a clause, so no length rule applies). */
	description?: string;
}

/**
 * A switch as a tile: glyph, short label, (i), switch on ONE line, built to sit two to a row in a grid (`data-switch-grid`
 * in the Run sheet) where a `SwitchField` row would waste the row's width. Same behaviour as `SwitchField`: the whole
 * tile toggles, the glyph sits outside the label so the switch is named by the label alone.
 */
export function SwitchTile({ icon, label, description, id, className, disabled, ...rest }: SwitchTileProps) {
	const autoId = useId();
	const switchId = id ?? autoId;
	return (
		<div
			className={cx(
				"flex min-h-(--sc-control-md) min-w-0 items-center gap-1 rounded-(--sc-radius-md) px-1.5 py-1 hover:bg-(--sc-hover)",
				disabled && "opacity-60 hover:bg-transparent",
				className,
			)}
			data-switch-tile
		>
			<label
				className={cx(
					"flex min-w-0 flex-1 items-center gap-1.5 self-stretch",
					disabled ? "cursor-not-allowed" : "cursor-pointer",
				)}
				htmlFor={switchId}
			>
				<span
					aria-hidden
					className="flex size-(--sc-icon-md) shrink-0 items-center justify-center text-(--sc-text-muted) [&>svg]:size-(--sc-icon-md)"
					data-setting-icon
				>
					{icon}
				</span>
				<span className="min-w-0 truncate text-sc-sm font-medium text-(--sc-text)" title={label}>
					{label}
				</span>
			</label>
			{description !== undefined && <SettingInfo text={description} />}
			<Switch disabled={disabled} id={switchId} size="sm" {...rest} />
		</div>
	);
}
