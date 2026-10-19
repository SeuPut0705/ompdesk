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

import { Shield, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { type ApprovalMode, useSettingsStore } from "../../../stores/settings";
import { ConfirmDialog } from "../../common";
import { ChoiceRow } from "./ChoiceRow";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["yolo", "write", "always-ask"];

/** The shield glyph of each mode: the segment's, and the Run chip's status glyph. */
export const APPROVAL_ICONS = { yolo: ShieldAlert, write: Shield, "always-ask": ShieldCheck } as const;

/**
 * One line: the shield, the three modes as a segmented row of short names (full name as tooltip and accessible name),
 * the held mode's description behind (i). Full access asks first (the host's confirm dialog), the rest apply at once.
 */
export function ApprovalModeField({ onRequestFullAccess }: { onRequestFullAccess: () => void }) {
	const t = useT();
	const mode = useSettingsStore(s => s.approvalMode);
	const setApprovalMode = useSettingsStore(s => s.setApprovalMode);
	const pick = (next: ApprovalMode) => {
		if (next === mode) return;
		if (next === "yolo") onRequestFullAccess();
		else void setApprovalMode(next);
	};
	return (
		<ChoiceRow
			icon={ShieldQuestion}
			info={t(`input.approval.${mode}.desc`)}
			label={t("input.runSettings.approval")}
			onChange={pick}
			optionAttr="data-approval-option"
			options={APPROVAL_MODES.map(option => ({
				value: option,
				label: t(`input.approval.short.${option}`),
				name: t(`input.approval.${option}`),
				icon: APPROVAL_ICONS[option],
			}))}
			rowAttrs={{ "data-approval-mode": true }}
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
