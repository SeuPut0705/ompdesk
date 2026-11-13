/**
 * The device pills at the top of Settings: this computer and every paired computer, each with its link's state, the
 * one whose settings are shown highlighted. A click shows that device's settings (lib/settings-device.ts focuses a
 * tab on it: Settings follows the focused tab's device, so this is the same path a tab picked in the sidebar takes).
 * A device that is not online is dimmed and refuses with its reason in a toast, since there is nothing to show for it
 * and no tab can be opened on it now. A long name is cut and its tooltip says it whole; the strip scrolls sideways on
 * a narrow window or a phone (kit `Tabs`). Arrow keys only move focus over the pills; Enter or Space shows one, so a
 * keyboard sweep never opens a tab on every device it passes.
 *
 * Nothing shows until a computer is paired: one pill is no choice.
 */
import type { RemoteLinkState } from "../../../shared/ipc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { LOCAL_DEVICE, showSettingsOf } from "../../lib/settings-device";
import { useFocusedHost, usePairedHosts, useRemoteStore } from "../../stores/remote";
import { toast } from "../../stores/toast";
import { StatusDot, type StatusTone, type TabItem, Tabs } from "../common";

const TONE: Record<RemoteLinkState, StatusTone> = { online: "success", connecting: "warning", offline: "neutral" };

interface Pill {
	id: string;
	name: string;
	state: RemoteLinkState;
}

export function SettingsDeviceSwitch() {
	const t = useT();
	const hosts = usePairedHosts();
	const focused = useFocusedHost();
	const thisName = useRemoteStore(store => store.state?.host.name);
	const shown = focused?.deviceId ?? LOCAL_DEVICE;

	const pills: Pill[] = [
		{ id: LOCAL_DEVICE, name: t("hostScope.thisDevice"), state: "online" },
		...hosts.map(host => ({ id: host.deviceId, name: host.name, state: host.state })),
	];
	// The focused tab runs on a computer this one no longer uses: its settings still show, so it keeps its pill.
	if (focused && !pills.some(pill => pill.id === focused.deviceId))
		pills.push({ id: focused.deviceId, name: t("remote.tab.unknownDevice"), state: "offline" });

	if (pills.length < 2) return null;

	const tabs: TabItem[] = pills.map(pill => {
		const state = t(`remote.state.${pill.state}`);
		const where = pill.id === LOCAL_DEVICE && thisName ? `${thisName} · ${state}` : `${pill.name} · ${state}`;
		return {
			id: pill.id,
			label: pill.name,
			leading: <StatusDot decorative pulse={pill.state === "connecting"} tone={TONE[pill.state]} />,
			trailing: <span className="sr-only">, {state}</span>,
			tooltip: where,
			className: cx("max-w-48", pill.state !== "online" && "opacity-60"),
			attrs: { "data-settings-device": pill.id, "data-link-state": pill.state },
		};
	});

	const choose = (id: string) => {
		const pill = pills.find(entry => entry.id === id);
		if (!pill || id === shown) return;
		if (pill.state !== "online") {
			const why = pill.state === "connecting" ? "settings.device.connectingWhy" : "settings.device.offlineWhy";
			toast({ variant: "info", message: t(why, { name: pill.name }) });
			return;
		}
		void showSettingsOf(id === LOCAL_DEVICE ? undefined : id);
	};

	return (
		<div
			className="settings-device-switch flex shrink-0 items-center gap-2 border-b border-(--sc-divider) px-4 py-1.5 [--hit-gap-x:10px] [--hit-gap-y:10px]"
			data-settings-device-switch="true"
		>
			<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("settings.device.switchLabel")}</span>
			<Tabs
				activeId={shown}
				ariaLabel={t("settings.device.switchLabel")}
				className="min-w-0"
				compact
				onChange={(id, via) => {
					if (via === "click") choose(id);
				}}
				tabs={tabs}
				variant="pills"
			/>
		</div>
	);
}
