import { Monitor, TriangleAlert } from "lucide-react";
import type { RpcResponse } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useDesktopSlotStore } from "../../stores/desktop-slot";
import { toastError } from "../../stores/toast";
import { Button } from "../common";

/**
 * App-wide "the desktop is in use" pill: the session driving the computer (the desktop slot's holder), how many
 * wait behind it, and a Stop that takes the slot back. While the holder's screen control could not be confirmed
 * released (`revokeFailed`) nobody else is granted the screen, so the pill says so and offers to retry the release
 * or to stop that session (its omp), which frees the slot once the process has exited. Absent while the slot is free.
 */
export function DesktopSlotIndicator() {
	const t = useT();
	const holder = useDesktopSlotStore(s => s.state.holder);
	const waiting = useDesktopSlotStore(s => s.state.queue.length);
	if (!holder) return null;
	const act = async (call: () => Promise<RpcResponse>, failedKey: "stopFailed" | "retryFailed" | "killFailed") => {
		try {
			const response = await call();
			if (!response.success) toastError({ title: t(`desktopSlot.${failedKey}`), error: response });
		} catch (error) {
			toastError({ title: t(`desktopSlot.${failedKey}`), error });
		}
	};
	const failed = holder.revokeFailed === true;
	return (
		<div
			className="fixed top-2 left-1/2 z-(--sc-z-popover) flex max-w-[min(640px,92vw)] -translate-x-1/2 items-center gap-2 rounded-(--sc-radius-full) border border-(--sc-border-subtle) bg-(--sc-elevated) py-0.5 ps-3 pe-1 text-sc-xs text-(--sc-text) shadow-(--sc-shadow-md)"
			data-desktop-slot-indicator
			data-desktop-slot-revoke-failed={failed ? "" : undefined}
			role="status"
		>
			{failed ? (
				<TriangleAlert aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
			) : (
				<Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
			)}
			<span className="min-w-0 truncate" data-desktop-slot-text>
				{failed
					? t("desktopSlot.revokeFailed", { title: holder.title })
					: t(waiting > 0 ? "desktopSlot.busyWaiting" : "desktopSlot.busy", {
							title: holder.title,
							count: waiting,
						})}
			</span>
			{failed ? (
				<>
					<Button
						data-desktop-slot-retry
						onClick={() => void act(() => window.omp.rpc.retryDesktopSlot(), "retryFailed")}
						size="sm"
						variant="ghost"
					>
						{t("desktopSlot.retry")}
					</Button>
					<Button
						data-desktop-slot-kill
						onClick={() => void act(() => window.omp.rpc.killDesktopSlot(), "killFailed")}
						size="sm"
						variant="ghost"
					>
						{t("desktopSlot.kill")}
					</Button>
				</>
			) : (
				<Button
					aria-label={t("desktopSlot.stop")}
					data-desktop-slot-stop
					onClick={() => void act(() => window.omp.rpc.stopDesktopSlot(), "stopFailed")}
					size="sm"
					variant="ghost"
				>
					{t("desktopSlot.stop")}
				</Button>
			)}
		</div>
	);
}
