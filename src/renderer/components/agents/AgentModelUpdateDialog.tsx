/**
 * Agents › Definitions: the confirmation for "Update to role-based model".
 * It shows the one line that changes (old out, new in) and writes the file
 * with only that line replaced; nothing is written before the click.
 */

import { useState } from "react";
import type { ModelLineEdit, TemplateModelOffer } from "../../../shared/agent-template-migration";
import type { AgentFileScope } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { toast, toastError } from "../../stores/toast";
import { Button, Modal } from "../common";

export interface AgentModelUpdateTarget {
	name: string;
	scope: AgentFileScope;
	filePath: string;
	offer: TemplateModelOffer;
	edit: ModelLineEdit;
}

function DiffLines({ lines, sign, label }: { lines: string; sign: "-" | "+"; label: string }) {
	const removed = sign === "-";
	return (
		<div
			className={
				removed
					? "flex gap-2 bg-(--sc-danger-soft) px-3 py-1.5 text-(--sc-text-secondary)"
					: "flex gap-2 bg-(--sc-success-soft) px-3 py-1.5 text-(--sc-text)"
			}
		>
			<span aria-hidden className={removed ? "text-(--sc-danger)" : "text-(--sc-success)"}>
				{sign}
			</span>
			<span className="sr-only">{label}</span>
			<pre className="min-w-0 flex-1 font-mono text-sc-sm break-all whitespace-pre-wrap">{lines}</pre>
		</div>
	);
}

export function AgentModelUpdateDialog({
	target,
	onClose,
	onDone,
}: {
	target: AgentModelUpdateTarget | null;
	onClose: () => void;
	/** After the file was written: refresh discovery. */
	onDone: () => void;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const [busy, setBusy] = useState(false);

	const confirm = async () => {
		if (!target) return;
		setBusy(true);
		try {
			const response = await rpc.writeAgentFile({
				scope: target.scope,
				name: target.name,
				content: target.edit.content,
				replacePath: target.filePath,
			});
			if (!response.success) {
				toastError({ title: t("agentHub.actionFailed"), error: response });
				return;
			}
			toast({
				variant: "success",
				title: t("agentHub.defs.roleModel.done", { name: target.name }),
				message: target.filePath,
			});
			onDone();
			onClose();
		} catch (cause) {
			toastError({ title: t("agentHub.actionFailed"), error: cause });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button autoFocus onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button disabled={busy} loading={busy} onClick={() => void confirm()} variant="primary">
						{t("agentHub.defs.roleModel.confirm")}
					</Button>
				</>
			}
			onClose={onClose}
			open={target !== null}
			size="md"
			title={t("agentHub.defs.roleModel.title", { name: target?.name ?? "" })}
		>
			{target && (
				<div className="flex flex-col gap-3">
					<p className="text-sc-sm break-all text-(--sc-text-muted)">{target.filePath}</p>
					<div className="overflow-hidden rounded-(--sc-radius-md) border border-(--sc-divider)">
						<DiffLines label={t("agentHub.defs.roleModel.removed")} lines={target.edit.before} sign="-" />
						<DiffLines label={t("agentHub.defs.roleModel.added")} lines={target.edit.after} sign="+" />
					</div>
					<p className="text-sc-sm text-(--sc-text-secondary)">{t("agentHub.defs.roleModel.only")}</p>
					{!target.offer.legacy && (
						<p className="text-sc-sm text-(--sc-warning)">{t("agentHub.defs.roleModel.edited")}</p>
					)}
				</div>
			)}
		</Modal>
	);
}
