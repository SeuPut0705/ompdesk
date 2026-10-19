/**
 * Settings › Updates & about › This computer: Memory as one of OMPdesk's own components (version, status, "updated
 * with OMPdesk"), beside the tool CLIs and extensions. It has no update control of its own: it comes with the app.
 */
import { Brain } from "lucide-react";
import { useEffect } from "react";
import { aiMemoryStatusText } from "../../../lib/ai-memory-text";
import { useT } from "../../../lib/i18n";
import { useAiMemoryStore } from "../../../stores/ai-memory";
import { Badge } from "../../common";
import { SettingsRow } from "../SettingsLayout";

export function MemoryComponentRow() {
	const t = useT();
	const state = useAiMemoryStore(s => s.state);
	const load = useAiMemoryStore(s => s.load);
	useEffect(() => {
		void load();
	}, [load]);
	if (!state) return null;
	return (
		<SettingsRow
			badge={<Badge variant="muted">{t("memory.component.badge")}</Badge>}
			compactControl
			control={
				<span className="text-sc-sm text-(--sc-text-secondary)" data-memory-component>
					{aiMemoryStatusText(t, state)} · {t("memory.component.updatedWith")}
				</span>
			}
			description={t("memory.component.info")}
			icon={<Brain />}
			id="setting-memory-component"
			label={t("memory.title")}
		/>
	);
}
