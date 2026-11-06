/**
 * The macOS permissions computer use needs, with the one button that asks for each (hooks/use-mac-permissions.ts):
 * `MacPermissionControl` is the state or the button, shared by Settings › Agent behavior › Computer use
 * (settings/MacPermissionRows.tsx) and `MacPermissionFix`, which a computer-use step that failed for a missing
 * permission shows under its error (agent-desktop's `PERM_DENIED`, stock's built-in computer use saying a permission is
 * not granted). The fix acts on the computer the session runs on: a session of a paired host says to allow it there.
 */
import { Check } from "lucide-react";
import { MAC_PERMISSIONS, type MacPermission } from "../../../shared/mac-permissions";
import { type MacPermissionsView, useMacPermissions } from "../../hooks/use-mac-permissions";
import { useT } from "../../lib/i18n";
import { useFocusedTabDevice } from "../../stores/remote";
import { toastError } from "../../stores/toast";
import { Badge, Button } from "../common";

export function MacPermissionControl({ permission, view }: { permission: MacPermission; view: MacPermissionsView }) {
	const t = useT();
	if (!view.status) return null;
	if (view.status[permission]) {
		return (
			<span data-mac-permission={permission} data-mac-permission-state="granted">
				<Badge variant="success">
					<Check aria-hidden size={12} />
					{t("macPermissions.allowed")}
				</Badge>
			</span>
		);
	}
	return (
		<Button
			data-mac-permission={permission}
			data-mac-permission-state="missing"
			loading={view.asking === permission}
			onClick={() => {
				view.request(permission).catch((error: unknown) => {
					toastError({ title: t("macPermissions.requestFailed"), error });
				});
			}}
			size="sm"
			variant="secondary"
		>
			{t("macPermissions.allow")}
		</Button>
	);
}

/** Under a computer-use step that failed for a missing macOS permission. */
export function MacPermissionFix() {
	const t = useT();
	const device = useFocusedTabDevice();
	const view = useMacPermissions();
	if (device !== undefined) {
		return (
			<div className="text-sc-xs text-(--sc-text-muted)" data-mac-permission-fix="host">
				{t("macPermissions.otherComputer")}
			</div>
		);
	}
	if (!view.status) return null;
	const missing = MAC_PERMISSIONS.filter(permission => !view.status?.[permission]);
	if (missing.length === 0) {
		return (
			<div className="text-sc-xs text-(--sc-text-muted)" data-mac-permission-fix="granted">
				{t("macPermissions.fixDone")}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-1" data-mac-permission-fix="missing">
			<div className="text-sc-xs text-(--sc-text-muted)">{t("macPermissions.fixTitle")}</div>
			{missing.map(permission => (
				<div className="flex flex-wrap items-center gap-2 text-sc-sm" key={permission}>
					<span>{t(`macPermissions.${permission}`)}</span>
					<MacPermissionControl permission={permission} view={view} />
				</div>
			))}
		</div>
	);
}
