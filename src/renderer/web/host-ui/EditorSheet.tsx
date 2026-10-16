import { Monitor } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "../../components/common/Button";
import { Sheet } from "../../components/common/Sheet";
import { TextEditor } from "../../components/common/TextEditor";
import { useT } from "../../lib/i18n";
import { hostActionError } from "./errors";
import type { HostPrompt } from "./host-ui-store";

type EditorPrompt = Extract<HostPrompt, { kind: "editor" }>;

/**
 * The composer's "edit in $EDITOR" on a phone: a full-screen editor that returns the text (`{ok, text}`, the
 * desktop's shape), or "Edit on computer", which opens the host's own editor and waits for its text.
 */
export function EditorSheet({ prompt, onSettled }: { prompt: EditorPrompt; onSettled: () => void }) {
	const t = useT();
	const text = useRef(prompt.content);
	const [waiting, setWaiting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const finish = (result: { ok: boolean; unavailable: boolean; text: string | null; error?: string }) => {
		prompt.resolve(result);
		onSettled();
	};

	const onComputer = async () => {
		setWaiting(true);
		setError(null);
		try {
			const result = await prompt.host.editOnComputer(text.current);
			if (result.ok) finish(result);
			else {
				setError(result.error ?? hostActionError(new Error("")));
				setWaiting(false);
			}
		} catch (cause) {
			setError(hostActionError(cause));
			setWaiting(false);
		}
	};

	return (
		<Sheet
			bodyClassName="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3"
			description={t("hostUi.editor.description")}
			footer={
				<>
					<Button disabled={waiting} icon={<Monitor />} onClick={() => void onComputer()} variant="secondary">
						{t("hostUi.editor.onComputer")}
					</Button>
					<Button
						disabled={waiting}
						onClick={() => finish({ ok: true, unavailable: false, text: text.current })}
						variant="primary"
					>
						{t("hostUi.editor.done")}
					</Button>
				</>
			}
			onClose={() => finish({ ok: false, unavailable: false, text: null })}
			open
			placement="full"
			title={t("hostUi.editor.title")}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-2" data-host-sheet="editor">
				{waiting ? (
					<p className="text-sc-sm text-(--sc-text-muted)" data-host-editor-waiting="" role="status">
						{t("hostUi.editor.waiting")}
					</p>
				) : (
					<TextEditor
						ariaLabel={t("hostUi.editor.label")}
						autoFocus
						className="min-h-0 flex-1"
						language="markdown"
						onChange={value => {
							text.current = value;
						}}
						value={prompt.content}
					/>
				)}
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" data-host-sheet-error="" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}
