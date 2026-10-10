/**
 * Settings page layout primitives — the one way to lay out a Settings
 * section so every page lines up (page `h1` "Settings", section `h2`):
 *
 * - `SettingsSection`: an `h3` heading (+ optional one-line description and
 *   trailing actions) over a hairline-divided list of rows or free content.
 * - `SettingsRow`: label + description on the left, the control in one fixed
 *   right column (`.settings-field-row`; stacks under the label in narrow
 *   containers). Pass `htmlFor` = the control's id so clicking the label
 *   focuses/toggles it. Free-form content (lists, editors) goes in
 *   `children` below the label instead of `control`.
 * - `SettingsSwitchRow`: a boolean row — `SettingsRow` + `Switch`, the whole
 *   label clickable.
 *
 * Rows use `id` (e.g. `setting-<path>`) as the search-navigation target.
 */

import { createContext, type ReactNode, useContext, useId } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Switch } from "../common";

type SettingsScope = "app" | "host" | "mixed";
const SettingsScopeContext = createContext<SettingsScope | null>(null);
export const SettingsScopeProvider = SettingsScopeContext.Provider;
const SettingsGroupContext = createContext(false);

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
	return (
		<section
			aria-labelledby={title && !nested ? headingId : undefined}
			className={cx("settings-section scroll-mt-4", nested && "settings-section-nested", className)}
			id={id}
		>
			{((title && !nested) || description || actions) && (
				<div className="mb-2 flex flex-wrap items-end gap-x-3 gap-y-2">
					{/* Wide actions wrap under the text instead of squeezing it into a column. */}
					<div className="min-w-[min(100%,12rem)] flex-1">
						{title && !nested && (
							<h3 className="text-sc-lg font-semibold text-(--sc-text)" id={headingId}>
								{title}
							</h3>
						)}
						{ownScope && ownScope !== inheritedScope && !nested && (
							<p className="mt-0.5 text-sc-xs text-(--sc-text-muted)" data-settings-group-scope={scope}>
								{t(`settings.navGroup.${scope === "host" ? "agent" : scope === "mixed" ? "system" : "app"}`)}
							</p>
						)}
						{description && <p className="mt-0.5 text-sc-sm break-keep text-(--sc-text-muted)">{description}</p>}
					</div>
					{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
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

export interface SettingsRowProps {
	id?: string;
	label: ReactNode;
	description?: ReactNode;
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
	/** Boolean rows keep the control compact and right-aligned. */
	compactControl?: boolean;
	className?: string;
}

export function SettingsRow({
	id,
	label,
	description,
	badge,
	htmlFor,
	control,
	children,
	footer,
	compactControl,
	className,
}: SettingsRowProps) {
	const descriptionId = useId();
	const LabelTag = htmlFor ? "label" : "span";
	return (
		<div className={cx("settings-row scroll-mt-4 py-3", className)} data-setting-row="true" id={id}>
			<div className={cx("settings-field-row", compactControl && "settings-field-row-compact")}>
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<LabelTag className="text-sc-md font-medium text-(--sc-text)" htmlFor={htmlFor}>
							{label}
						</LabelTag>
						{badge}
					</div>
					{description && (
						<p className="mt-0.5 text-sc-sm break-keep text-(--sc-text-muted)" id={descriptionId}>
							{description}
						</p>
					)}
				</div>
				{control !== undefined && <div className="settings-field-control">{control}</div>}
			</div>
			{children !== undefined && <div className="mt-2 min-w-0">{children}</div>}
			{footer}
		</div>
	);
}

export interface SettingsSwitchRowProps {
	id?: string;
	label: ReactNode;
	description?: ReactNode;
	badge?: ReactNode;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
	footer?: ReactNode;
	/** Extra right-column content before the switch (a "reset" ghost button). */
	extra?: ReactNode;
}

export function SettingsSwitchRow({
	id,
	label,
	description,
	badge,
	checked,
	onCheckedChange,
	disabled,
	footer,
	extra,
}: SettingsSwitchRowProps) {
	const switchId = useId();
	return (
		<SettingsRow
			badge={badge}
			compactControl
			control={
				<span className="flex items-center justify-end gap-2">
					{extra}
					<Switch checked={checked} disabled={disabled} id={switchId} onCheckedChange={onCheckedChange} />
				</span>
			}
			description={description}
			footer={footer}
			htmlFor={switchId}
			id={id}
			label={label}
		/>
	);
}
