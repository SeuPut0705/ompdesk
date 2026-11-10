import { Button, Sheet } from "../../components/common";
import { useT } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import type { HostPrompt } from "./host-ui-store";

type ConfirmPrompt = Extract<HostPrompt, { kind: "quit" | "update" }>;

/**
 * The confirmation a restart or a quit of the computer's OMPdesk needs (design §2.4). It says how many turns
 * are running, since both stop them, and that a quit cannot be undone from this device.
 */
export function ConfirmSheet({
	prompt,
	onSettled,
	open = true,
}: {
	prompt: ConfirmPrompt;
	onSettled: () => void;
	/** False once settled: the sheet plays its exit before it goes. */
	open?: boolean;
}) {
	const t = useT();
	const running = useTabsStore(state => state.tabs.filter(tab => tab.status === "running").length);
	const quit = prompt.kind === "quit";
	const answer = (confirmed: boolean) => {
		prompt.resolve(confirmed);
		onSettled();
	};
	// The sentence is the body, as a confirm dialog's message is, so the body is never an empty band between dividers.
	return (
		<Sheet
			footer={
				<>
					<Button onClick={() => answer(false)} variant="ghost">
						{t("hostUi.cancel")}
					</Button>
					<Button data-host-confirm="" onClick={() => answer(true)} variant={quit ? "danger" : "primary"}>
						{t(quit ? "hostUi.quit.confirm" : "hostUi.update.confirm")}
					</Button>
				</>
			}
			onClose={() => answer(false)}
			open={open}
			placement="bottom"
			title={t(quit ? "hostUi.quit.title" : "hostUi.update.title")}
		>
			<div className="flex flex-col gap-1 text-sc-sm text-(--sc-text-secondary)" data-host-sheet={prompt.kind}>
				<p>{t(quit ? "hostUi.quit.body" : "hostUi.update.body")}</p>
				{running > 0 && (
					<p data-host-running={running}>
						{t(quit ? "hostUi.quit.running" : "hostUi.update.running", { count: running })}
					</p>
				)}
			</div>
		</Sheet>
	);
}
