/** Settings › Permissions & security: what tools may do without asking, secret hiding, and the security center. */

import { useT } from "../../lib/i18n";
import { SchemaSection } from "./SchemaField";
import { SecuritySection } from "./SecuritySection";

const APPROVAL_PATHS = ["tools.approvalMode", "tools.approval", "secrets.enabled"] as const;

export function PermissionsSection() {
	const t = useT();
	return (
		<>
			<SchemaSection paths={APPROVAL_PATHS} title={t("settings.permissions.approval")} />
			<SecuritySection />
		</>
	);
}
