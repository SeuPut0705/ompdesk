/**
 * Settings page layout primitives — the one way to lay out a Settings
 * section so every page lines up (page `h1` "Settings", section `h2`):
 *
 * - `SettingsSection`: an `h3` heading (+ optional one-line description and
 *   trailing actions) over a hairline-divided list of rows or free content.
 * - `SettingsRow`: one dense line — optional `icon`, label, a short muted
 *   description (≤ `INLINE_DESCRIPTION_MAX` characters, inline) and the
 *   control in one fixed right column (`.settings-field-row`; stacks under
 *   the label in narrow containers). A longer string description moves into
 *   an info tooltip (and stays in the DOM as screen-reader text); a
 *   non-string description stays visible as a small muted note, so warnings
 *   and costs are never hidden. Pass `htmlFor` = the control's id so clicking
 *   the label focuses/toggles it. Free-form content (lists, editors) goes in
 *   `children` below the label instead of `control`.
 * - `SettingsSwitchRow`: a boolean row — `SettingsRow` + `Switch`, the whole
 *   label clickable. With `risk`, flipping to the risky value only asks: an
 *   inline warning holds the switch until the user accepts the risk.
 * - `SettingsAdvanced`: rarely changed settings folded under one "Advanced"
 *   summary at the end of a section, closed by default. Search and deep links
 *   still land on its rows: SettingsPage opens it before scrolling there.
 *
 * Rows use `id` (e.g. `setting-<path>`) as the search-navigation target.
 */

import { ChevronRight } from "lucide-react";
import { createContext, type ReactNode, useContext, useId, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useFocusedHost } from "../../stores/remote";
import { Banner, Button, SettingInfo, Switch, splitDescription } from "../common";

type SettingsScope = "app" | "host" | "mixed";
const SettingsScopeContext = createContext<SettingsScope | null>(null);
export const SettingsScopeProvider = SettingsScopeContext.Provider;
const SettingsGroupContext = createContext(false);
/** Inside it, every string description of a row or titled group sits behind the info glyph: rows read icon + label + control. */
const SettingsTipOnlyContext = createContext(false);
export const SettingsTipOnly = SettingsTipOnlyContext.Provider;

/** Several compact rows side by side: two per line, one in a narrow column, divided like rows (global.css). */
export function SettingsTiles({ children }: { children: ReactNode }) {
	return <div data-settings-tiles>{children}</div>;
}

export interface SettingsSectionProps {
	id?: string;
	/** Omit when the page header already names this content (the section's only group). */
	title?: ReactNode;
	description?: ReactNode;
	/** Trailing header controls (a Button sm, a refresh IconButton). */
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	scope?: SettingsScope;
}

export function SettingsSection({
	id,
	title,
	description,
	actions,
	children,
	className,
	scope: ownScope,
}: SettingsSectionProps) {
	const headingId = useId();
	const inheritedScope = useContext(SettingsScopeContext);
	const nested = useContext(SettingsGroupContext);
	const scope = ownScope ?? inheritedScope;
	const t = useT();
	// Whose settings a group holds only matters while the focused tab runs on a paired host.
	const host = useFocusedHost();
	// A nested group's title stays implicit over bare rows, but names the
	// description and actions it carries: they never float unlabeled.
	const showTitle = Boolean(title) && (!nested || Boolean(description || actions));
	const tipOnly = useContext(SettingsTipOnlyContext);
	const { inline, tip, note } = splitDescription(description, tipOnly && showTitle);
	// A long description of a titled group moves behind an info glyph; an untitled one stays a line
	// (none at all in a tip-only section: a string intro there is filler).
	const tipped = showTitle && tip !== undefined;
	const line = tipped || (tipOnly && note === undefined) ? undefined : (inline ?? tip);
	return (
		<section
			aria-labelledby={showTitle ? headingId : undefined}
			className={cx("settings-section scroll-mt-4", nested && "settings-section-nested", className)}
			data-settings-actions={actions ? "" : undefined}
			id={id}
		>
			{(showTitle || description || actions) && (
				<div className="mb-1 flex flex-wrap items-end gap-x-3 gap-y-1" data-settings-section-head>
					{/* Wide actions wrap under the text instead of squeezing it into a column. */}
					<div className="min-w-[min(100%,12rem)] flex-1">
						{showTitle && (
							<div className="flex items-center gap-1.5">
								{nested ? (
									<h4 className="text-sc-sm font-medium text-(--sc-text-secondary)" id={headingId}>
										{title}
									</h4>
								) : (
									<h3 className="text-sc-md font-semibold text-(--sc-text)" id={headingId}>
										{title}
									</h3>
								)}
								{tipped && tip !== undefined && <SettingInfo text={tip} />}
							</div>
						)}
						{host && ownScope && ownScope !== inheritedScope && !nested && (
							<p className="mt-0.5 text-sc-xs text-(--sc-text-muted)" data-settings-group-scope={scope}>
								{t(`settings.navGroup.${scope === "host" ? "agent" : scope === "mixed" ? "system" : "app"}`)}
							</p>
						)}
						{/* keep-all keeps Korean words whole; break-words still wraps a long path inside the column. */}
						{(line !== undefined || note) && (
							<p className="mt-0.5 text-sc-xs break-words break-keep text-(--sc-text-muted)">{line ?? note}</p>
						)}
					</div>
					{/* Two buttons wider than a narrow column wrap onto their own lines. */}
					{actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
				</div>
			)}
			<div className="settings-section-body">
				<SettingsScopeProvider value={scope}>
					<SettingsGroupContext.Provider value={true}>{children}</SettingsGroupContext.Provider>
				</SettingsScopeProvider>
			</div>
		</section>
	);
}

/**
 * Rarely changed settings, folded at the end of a section (see the file comment). `label` names a fold that sits
 * beside another "Advanced" (the Run popover's Autopilot options above its own Advanced).
 */
export function SettingsAdvanced({ children, label }: { children: ReactNode; label?: string }) {
	const t = useT();
	return (
		<details className="settings-advanced group/advanced" data-settings-advanced="true">
			<summary className="flex min-h-(--sc-control-sm) w-fit max-w-full cursor-pointer list-none items-center gap-1.5 rounded-(--sc-radius-sm) text-sc-sm font-medium text-(--sc-text-secondary) select-none hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) [&::-webkit-details-marker]:hidden">
				<ChevronRight
					aria-hidden
					className="size-(--sc-icon-sm) shrink-0 transition-transform duration-(--sc-duration-fast) group-open/advanced:rotate-90 motion-reduce:transition-none"
				/>
				{label ?? t("settings.advancedGroup")}
			</summary>
			<div className="settings-advanced-body">{children}</div>
		</details>
	);
}

export interface SettingsRowProps {
	id?: string;
	label: ReactNode;
	/** One short line (inline), a longer string (info tooltip) or a node (a visible muted note). */
	description?: ReactNode;
	/** A lucide glyph (or a `ProviderMark`) that identifies the row at the left. Decorative. */
	icon?: ReactNode;
	/** Badge next to the label (restart required, changed). */
	badge?: ReactNode;
	/** id of the control the label names. */
	htmlFor?: string;
	/** Right-column control (Select, Input, Switch, Button). */
	control?: ReactNode;
	/** Full-width content under the label (lists, structured editors). */
	children?: ReactNode;
	/** Extra content under the row (errors, source details). */
	footer?: ReactNode;
	/** Boolean rows and one-button rows keep the control compact and right-aligned (never stacked on a phone). */
	compactControl?: boolean;
	/** Every string description goes behind the info glyph, however short (a row that must stay one line). */
	tipOnly?: boolean;
	className?: string;
}

export function SettingsRow({
	id,
	label,
	description,
	icon,
	badge,
	htmlFor,
	control,
	children,
	footer,
	compactControl,
	tipOnly,
	className,
}: SettingsRowProps) {
	const descriptionId = useId();
	const LabelTag = htmlFor ? "label" : "span";
	const tipOnlyContext = useContext(SettingsTipOnlyContext);
	const { inline, tip, note } = splitDescription(description, tipOnly ?? tipOnlyContext);
	return (
		<div className={cx("settings-row scroll-mt-4 py-1", className)} data-setting-row="true" id={id}>
			<div
				className={cx(
					"settings-field-row",
					// A row without a control gives its whole width to the label and its content.
					(compactControl || control === undefined) && "settings-field-row-compact",
				)}
			>
				<div className="flex min-h-(--sc-control-md) min-w-0 items-center gap-2">
					{icon && (
						<span
							aria-hidden
							className="flex size-(--sc-icon-lg) shrink-0 items-center justify-center text-(--sc-text-muted) [&>svg]:size-(--sc-icon-md)"
							data-setting-icon
						>
							{icon}
						</span>
					)}
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
							<LabelTag className="text-sc-md font-medium text-(--sc-text)" htmlFor={htmlFor}>
								{label}
							</LabelTag>
							{badge}
							{tip !== undefined && <SettingInfo text={tip} />}
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
						</div>
						{note && (
							<p className="text-sc-xs break-words break-keep text-(--sc-text-muted)" id={descriptionId}>
								{note}
							</p>
						)}
					</div>
				</div>
				{control !== undefined && <div className="settings-field-control">{control}</div>}
			</div>
			{children !== undefined && <div className="mt-1 min-w-0">{children}</div>}
			{footer}
		</div>
	);
}

export interface SettingsSwitchRowProps {
	id?: string;
	label: ReactNode;
	description?: ReactNode;
	icon?: ReactNode;
	badge?: ReactNode;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
	footer?: ReactNode;
	/** Extra right-column content before the switch (a "reset" ghost button). */
	extra?: ReactNode;
	/** The value that needs an explicit "Accept risk" before it is written, and why. */
	risk?: { value: boolean; warning: ReactNode };
	/** Every string description goes behind the info glyph (see `SettingsRow`). */
	tipOnly?: boolean;
}

export function SettingsSwitchRow({
	id,
	label,
	description,
	icon,
	badge,
	checked,
	onCheckedChange,
	disabled,
	footer,
	extra,
	risk,
	tipOnly,
}: SettingsSwitchRowProps) {
	const t = useT();
	const switchId = useId();
	const [asking, setAsking] = useState(false);
	const change = (next: boolean) => {
		if (risk && next === risk.value) setAsking(true);
		else onCheckedChange(next);
	};
	return (
		<SettingsRow
			badge={badge}
			compactControl
			control={
				<span className="flex items-center justify-end gap-2">
					{extra}
					<Switch checked={checked} disabled={disabled || asking} id={switchId} onCheckedChange={change} />
				</span>
			}
			description={description}
			tipOnly={tipOnly}
			footer={
				<>
					{asking && risk && (
						<Banner
							actions={
								<>
									<Button
										data-risk-accept
										onClick={() => {
											setAsking(false);
											onCheckedChange(risk.value);
										}}
										size="sm"
										variant="danger"
									>
										{t("settings.risk.accept")}
									</Button>
									<Button autoFocus onClick={() => setAsking(false)} size="sm" variant="ghost">
										{t("common.cancel")}
									</Button>
								</>
							}
							className="mt-2"
							live
							title={t("settings.risk.title")}
							variant="warning"
						>
							{risk.warning}
						</Banner>
					)}
					{footer}
				</>
			}
			htmlFor={switchId}
			id={id}
			icon={icon}
			label={label}
		/>
	);
}
