/**
 * Settings › Agent behavior, under Computer use engine: the two macOS permissions computer use needs, each with its
 * state (read again when the window regains focus) and one button that asks macOS for it and opens its pane of System
 * Settings (src/main/mac-permissions.ts). Both engines run under OMPdesk, so the grant is OMPdesk's either way. Shown
 * only where they exist: nothing on Windows. A state, never a setting: the person turns the switch on in macOS.
 */
import { Eye, MousePointerClick } from "lucide-react";
import { useMacPermissions } from "../../hooks/use-mac-permissions";
import { useT } from "../../lib/i18n";
import { MacPermissionControl } from "../chat/MacPermissionFix";
import { SettingsRow } from "./SettingsLayout";

export function MacPermissionRows() {
	const t = useT();
	const view = useMacPermissions();
	if (!view.status) return null;
	return (
		<>
			<SettingsRow
				compactControl
				control={<MacPermissionControl permission="accessibility" view={view} />}
				description={t("macPermissions.accessibilityDesc")}
				icon={<MousePointerClick />}
				id="setting-gui-macPermission-accessibility"
				label={t("macPermissions.accessibility")}
			/>
			<SettingsRow
				compactControl
				control={<MacPermissionControl permission="screen" view={view} />}
				description={t("macPermissions.screenDesc")}
				icon={<Eye />}
				id="setting-gui-macPermission-screen"
				label={t("macPermissions.screen")}
			/>
		</>
	);
}
