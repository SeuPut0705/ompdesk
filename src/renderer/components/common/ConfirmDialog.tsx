/**
 * Destructive-action confirmation: the only place a user says "yes, really"
 * before something irreversible (hard file delete, discarded worktree). The
 * safe action is autofocused, so Enter never confirms by accident.
 */

import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { Button } from "./Button";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
	open: boolean;
	title: string;
	message: ReactNode;
	/** Extra consequence line, rendered in the warning colour. */
	warning?: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmDialog({
	open,
	title,
	message,
	warning,
	confirmLabel,
	cancelLabel,
	busy = false,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const t = useT();
	return (
		<Modal
			footer={
				<>
					<Button autoFocus onClick={onCancel} variant="secondary">
						{cancelLabel ?? t("common.cancel")}
					</Button>
					<Button disabled={busy} loading={busy} onClick={onConfirm} variant="danger">
						{confirmLabel ?? t("common.delete")}
					</Button>
				</>
			}
			onClose={onCancel}
			open={open}
			size="sm"
			title={title}
		>
			<div className="text-sc-md break-words whitespace-pre-wrap text-(--sc-text-secondary)">{message}</div>
			{warning && <div className="mt-2 text-sc-sm text-(--sc-warning)">{warning}</div>}
		</Modal>
	);
}
