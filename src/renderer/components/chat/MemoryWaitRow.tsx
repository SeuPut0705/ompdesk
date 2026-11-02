import { MemoryStick } from "lucide-react";
import type { IpcMemoryWait } from "../../../shared/ipc-types";
import { uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { Button } from "../common";

const GIB = 1024 ** 3;

/**
 * The tab's start waits for memory on the computer that runs it (main's memory admission): new agent work waits while
 * that computer's memory is in danger and starts by itself, in line order. A calm row, never a failure; Start now goes
 * to the computer that holds the wait (a paired host's tab asks its host). The figures are that computer's.
 */
export function MemoryWaitRow({ tabId, wait }: { tabId: string; wait: IpcMemoryWait }) {
	const t = useT();
	const locale = uiLocale();
	const position = wait.position.toLocaleString(locale);
	// A memory reading that failed lately has no figures to give (byte counts are the last good ones, 0 before any).
	const text =
		wait.pressure === "unknown"
			? t("chat.memoryWaitUnknown", { position })
			: t("chat.memoryWait", {
					free: (wait.availableBytes / GIB).toLocaleString(locale, { maximumFractionDigits: 1 }),
					total: Math.round(wait.totalBytes / GIB).toLocaleString(locale),
					position,
				});
	return (
		<div
			className="omp-status-turn flex flex-col gap-1.5 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-4 text-sc-md text-(--sc-text-muted)"
			data-memory-wait
			data-pressure={wait.pressure}
		>
			<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{text}
			</span>
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				<MemoryStick aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="text-(--sc-text-secondary)">{text}</span>
			</div>
			<div className="flex flex-wrap items-center gap-2 ps-6">
				<Button
					onClick={() => {
						window.omp.memory
							.startNow(tabId)
							.catch((cause: unknown) => toastError({ title: t("chat.memoryWaitStartFailed"), error: cause }));
					}}
					size="sm"
					variant="ghost"
				>
					{t("chat.memoryWaitStartNow")}
				</Button>
			</div>
		</div>
	);
}
