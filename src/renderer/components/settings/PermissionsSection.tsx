/** Settings › Permissions & security: what tools may do without asking, secret hiding, and the security center. */

import { useT } from "../../lib/i18n";
import { SchemaField } from "./SchemaField";
import { SecuritySection } from "./SecuritySection";
import { SettingsSection } from "./SettingsLayout";

export function PermissionsSection() {
	const t = useT();
	return (
		<>
			<SettingsSection title={t("settings.permissions.approval")}>
				<SchemaField path="tools.approvalMode" />
				<SchemaField path="tools.approval" />
				<SchemaField path="secrets.enabled" />
			</SettingsSection>
			<SecuritySection />
		</>
	);
}
