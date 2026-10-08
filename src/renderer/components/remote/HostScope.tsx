/**
 * Which machine a Settings/Usage/Stats surface describes when the focused tab
 * runs on a paired host. Agent data (providers, models, permissions, stats…)
 * is the host's; app preferences stay this device's.
 *
 * - `HostScoped` wraps host data: it renders its children for a local tab or
 *   an online host, and an offline notice otherwise — never stale or local data.
 * - `ThisDeviceTag` marks app-scoped content while a remote tab is focused.
 */
import { Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { useFocusedHost } from "../../stores/remote";
import { Badge, Banner } from "../common";

export function HostScoped({ children }: { children: ReactNode }) {
	const host = useFocusedHost();
	if (!host || host.online) return children;
	return <HostOfflineNotice name={host.name} />;
}

export function HostOfflineNotice({ name }: { name: string | undefined }) {
	const t = useT();
	const device = name ?? t("remote.tab.unknownDevice");
	return (
		<div data-host-offline="true">
			<Banner className="my-3" title={t("hostScope.offline", { name: device })} variant="warning">
				{t("hostScope.offlineDesc", { name: device })}
			</Banner>
		</div>
	);
}

/**
 * "This device" next to app-scoped settings; nothing while the focused tab is local.
 * `compact` (the narrow Settings nav) shows the device icon alone, so the row keeps its label.
 */
export function ThisDeviceTag({ compact = false }: { compact?: boolean }) {
	const t = useT();
	const host = useFocusedHost();
	if (!host) return null;
	if (compact) {
		return (
			<span
				aria-label={t("hostScope.thisDevice")}
				className="inline-flex text-(--sc-text-muted) [&_svg]:size-3.5"
				data-this-device-tag="true"
				role="img"
				title={`${t("hostScope.thisDevice")}: ${t("hostScope.thisDeviceDesc")}`}
			>
				<Monitor aria-hidden />
			</span>
		);
	}
	return (
		<span data-this-device-tag="true" title={t("hostScope.thisDeviceDesc")}>
			<Badge variant="muted">{t("hostScope.thisDevice")}</Badge>
		</span>
	);
}
