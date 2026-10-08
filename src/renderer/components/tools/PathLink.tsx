import type { ReactNode } from "react";
import { ipcErrorCode } from "../../../shared/ipc-error-codes";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";

/**
 * A file path rendered as an editor-open link. Reads as plain monospace text
 * inside tool-card headers; hover reveals the affordance. Opening goes through
 * the main process (`system:open-path`) for the tab the link belongs to:
 * relative paths resolve against that tab's workspace, failures fall back to
 * revealing the file, only hard failures toast. A remote tab's file lives on
 * its host, which no native app here can open (`remote_path_native`): it
 * opens in the in-app file preview instead, whose reads are forwarded to the
 * host. Events stop at the link so a surrounding disclosure row does not
 * toggle when the user meant to open the file.
 */
export function PathLink({ path, children, className }: { path: string; children?: ReactNode; className?: string }) {
	const t = useT();
	const tabId = useRuntimeTabId();
	if (!path) return <span className={className}>{children}</span>;

	const open = async () => {
		try {
			const result = await (tabId ? window.omp.system.openPath(path, tabId) : window.omp.system.openPath(path));
			if (result?.ok) return;
			if (result?.code === "remote_path_native") {
				useUiStore.getState().openFilePreview(path);
				return;
			}
			toastError({ title: t("tools.path.openFailed"), error: result?.error ? result : path });
		} catch (cause) {
			if (ipcErrorCode(cause) === "remote_path_native") {
				useUiStore.getState().openFilePreview(path);
				return;
			}
			toastError({ title: t("tools.path.openFailed"), error: cause });
		}
	};

	return (
		<button
			type="button"
			title={path}
			onClick={event => {
				event.stopPropagation();
				void open();
			}}
			className={cx(
				"min-w-0 cursor-pointer rounded-sm text-left transition-colors hover:text-[var(--omp-accent)] hover:underline hover:decoration-[var(--omp-accent)]/50 hover:underline-offset-2",
				className,
			)}
		>
			{children ?? path}
		</button>
	);
}
