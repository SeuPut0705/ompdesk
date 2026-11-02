import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import { cx } from "../../../lib/format";
import { motionEase, motionMs } from "../../../lib/motion";

/**
 * A project group the user can drag to a new place. Pointer-only, armed after a
 * short move so a plain click still toggles the group; the group menu's
 * "위로/아래로 이동" is the keyboard path.
 */
export function SortableProject({
	id,
	disabled,
	className = "mt-2 first:mt-0",
	children,
}: {
	id: string;
	disabled: boolean;
	/** The wrapper's spacing: this computer's projects sit apart, a host's stack flush. */
	className?: string;
	children: (dragHandle: Record<string, unknown>) => ReactNode;
}) {
	// The siblings making room glide on the reflow tokens, like every other list move.
	const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
		id,
		disabled,
		transition: { duration: motionMs("med"), easing: motionEase("spring") },
	});
	return (
		<div
			className={cx(className, isDragging && "relative z-(--sc-z-raised) opacity-80")}
			data-dragging={isDragging || undefined}
			ref={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
		>
			{children(listeners ?? {})}
		</div>
	);
}
