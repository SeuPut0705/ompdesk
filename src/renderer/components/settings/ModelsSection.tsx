/** Settings › Models & providers: providers and sign-in, model defaults, model roles, and comparison. */

import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { ModelCompareSection } from "./ModelCompareSection";
import { ModelRolesSection } from "./ModelRolesSection";
import { ProvidersSection } from "./providers/ProvidersSection";
import { SchemaSection } from "./SchemaField";
import { SettingsSection } from "./SettingsLayout";

const DEFAULT_PATHS = ["defaultThinkingLevel", "retry.modelFallback", "retry.maxRetries"] as const;

export function ModelsSection() {
	const t = useT();
	return (
		<>
			<SettingsSection id="settings-models-providers" title={t("settings.models.providers")}>
				<ProvidersSection />
			</SettingsSection>
			<SchemaSection id="settings-models-defaults" paths={DEFAULT_PATHS} title={t("settings.models.defaults")} />
			<SettingsSection
				description={t("settings.models.rolesDesc")}
				id="settings-models-roles"
				title={t("settings.models.roles")}
			>
				<ModelRolesSection />
			</SettingsSection>
			<SettingsSection
				description={t("settings.models.compareDesc")}
				id="settings-models-compare"
				title={t("settings.models.compare")}
			>
				<ModelCompareSection onOpenBenchmark={() => useUiStore.getState().openBenchmark()} />
			</SettingsSection>
		</>
	);
}
