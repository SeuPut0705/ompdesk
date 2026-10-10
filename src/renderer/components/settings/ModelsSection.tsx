/** Accounts, model roles/defaults, then the single custom endpoint list. */

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Button } from "../common";
import { ModelCompareSection } from "./ModelCompareSection";
import { ModelRolesSection } from "./ModelRolesSection";
import { ModelSetupEntry } from "./model-setup/ModelSetupEntry";
import { OwnedSchemaSettings } from "./OwnedSchemaSettings";
import { ProvidersSection } from "./providers/ProvidersSection";
import { SchemaSection } from "./SchemaField";
import { SettingsSection } from "./SettingsLayout";

const DEFAULT_PATHS = ["defaultThinkingLevel"] as const;

export function ModelsSection({ sub }: { sub?: string }) {
	const t = useT();
	const compareId = useId();
	const [compareOpen, setCompareOpen] = useState(sub === "compare");
	useEffect(() => {
		if (sub === "compare") setCompareOpen(true);
	}, [sub]);
	return (
		<ProvidersSection
			accountPolicies={
				<div id="settings-models-reset-passes">
					<OwnedSchemaSettings section="models" resetPolicies />
				</div>
			}
			modelSettings={
				<SettingsSection title={t("settings.tabs.model")} id="settings-models-models">
					<ModelSetupEntry />
					<ModelRolesSection />
					<SchemaSection
						id="settings-models-defaults"
						paths={DEFAULT_PATHS}
						title={t("settings.models.defaults")}
					/>
					<OwnedSchemaSettings section="models" />
					<SettingsSection
						actions={
							<Button
								aria-controls={compareId}
								aria-expanded={compareOpen}
								icon={
									<ChevronDown
										className={cx(
											"transition-transform duration-(--sc-duration-fast) motion-reduce:transition-none",
											compareOpen && "rotate-180",
										)}
									/>
								}
								onClick={() => setCompareOpen(open => !open)}
								size="sm"
								variant="ghost"
							>
								{compareOpen ? t("settings.models.compareHide") : t("settings.models.compareShow")}
							</Button>
						}
						description={t("settings.models.compareDesc")}
						id="settings-models-compare"
						title={t("settings.models.compare")}
					>
						<div id={compareId}>
							{compareOpen && (
								<ModelCompareSection onOpenBenchmark={() => useUiStore.getState().openBenchmark()} />
							)}
						</div>
					</SettingsSection>
				</SettingsSection>
			}
		/>
	);
}
