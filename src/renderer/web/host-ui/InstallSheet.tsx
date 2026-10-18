import { Button } from "../../components/common/Button";
import { Sheet } from "../../components/common/Sheet";
import { useT } from "../../lib/i18n";
import { installStepKeys } from "../install";
import type { HostPrompt } from "./host-ui-store";

/** The numbered menu steps of installing the page as an app, in the person's own browser's words. */
export function InstallSheet({
	prompt,
	onSettled,
}: {
	prompt: Extract<HostPrompt, { kind: "install" }>;
	onSettled: () => void;
}) {
	const t = useT();
	return (
		<Sheet
			description={t("web.install.sheetDesc")}
			footer={
				<Button data-install-sheet-close="" onClick={onSettled} variant="primary">
					{t("web.install.done")}
				</Button>
			}
			onClose={onSettled}
			open
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
