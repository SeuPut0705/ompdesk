import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { getPaste } from "../../../lib/paste-blobs";
import { Button, Modal, TextArea } from "../../common";

/**
 * Edit a folded paste before sending. Save hands the new text back; Cancel
 * (or Esc) keeps the paste as it was.
 */
export function PastedTextDialog({
	pasteId,
	onClose,
	onSave,
}: {
	pasteId: number | null;
	onClose: () => void;
	onSave: (id: number, content: string) => void;
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
				className="max-h-[60dvh] min-h-48"
				mono
				onChange={event => setValue(event.target.value)}
				rows={14}
				value={value}
			/>
		</Modal>
	);
}
