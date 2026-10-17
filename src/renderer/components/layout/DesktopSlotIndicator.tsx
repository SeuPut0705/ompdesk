import { Monitor } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useDesktopSlotStore } from "../../stores/desktop-slot";
import { toastError } from "../../stores/toast";
import { Button } from "../common";

/**
 * App-wide "the desktop is in use" pill: the session driving the computer (the desktop slot's holder), how many
 * wait behind it, and a Stop that takes the slot back. Absent while the slot is free.
 */
export function DesktopSlotIndicator() {
	const t = useT();
	const holder = useDesktopSlotStore(s => s.state.holder);
	const waiting = useDesktopSlotStore(s => s.state.queue.length);
	if (!holder) return null;
	const stop = async () => {
		try {
			const response = await window.omp.rpc.stopDesktopSlot();
			if (!response.success) toastError({ title: t("desktopSlot.stopFailed"), error: response });
		} catch (error) {
			toastError({ title: t("desktopSlot.stopFailed"), error });
		}
	};
	return (
		<div
			className="fixed top-2 left-1/2 z-(--sc-z-popover) flex max-w-[min(560px,92vw)] -translate-x-1/2 items-center gap-2 rounded-(--sc-radius-full) border border-(--sc-border-subtle) bg-(--sc-elevated) py-0.5 ps-3 pe-1 text-sc-xs text-(--sc-text) shadow-(--sc-shadow-md)"
			data-desktop-slot-indicator
			role="status"
		>
			<Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
			<span className="min-w-0 truncate" data-desktop-slot-text>
				{t(waiting > 0 ? "desktopSlot.busyWaiting" : "desktopSlot.busy", { title: holder.title, count: waiting })}
			</span>
			<Button
				aria-label={t("desktopSlot.stop")}
				data-desktop-slot-stop
				onClick={() => void stop()}
				size="sm"
				variant="ghost"
			>
				{t("desktopSlot.stop")}
			</Button>
		</div>
	);
}
