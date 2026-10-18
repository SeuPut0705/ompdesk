import { useT } from "../../lib/i18n";

/**
 * The muted "← <parent title>" after a forked session's own title (sidebar row, title bar): a fork that kept its
 * parent's title must not read as a second copy of it. Decorative; the surface names the origin in words
 * (`SessionForkOrigin.label` / `.tooltip`).
 */
export function ForkParent({ name }: { name: string }) {
	const t = useT();
	return (
		<span
			aria-hidden
			className="ml-1.5 min-w-0 truncate font-normal text-sc-xs text-(--sc-text-subtle)"
			data-fork-parent
		>
			{t("session.fork.from", { name })}
		</span>
	);
}
