import { Button, Sheet } from "../../components/common";
import { useT } from "../../lib/i18n";
import { installStepKeys } from "../install";
import type { HostPrompt } from "./host-ui-store";

/** The numbered menu steps of installing the page as an app, in the person's own browser's words. */
export function InstallSheet({
	prompt,
	onSettled,
	open = true,
}: {
	prompt: Extract<HostPrompt, { kind: "install" }>;
	onSettled: () => void;
	open?: boolean;
}) {
	const t = useT();
	return (
		<Sheet
			closeButton={false}
			description={t(prompt.guidance === "ios-share" ? "web.install.sheetDescIos" : "web.install.sheetDesc")}
			footer={
				<Button data-install-sheet-close="" onClick={onSettled} variant="primary">
					{t("web.install.done")}
				</Button>
			}
			onClose={onSettled}
			open={open}
			placement="bottom"
			title={t("web.install.menu")}
		>
			<ol
				className="flex list-decimal flex-col gap-2 ps-5 text-sc-sm text-(--sc-text-secondary)"
				data-host-sheet="install"
				data-install-steps={prompt.guidance}
			>
				{installStepKeys(prompt.guidance).map(key => (
					<li key={key}>{t(key)}</li>
				))}
			</ol>
		</Sheet>
	);
}
