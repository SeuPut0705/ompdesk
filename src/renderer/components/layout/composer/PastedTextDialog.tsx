import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { getPaste } from "../../../lib/paste-blobs";
import { Button, Modal, TextArea } from "../../common";

/**
 * Edit a folded paste before sending. Save hands the new text back; Cancel (or Esc) keeps the paste as it was;
 * "Paste as text" unfolds it into the draft. The caret opens in the text (not on the close button), and the
 * composer takes focus back when the dialog is gone.
 */
export function PastedTextDialog({
	pasteId,
	onClose,
	onSave,
	onAsText,
}: {
	pasteId: number | null;
	onClose: () => void;
	onSave: (id: number, content: string) => void;
	onAsText: (id: number) => void;
}) {
	const t = useT();
	const [value, setValue] = useState("");
	useEffect(() => {
		if (pasteId !== null) setValue(getPaste(pasteId)?.content ?? "");
	}, [pasteId]);
	return (
		<Modal
			footer={
				<>
					<Button
						className="mr-auto"
						data-paste-as-text
						onClick={() => {
							if (pasteId === null) return;
							onAsText(pasteId);
							onClose();
						}}
						variant="ghost"
					>
						{t("input.paste.asTextAction")}
					</Button>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button
						data-paste-save
						disabled={value.length === 0}
						onClick={() => {
							if (pasteId !== null) onSave(pasteId, value);
						}}
						variant="primary"
					>
						{t("common.save")}
					</Button>
				</>
			}
			onClose={onClose}
			open={pasteId !== null}
			size="lg"
			title={t("input.paste.editTitle", { id: pasteId ?? 0 })}
		>
			<TextArea
				aria-label={t("input.paste.editLabel")}
				autoFocus
				className="max-h-[60dvh] min-h-48"
				mono
				onChange={event => setValue(event.target.value)}
				rows={14}
				value={value}
			/>
		</Modal>
	);
}
