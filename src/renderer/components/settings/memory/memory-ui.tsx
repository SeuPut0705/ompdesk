/** Small pieces the Memory tabs share: the write wrapper (toast + bump), the list frame, a read-error line. */
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useT } from "../../../lib/i18n";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { toast, toastError } from "../../../stores/toast";
import { Button, InlineNotice } from "../../common";

/**
 * Runs one write through `window.omp.aiMemory`: `busy` names the running action (buttons show it), a success toasts
 * `done` and bumps the page's version so every list reads again, a failure toasts the cause.
 */
export function useMemoryAction() {
	const t = useT();
	const [busy, setBusy] = useState<string | null>(null);
	const run = useCallback(
		async <T,>(name: string, work: () => Promise<T>, done?: string): Promise<T | undefined> => {
			setBusy(name);
			try {
				const result = await work();
				useMemoryPageStore.getState().bump();
				if (done) toast({ variant: "success", message: done });
				return result;
			} catch (error) {
				toastError({ title: t("memory.actionFailed"), error });
				return undefined;
			} finally {
				setBusy(null);
			}
		},
		[t],
	);
	return { busy, run };
}

/** The bounded frame a list/detail pair sits in on the Settings page (the phone shows one pane at a time). */
export function MemoryFrame({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-[min(34rem,70vh)] min-h-64 flex-col overflow-hidden rounded-(--sc-radius-md) border border-(--sc-divider)">
			{children}
		</div>
	);
}

export function ReadError({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
	const t = useT();
	if (!error) return null;
	return (
		<InlineNotice
			action={
				onRetry ? (
					<Button onClick={onRetry} size="sm" variant="secondary">
						{t("common.retry")}
					</Button>
				) : undefined
			}
			detail={error}
			title={t("memory.readFailed")}
			tone="danger"
		/>
	);
}

/** One muted line (empty list, nothing found). */
export function MutedLine({
	children,
	...rest
}: { children: ReactNode } & Record<`data-${string}`, string | undefined>) {
	return (
		<p className="px-1 py-2 text-sc-sm text-(--sc-text-muted)" {...rest}>
			{children}
		</p>
	);
}

export const LIST_ROW =
	"flex min-h-10 w-full min-w-0 [html[data-input=touch]_&]:min-h-11 items-center gap-2 rounded-(--sc-radius-sm) px-2 py-1.5 text-left text-sc-sm text-(--sc-text) transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-hover) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-offset-(--sc-focus-offset) focus-visible:outline-(--sc-focus-ring) aria-pressed:bg-(--sc-selected)";
