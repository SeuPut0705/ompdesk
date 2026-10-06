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

import { useId } from "react";
import { useT } from "../../lib/i18n";
import { type ApprovalMode, useSettingsStore } from "../../stores/settings";
import { ConfirmDialog, Select } from "../common";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["yolo", "write", "always-ask"];

export function ApprovalModeField({ onRequestFullAccess }: { onRequestFullAccess: () => void }) {
	const t = useT();
	const mode = useSettingsStore(s => s.approvalMode);
	const setApprovalMode = useSettingsStore(s => s.setApprovalMode);
	const hintId = useId();
	return (
		<Select
			aria-describedby={hintId}
			controlSize="sm"
			data-approval-mode
			hint={<span id={hintId}>{t(`input.approval.${mode}.desc`)}</span>}
			label={t("input.runSettings.approval")}
			onChange={event => {
				const next = event.target.value as ApprovalMode;
				if (next === mode) return;
				if (next === "yolo") onRequestFullAccess();
				else void setApprovalMode(next);
			}}
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
