import { Monitor, Smartphone } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/common/Button";
import { Sheet } from "../../components/common/Sheet";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { failureText, hostActionError } from "./errors";
import { HostBrowserSheet } from "./HostBrowserSheet";
import type { HostPrompt } from "./host-ui-store";

type SavePrompt = Extract<HostPrompt, { kind: "saveImage" }>;

/** Save an image the page holds: onto this device (share sheet or download) or into a folder on the computer. */
export function SaveImageSheet({ prompt, onSettled }: { prompt: SavePrompt; onSettled: () => void }) {
	const t = useT();
	const [stage, setStage] = useState<"choose" | "browse">("choose");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const finish = (result: { saved: boolean; error?: string }) => {
		prompt.resolve(result);
		onSettled();
	};

	const savePhone = async () => {
		setBusy(true);
		try {
			finish(await prompt.host.saveBytesToPhone(prompt.name, prompt.mime, prompt.base64));
		} catch (cause) {
			setError(hostActionError(cause));
			setBusy(false);
		}
	};

	if (stage === "browse") {
		return (
			<HostBrowserSheet
				host={prompt.host}
				mode="folder"
				onDone={paths => {
					const dir = paths?.[0];
					if (!dir) return finish({ saved: false });
					void prompt.host
						.saveToHost({ dir, name: prompt.name, data: prompt.base64 })
						.then(result => {
							if (result.ok) {
								toast({ variant: "success", message: t("hostUi.save.done", { path: result.path }) });
								finish({ saved: true });
							} else {
								setError(failureText(result.error));
								setStage("choose");
							}
						})
						.catch((cause: unknown) => {
							setError(hostActionError(cause));
							setStage("choose");
						});
				}}
				title={t("hostUi.browser.saveTitle")}
			/>
		);
	}

	return (
		<Sheet
			description={t("hostUi.save.description")}
			onClose={() => finish({ saved: false })}
			open
			placement="bottom"
			title={t("hostUi.save.title", { name: prompt.name })}
		>
			<div className="flex flex-col gap-2" data-host-sheet="saveImage">
				<Button
					className="w-full justify-start"
					data-host-action="phone"
					disabled={busy}
					icon={<Smartphone />}
					onClick={() => void savePhone()}
					size="lg"
				>
					{t("hostUi.save.onPhone")}
				</Button>
				<Button
					className="w-full justify-start"
					data-host-action="computer"
					disabled={busy}
					icon={<Monitor />}
					onClick={() => setStage("browse")}
					size="lg"
				>
					{t("hostUi.save.onComputer")}
				</Button>
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" data-host-sheet-error="" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}
