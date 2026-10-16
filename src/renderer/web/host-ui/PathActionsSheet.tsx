import { Download, Eye, FolderSearch, Monitor } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { IpcOpenPathResult } from "../../../shared/ipc-types";
import { Button } from "../../components/common/Button";
import { Sheet } from "../../components/common/Sheet";
import { basename } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { failureText, hostActionError } from "./errors";
import type { HostPrompt } from "./host-ui-store";

type PathHostPrompt = Extract<HostPrompt, { kind: "openPath" | "revealPath" }>;

/**
 * The one sheet a file the agent named opens (design §2.4): "View on phone" (the Files viewer), "Open on
 * computer" (the host's own opener; launcher types are only revealed there) and "Download" for an open;
 * "Show in Files" and "Show on computer" for a reveal. A device without computer control gets the host's
 * refusal as a sentence under the buttons.
 */
export function PathActionsSheet({ prompt, onSettled }: { prompt: PathHostPrompt; onSettled: () => void }) {
	const t = useT();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reveal = prompt.kind === "revealPath";
	const name = basename(prompt.path) || prompt.path;

	const finish = (result: IpcOpenPathResult) => {
		prompt.resolve(result);
		onSettled();
	};

	const run = async (id: string, action: () => Promise<IpcOpenPathResult>, done?: string) => {
		setBusy(id);
		setError(null);
		try {
			const result = await action();
			if (!result.ok) {
				setError(failureText(result.error));
				setBusy(null);
				return;
			}
			if (done) toast({ variant: "success", message: done });
			finish(result);
		} catch (cause) {
			setError(hostActionError(cause));
			setBusy(null);
		}
	};

	const view = () => {
		const ui = useUiStore.getState();
		if (reveal) ui.revealInFiles(prompt.path);
		else ui.openFilePreview(prompt.path);
		finish({ ok: true });
	};

	const button = (id: string, icon: ReactNode, label: string, onClick: () => void) => (
		<Button
			className="w-full justify-start"
			data-host-action={id}
			disabled={busy !== null}
			icon={icon}
			loading={busy === id}
			onClick={onClick}
			size="lg"
		>
			{label}
		</Button>
	);

	return (
		<Sheet
			description={t("hostUi.openPath.description")}
			onClose={() => finish({ ok: true })}
			open
			placement="bottom"
			title={t(reveal ? "hostUi.revealPath.title" : "hostUi.openPath.title", { name })}
		>
			<div className="flex flex-col gap-2" data-host-sheet={prompt.kind}>
				{button(
					"phone",
					reveal ? <FolderSearch /> : <Eye />,
					t(reveal ? "hostUi.revealPath.inFiles" : "hostUi.openPath.viewOnPhone"),
					view,
				)}
				{button(
					"computer",
					<Monitor />,
					t(reveal ? "hostUi.revealPath.onComputer" : "hostUi.openPath.openOnComputer"),
					() =>
						void run(
							"computer",
							() =>
								reveal
									? prompt.host.revealPathOnComputer(prompt.path, prompt.tabId)
									: prompt.host.openPathOnComputer(prompt.path, prompt.tabId),
							reveal ? undefined : t("hostUi.openPath.openedOnComputer"),
						),
				)}
				{!reveal &&
					button(
						"download",
						<Download />,
						t("hostUi.openPath.download"),
						() => void run("download", () => prompt.host.downloadToPhone(prompt.path, prompt.tabId)),
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
