/**
 * Device chip: the small "runs on <host>" marker a remote tab carries in its
 * pane header and the title bar breadcrumb. The dot follows the host's link
 * state and the state is also spelled out for screen readers.
 */
import { Monitor } from "lucide-react";
import type { RemoteLinkState } from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import { useHostView } from "../../stores/remote";
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
	return (
		<span
			className="inline-flex min-w-0 shrink-0"
			data-device-chip={deviceId}
			data-link-state={state}
			title={t("remote.tab.chip", { name })}
		>
			<Badge className="max-w-40 gap-1" dot pulse={state === "connecting"} variant={LINK_BADGE[state]}>
				<Monitor aria-hidden className="size-3 shrink-0" />
				<span className="min-w-0 truncate">{name}</span>
				<span className="sr-only">, {t(`remote.state.${state}`)}</span>
			</Badge>
		</span>
	);
}
