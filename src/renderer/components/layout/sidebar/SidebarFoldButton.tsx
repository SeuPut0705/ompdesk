import { ChevronDown, ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../../../lib/format";

const BASE =
	"flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-sm font-medium outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)";

export interface SidebarFoldButtonProps extends Omit<ComponentProps<"button">, "type"> {
	folded: boolean;
	/** The section's glyph after the chevron (a folder, the chats bubble). */
	icon: ReactNode;
}

/**
 * The toggle of a sidebar group's header row (a project, a paired host's project, the Chats section): chevron, glyph,
 * then the caller's name and marks. The row around it holds the hover wash and the header's own buttons.
 */
export function SidebarFoldButton({ folded, icon, className, children, ...rest }: SidebarFoldButtonProps) {
	const Chevron = folded ? ChevronRight : ChevronDown;
	return (
		<button {...rest} aria-expanded={!folded} className={cx(BASE, className)} type="button">
			<Chevron aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			{icon}
			{children}
		</button>
	);
}
