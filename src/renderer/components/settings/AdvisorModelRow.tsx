import { useCallback, useEffect, useState } from "react";
import type { ModelRoleEntry, ModelRolesResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { Button } from "../common";
import { effectiveAdvisorModel } from "./model-setup/model-setup-logic";
import { SettingsRow } from "./SettingsLayout";
import { useSettingsNavigate } from "./settings-navigation";

/** Advisor configuration has one editor: Models › roles. This row only summarizes it. */
export function AdvisorModelRow({ active, sidecarReady }: { active: boolean | undefined; sidecarReady: boolean }) {
	const t = useT();
	const tabRpc = useTabRpc();
	const navigate = useSettingsNavigate();
	const [roles, setRoles] = useState<ModelRoleEntry[]>([]);
	const load = useCallback(async () => {
		if (!sidecarReady) return;
		try {
			const result = await tabRpc.getModelRoles();
			if (result.success) setRoles((result.data as ModelRolesResult).roles);
		} catch {
			/* The summary retains its last value during a reconnect. */
		}
	}, [sidecarReady, tabRpc.getModelRoles]);
	useEffect(() => {
		void load();
		return window.omp.events.onConfigUpdate(() => void load());
	}, [load]);
	const effective = effectiveAdvisorModel(roles);
	return (
		<SettingsRow
			control={
				<Button onClick={() => navigate("models:roles", "settings-models-roles")} size="sm" variant="secondary">
					{t("settings.features.configureRoles")}
				</Button>
			}
			description={active === false ? t("settings.features.advisorIdle") : undefined}
			id="setting-advisor-model"
			label={t("settings.features.advisorModel")}
		>
			<span className="font-mono text-sc-sm text-(--sc-text-muted)">
				{effective?.model ?? t("settings.features.advisorModelUnset")}
			</span>
		</SettingsRow>
	);
}
