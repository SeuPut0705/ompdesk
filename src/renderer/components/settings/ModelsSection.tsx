/**
 * Settings › Models & providers, in the order a user needs it: where models
 * come from (providers and their accounts, then custom models.yml endpoints),
 * which model does what (roles, then the model defaults), and the advanced
 * side-by-side comparison with the benchmark, collapsed until asked for
 * (`models:compare` opens it).
 */

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Button } from "../common";
import { ModelCompareSection } from "./ModelCompareSection";
import { ModelRolesSection } from "./ModelRolesSection";
import { ProvidersSection } from "./providers/ProvidersSection";
import { SchemaSection } from "./SchemaField";
import { SettingsSection } from "./SettingsLayout";

const DEFAULT_PATHS = ["defaultThinkingLevel", "retry.modelFallback", "retry.maxRetries"] as const;

export function ModelsSection({ sub }: { sub?: string }) {
	const t = useT();
	const compareId = useId();
	const [compareOpen, setCompareOpen] = useState(sub === "compare");
	useEffect(() => {
		if (sub === "compare") setCompareOpen(true);
	}, [sub]);
	return (
		<>
			<ProvidersSection />
			<ModelRolesSection />
			<SchemaSection id="settings-models-defaults" paths={DEFAULT_PATHS} title={t("settings.models.defaults")} />
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
					{compareOpen && <ModelCompareSection onOpenBenchmark={() => useUiStore.getState().openBenchmark()} />}
				</div>
			</SettingsSection>
		</>
	);
}
