/**
 * Shown when switching to a session whose saved model can no longer be
 * restored (provider removed, signed out, model retired). Upstream refuses to
 * silently continue such a transcript on another model, so the user decides:
 * reopen it bound to the current model, or stay where they are.
 */

import { useState } from "react";
import { switchSessionNow } from "../../hooks/use-session-switch";
import { useT } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useUiStore } from "../../stores/ui";
import { Button, Modal } from "../common";

export function ModelRestoreDialog() {
	const t = useT();
	const prompt = useUiStore(s => s.modelRestorePrompt);
	const close = useUiStore(s => s.closeModelRestore);
	const current = useModelStore(s => s.model);
	const [busy, setBusy] = useState(false);

	const currentLabel = current ? (current.name ?? `${current.provider}/${current.id}`) : null;

	const openWithCurrent = async () => {
		if (!prompt || !current) return;
		setBusy(true);
		try {
			const switched = await switchSessionNow(prompt.session, { provider: current.provider, modelId: current.id });
			if (switched) close();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			onClose={close}
			open={prompt !== null}
			size="sm"
			title={t("modelRestore.title")}
			footer={
				<>
					<Button autoFocus onClick={close} size="sm" variant="secondary">
						{t("common.cancel")}
					</Button>
					{currentLabel ? (
						<Button
							disabled={busy}
							loading={busy}
							onClick={() => void openWithCurrent()}
							size="sm"
							variant="primary"
						>
							{t("modelRestore.openWith", { model: currentLabel })}
						</Button>
					) : null}
				</>
			}
		>
			<div className="space-y-2 text-sc-md leading-relaxed break-words text-(--sc-text-secondary)">
				<p>{t("modelRestore.message", { model: prompt?.missingModel ?? "" })}</p>
				<p className="text-sc-sm">
					{currentLabel ? t("modelRestore.offer", { model: currentLabel }) : t("modelRestore.noCurrent")}
				</p>
			</div>
		</Modal>
	);
}
