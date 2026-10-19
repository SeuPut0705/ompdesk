import { useMemo } from "react";
import { AUTOPILOT_AREAS, type AutopilotArea } from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { SettingInfo } from "../../common";
import { AreaIcon } from "./AreaIcon";
import { areaMix } from "./autopilot-view";
import { useAutopilotActions } from "./use-autopilot-actions";

/** Focus areas as toggles: an empty set means every area. Shared by the start sheet and the screen. */
export function FocusChips({
	focus,
	onToggle,
	disabled,
	compact,
}: {
	focus: readonly AutopilotArea[];
	onToggle: (area: AutopilotArea) => void;
	disabled?: boolean;
	/** Tighter chips for the Mode popover, where the seven areas wrap within two rows. */
	compact?: boolean;
}) {
	const t = useT();
	return (
		<div
			className={cx("flex flex-wrap", compact ? "gap-1" : "gap-1.5")}
			data-autopilot-focus
			role="group"
			aria-label={t("autopilot.focus.label")}
		>
			{AUTOPILOT_AREAS.map(area => {
				const on = focus.includes(area);
				return (
					<button
						aria-pressed={on}
						className={cx(
							"inline-flex h-6 items-center rounded-full border text-sc-xs transition-colors disabled:opacity-50",
							compact ? "gap-1 px-1.5" : "gap-1 px-2",
							on
								? "border-(--sc-accent) bg-(--sc-accent-soft) text-(--sc-accent)"
								: "border-(--sc-border) text-(--sc-text-secondary) hover:bg-(--sc-surface-2)",
						)}
						data-focus-area={area}
						disabled={disabled}
						key={area}
						onClick={() => onToggle(area)}
						type="button"
					>
						<AreaIcon area={area} />
						{t(`autopilot.area.${area}`)}
					</button>
				);
			})}
		</div>
	);
}

/** How the finished cycles split across the areas, and the focus the next cycles follow (changeable while running). */
export function AreaMix() {
	const t = useT();
	const cycles = useAutopilotStore(s => s.status.cycles);
	const focus = useAutopilotStore(s => s.status.settings?.focus);
	const state = useAutopilotStore(s => s.status.state);
	const { run, pending } = useAutopilotActions();
	const mix = useMemo(() => areaMix(cycles ?? []), [cycles]);
	const current = focus ?? [];
	return (
		<section className="flex flex-col gap-2 border-t border-(--sc-divider) px-3 py-3" data-autopilot-mix>
			<h3 className="text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">{t("autopilot.mix")}</h3>
			{mix.total > 0 && (
				<ul className="flex flex-col gap-1">
					{mix.rows.map(row => (
						<li className="flex items-center gap-2 text-sc-xs" data-mix-area={row.area} key={row.area}>
							<AreaIcon area={row.area} />
							<span className="w-24 shrink-0 truncate text-(--sc-text-secondary)">
								{t(`autopilot.area.${row.area}`)}
							</span>
							<span
								aria-hidden
								className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-(--sc-surface-3)"
							>
								<span
									className="block h-full rounded-full bg-(--sc-accent)"
									style={{ width: `${Math.round((row.count / mix.max) * 100)}%` }}
								/>
							</span>
							<span className="w-5 shrink-0 text-right tabular-nums text-(--sc-text-muted)">{row.count}</span>
						</li>
					))}
				</ul>
			)}
			<div className="flex flex-col gap-1.5">
				<span className="flex items-center gap-1 text-sc-xs text-(--sc-text-muted)">
					{t("autopilot.sheet.focus")}
					<SettingInfo text={t("autopilot.focus.next")} />
				</span>
				<FocusChips
					disabled={state === "ended" || pending === "configure"}
					focus={current}
					onToggle={area =>
						void run({
							action: "configure",
							focus: current.includes(area) ? current.filter(item => item !== area) : [...current, area],
						})
					}
				/>
			</div>
		</section>
	);
}
