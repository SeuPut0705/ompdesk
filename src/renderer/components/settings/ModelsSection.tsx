/** Settings › Models & providers: providers and sign-in, model defaults, model roles, and comparison. */

import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { ModelCompareSection } from "./ModelCompareSection";
import { ModelRolesSection } from "./ModelRolesSection";
import { ProvidersSection } from "./providers/ProvidersSection";
import { SchemaField } from "./SchemaField";
import { SettingsSection } from "./SettingsLayout";

export function ModelsSection() {
	const t = useT();
	return (
		<>
			<SettingsSection id="settings-models-providers" title={t("settings.models.providers")}>
				<ProvidersSection />
			</SettingsSection>
			<SettingsSection id="settings-models-defaults" title={t("settings.models.defaults")}>
				<SchemaField path="defaultThinkingLevel" />
				<SchemaField path="retry.modelFallback" />
				<SchemaField path="retry.maxRetries" />
			</SettingsSection>
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
