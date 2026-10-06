import type { ReactNode } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";

/**
 * A file path rendered as an editor-open link. Reads as plain monospace text
 * inside tool-card headers; hover reveals the affordance. Opening goes through
 * the main process (`system:open-path`): relative paths resolve against the
 * workspace, failures fall back to revealing the file, only hard failures
 * toast. Events stop at the link so a surrounding disclosure row does not
 * toggle when the user meant to open the file.
 */
export function PathLink({ path, children, className }: { path: string; children?: ReactNode; className?: string }) {
	const t = useT();
	if (!path) return <span className={className}>{children}</span>;

	const open = async () => {
		try {
			const result = await window.omp.system.openPath(path);
			if (!result?.ok) {
				toast({ variant: "error", title: t("tools.path.openFailed"), message: result?.error || path });
			}
		} catch (cause) {
			toast({
				variant: "error",
				title: t("tools.path.openFailed"),
				message: cause instanceof Error ? cause.message : String(cause),
			});
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
