/**
 * Device chip: the small "runs on <host>" marker a remote tab carries in its
 * pane header and the title bar breadcrumb. The dot follows the host's link
 * state and the state is also spelled out for screen readers. Its glyph wears the device's color, the one its
 * sidebar section's header wears (automatic, or chosen from that header's gear).
 */
import { Monitor } from "lucide-react";
import type { RemoteLinkState } from "../../../shared/ipc-types";
import { deviceColorOf } from "../../lib/device-color";
import { useT } from "../../lib/i18n";
import { useHostView } from "../../stores/remote";
import { useSidebarFolds } from "../../stores/sidebar-folds";
import { Badge, type BadgeVariant } from "../common";

export const LINK_BADGE: Record<RemoteLinkState, BadgeVariant> = {
	online: "success",
	connecting: "warning",
	offline: "muted",
};

export function DeviceChip({ deviceId }: { deviceId: string }) {
	const t = useT();
	const host = useHostView(deviceId);
	const name = host?.name ?? t("remote.tab.unknownDevice");
	const state = host?.state ?? "offline";
	const color = deviceColorOf(
		deviceId,
		useSidebarFolds(s => s.deviceColors[deviceId]),
		false,
	);
	return (
		<span
			className="inline-flex min-w-0 shrink-0"
			data-device-chip={deviceId}
			data-device-color={color ?? undefined}
			data-link-state={state}
			title={t("remote.tab.chip", { name })}
		>
			<Badge className="max-w-40 gap-1" dot pulse={state === "connecting"} variant={LINK_BADGE[state]}>
				<Monitor aria-hidden className="size-3 shrink-0" data-device-glyph />
				<span className="min-w-0 truncate">{name}</span>
				<span className="sr-only">, {t(`remote.state.${state}`)}</span>
			</Badge>
		</span>
	);
}
