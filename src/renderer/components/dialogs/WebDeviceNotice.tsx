/**
 * Desktop-only notice of a new device (`mobileWeb.devices.onConnected`): a device signed in to an allowed Tailscale
 * account opened Mobile web for the first time and connected on its own. One quiet toast names it, with the one
 * thing worth doing — Block, which keeps that device (its Tailscale node) out until it is unblocked in Settings.
 * Renders nothing; not shown while "approve new devices" is on, since the approval dialog already asked.
 */
import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { toast, toastError } from "../../stores/toast";

/** Long enough to read and reach for the button, short enough to stay out of the way. */
const NOTICE_MS = 15_000;

export function WebDeviceNotice() {
	const t = useT();
	useEffect(
		() =>
			window.omp.mobileWeb.devices.onConnected(device => {
				toast({
					variant: "info",
					message: t("mobileWeb.notice.message", { name: device.name }),
					durationMs: NOTICE_MS,
					action: {
						label: t("mobileWeb.notice.block"),
						run: () => {
							window.omp.mobileWeb.devices.revoke(device.id).catch((error: unknown) => {
								toastError({ title: t("mobileWeb.notice.blockFailed"), error });
							});
						},
					},
				});
			}),
		[t],
	);
	return null;
}
