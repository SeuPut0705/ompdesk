import { Button } from "../../components/common/Button";
import { Sheet } from "../../components/common/Sheet";
import { useT } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import type { HostPrompt } from "./host-ui-store";

type ConfirmPrompt = Extract<HostPrompt, { kind: "quit" | "update" }>;

/**
 * The confirmation a restart or a quit of the computer's OMPdesk needs (design §2.4). It says how many turns
 * are running, since both stop them, and that a quit cannot be undone from this device.
 */
export function ConfirmSheet({ prompt, onSettled }: { prompt: ConfirmPrompt; onSettled: () => void }) {
	const t = useT();
	const running = useTabsStore(state => state.tabs.filter(tab => tab.status === "running").length);
	const quit = prompt.kind === "quit";
	const answer = (confirmed: boolean) => {
		prompt.resolve(confirmed);
		onSettled();
	};
	return (
		<Sheet
			description={t(quit ? "hostUi.quit.body" : "hostUi.update.body")}
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
			open
			placement="bottom"
			title={t(quit ? "hostUi.quit.title" : "hostUi.update.title")}
		>
			<div data-host-sheet={prompt.kind}>
				{running > 0 && (
					<p className="text-sc-sm text-(--sc-text-secondary)" data-host-running={running}>
						{t(quit ? "hostUi.quit.running" : "hostUi.update.running", { count: running })}
					</p>
				)}
			</div>
		</Sheet>
	);
}
