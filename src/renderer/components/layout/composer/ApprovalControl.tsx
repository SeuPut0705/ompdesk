/**
 * Tool approval field for the composer's Run settings popover. Switches the
 * approval mode at RUNTIME through the shared settings store
 * (`setApprovalMode` → `set_setting("tools.approvalMode", …)`), which the
 * agent reads fresh on every approval decision — applies immediately, no
 * sidecar restart.
 *
 * Dropping to a stricter mode is safe at any time and applies in one step.
 * Opening full access removes every remaining prompt for a session that may
 * be mid-run, so it asks first: the field hands that request to its host
 * (`onRequestFullAccess`), which closes its popover and shows
 * `FullAccessConfirmDialog` — never a dialog on top of the popover.
 */

import { Check } from "lucide-react";
import { useId } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { type ApprovalMode, useSettingsStore } from "../../../stores/settings";
import { ConfirmDialog, Select } from "../../common";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["yolo", "write", "always-ask"];

/**
 * `select` (default): the labelled Select of the Run popover. `radios`: the three modes as 44 px rows with their
 * descriptions, one tap each (the Run settings on a phone); the same requests to the host and the store either way.
 */
export function ApprovalModeField({
	onRequestFullAccess,
	variant = "select",
}: {
	onRequestFullAccess: () => void;
	variant?: "select" | "radios";
}) {
	const t = useT();
	const mode = useSettingsStore(s => s.approvalMode);
	const setApprovalMode = useSettingsStore(s => s.setApprovalMode);
	const hintId = useId();
	const pick = (next: ApprovalMode) => {
		if (next === mode) return;
		if (next === "yolo") onRequestFullAccess();
		else void setApprovalMode(next);
	};
	if (variant === "radios") {
		return (
			<section aria-label={t("input.runSettings.approval")} className="flex flex-col gap-0.5" data-approval-mode>
				<h3 className="px-3 pt-1 text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase">
					{t("input.runSettings.approval")}
				</h3>
				<div aria-label={t("input.runSettings.approval")} className="flex flex-col gap-0.5" role="radiogroup">
					{APPROVAL_MODES.map(option => (
						<button
							aria-checked={option === mode}
							className={cx(
								"flex min-h-(--sc-row-action) w-full items-center gap-2 rounded-(--sc-radius-md) px-3 py-1 text-left hover:bg-(--sc-hover)",
								option === mode && "bg-(--sc-selected)",
							)}
							data-approval-option={option}
							key={option}
							onClick={() => pick(option)}
							role="radio"
							type="button"
						>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-sc-lg text-(--sc-text)">{t(`input.approval.${option}`)}</span>
								<span className="text-sc-sm break-keep text-(--sc-text-muted)">
									{t(`input.approval.${option}.desc`)}
								</span>
							</span>
							{option === mode && (
								<Check aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-accent)" />
							)}
						</button>
					))}
				</div>
			</section>
		);
	}
	return (
		<Select
			aria-describedby={hintId}
			controlSize="sm"
			data-approval-mode
			hint={<span id={hintId}>{t(`input.approval.${mode}.desc`)}</span>}
			label={t("input.runSettings.approval")}
			onChange={event => pick(event.target.value as ApprovalMode)}
			options={APPROVAL_MODES.map(option => ({ value: option, label: t(`input.approval.${option}`) }))}
			value={mode}
		/>
	);
}

export function FullAccessConfirmDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const setApprovalMode = useSettingsStore(s => s.setApprovalMode);
	return (
		<ConfirmDialog
			confirmLabel={t("input.approval.yoloConfirmAction")}
			message={t("input.approval.yoloConfirmBody")}
			onCancel={onClose}
			onConfirm={() => {
				onClose();
				void setApprovalMode("yolo");
			}}
			open={open}
			title={t("input.approval.yoloConfirmTitle")}
			warning={t("input.approval.yoloConfirmWarning")}
		/>
	);
}
