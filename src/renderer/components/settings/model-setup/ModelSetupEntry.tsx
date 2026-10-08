/**
 * Settings › Models & providers, above Model roles: the model setup
 * assistant's entry, with the date of the last proposal for this machine.
 */

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { formatClock } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useFocusedTabDevice } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { Button } from "../../common";
import { SettingsRow, SettingsSection } from "../SettingsLayout";
import { loadLastProposal } from "./model-setup-logic";

export function ModelSetupEntry() {
	const t = useT();
	const device = useFocusedTabDevice();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const dialogOpen = useUiStore(state => state.modelSetupOpen);
	const [savedAt, setSavedAt] = useState<number | undefined>();

	// Re-read when the dialog closes: a research run may have stored a new proposal.
	useEffect(() => {
		if (dialogOpen) return;
		let cancelled = false;
		void loadLastProposal(device)
			.then(proposal => {
				if (!cancelled) setSavedAt(proposal?.savedAt);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [device, dialogOpen]);

	return (
		<SettingsSection id="settings-models-setup" title={t("modelSetup.title")}>
			<SettingsRow
				control={
					<Button
						disabled={!sidecarReady}
						icon={<Sparkles />}
						onClick={() => useUiStore.getState().openModelSetup()}
						size="sm"
						variant="secondary"
					>
						{t("modelSetup.open")}
					</Button>
				}
				description={
					savedAt === undefined
						? t("modelSetup.entryDesc")
						: `${t("modelSetup.entryDesc")} ${t("modelSetup.entryLast", { date: formatClock(savedAt) })}`
				}
				label={t("modelSetup.entryLabel")}
			/>
		</SettingsSection>
	);
}
