/**
 * The expanded composer (⌃G; TUI app.editor.external parity, GUI-native form): its header row with the send
 * hint, the round trip through the user's $VISUAL/$EDITOR and collapse.
 */
import { ExternalLink, Minimize2 } from "lucide-react";
import { type RefObject, useState } from "react";
import { useT } from "../../../lib/i18n";
import { formatShortcut } from "../../../lib/keymap";
import { dropReferencedPastes, expandPasteMarkers } from "../../../lib/paste-blobs";
import { toast, toastError } from "../../../stores/toast";
import { Button, IconButton } from "../../common";

export interface ExternalEditor {
	/** A round trip is in flight: another one waits. */
	busy: boolean;
	open: () => Promise<void>;
}

/** Round-trip the draft (paste markers resolved) through the user's $VISUAL/$EDITOR. */
export function useExternalEditor({
	text,
	placeDraft,
	mountedRef,
}: {
	text: string;
	placeDraft: (next: string, caret: number) => void;
	mountedRef: RefObject<boolean>;
}): ExternalEditor {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const open = async () => {
		if (busy) return;
		setBusy(true);
		const draft = text;
		try {
			const response = await window.omp.editor.openExternal(expandPasteMarkers(draft));
			if (!mountedRef.current) return;
			if (!response.ok) {
				if (response.unavailable) toast({ variant: "info", message: t("editor.externalUnavailable") });
				else toastError({ title: t("editor.externalFailed"), error: response });
				return;
			}
			// null text = the editor exited non-zero; keep the draft as it was.
			if (response.text === null) return;
			// The written-back text is fully inline: consume the draft's paste blobs.
			dropReferencedPastes(draft);
			placeDraft(response.text, response.text.length);
		} finally {
			if (mountedRef.current) setBusy(false);
		}
	};
	return { busy, open };
}

export function ComposerExpandedHeader({ editor, onCollapse }: { editor: ExternalEditor; onCollapse: () => void }) {
	const t = useT();
	return (
		<div className="flex items-center gap-2 border-b border-(--sc-divider) py-1.5 pr-2 pl-4">
			<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text-secondary)">
				{t("editor.title")}
			</span>
			<span className="text-sc-xs text-(--sc-text-muted) max-sm:hidden">
				{t("input.expanded.hint", { send: formatShortcut("⌘↵") })}
			</span>
			<Button
				icon={<ExternalLink aria-hidden />}
				loading={editor.busy}
				onClick={() => void editor.open()}
				size="sm"
				variant="ghost"
			>
				{editor.busy ? t("editor.externalBusy") : t("editor.external")}
			</Button>
			<IconButton
				icon={<Minimize2 />}
				label={t("input.expanded.collapse")}
				onClick={onCollapse}
				shortcut="⌃G"
				size="sm"
			/>
		</div>
	);
}
