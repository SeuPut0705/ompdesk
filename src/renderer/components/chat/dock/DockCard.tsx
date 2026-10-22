/**
 * DockCard: shared chrome for the center-dock live cards (todo/plan)
 * mounted between the transcript and the composer. Collapse state lives in
 * the ui store so it survives card unmounts (tab switches, content-driven
 * hide/show); the todo card starts collapsed to ONE header line: title, then
 * the `peek` (progress, current item) in place of the count badge, so a
 * collapsed card costs a single row above the composer. `focusDockCard(id)`
 * deep links expand the card and flash a ring — that is how command-palette
 * entries (todo edit, plan-review) land here now that the workspace drawer no
 * longer carries these surfaces.
 */

import { ArrowLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { type DockCardId, isDockCardCollapsed, useUiStore } from "../../../stores/ui";
import { Button } from "../../common";
import { useWorkspaceDockFocus } from "./WorkspaceDockFocus";

interface DockCardProps {
	id: DockCardId;
	icon: LucideIcon;
	title: string;
	/** Summary chip rendered after the title (counts, status). */
	badge?: ReactNode;
	/** Right-side header controls (view toggles, refresh buttons). */
	actions?: ReactNode;
	/** At-a-glance summary that replaces the badge while collapsed (progress, current item). */
	peek?: ReactNode;
	/** Body content; WorkspaceDock owns vertical scrolling for every card. */
	children: ReactNode;
}

/** How long the accent ring lingers after a focusDockCard deep link. */
const FOCUS_FLASH_MS = 1200;

export function DockCard({ id, icon: Icon, title, badge, actions, peek, children }: DockCardProps) {
	const t = useT();
	const peekId = useId();
	const collapsed = useUiStore(s => isDockCardCollapsed(s.dockCollapsed, id));
	const toggleDockCard = useUiStore(s => s.toggleDockCard);
	const { managed, focusedCard, clearFocus } = useWorkspaceDockFocus();
	const focused = managed && focusedCard === id;
	const hiddenForFocus = managed && focusedCard !== null && !focused;
	const expanded = focused || (!hiddenForFocus && !collapsed);
	const showPeek = !expanded && peek != null;
	const focusSeq = useUiStore(s => (s.dockFocus?.id === id ? s.dockFocus.seq : 0));
	const [flash, setFlash] = useState(false);
	const flashTimer = useRef<number | undefined>(undefined);
	const seenSeq = useRef(focusSeq);

	useEffect(() => {
		if (focusSeq === seenSeq.current) return;
		seenSeq.current = focusSeq;
		clearFocus();
		setFlash(true);
		clearTimeout(flashTimer.current);
		flashTimer.current = window.setTimeout(() => setFlash(false), FOCUS_FLASH_MS);
		return () => clearTimeout(flashTimer.current);
	}, [clearFocus, focusSeq]);

	const toggle = () => {
		if (hiddenForFocus) {
			clearFocus();
			if (collapsed) toggleDockCard(id);
			return;
		}
		if (focused) {
			clearFocus();
			if (!collapsed) toggleDockCard(id);
			return;
		}
		toggleDockCard(id);
	};

	return (
		<section
			data-dock-card={id}
			aria-label={title}
			className={cx(
				"omp-fade-up shrink-0 overflow-clip rounded-(--sc-radius-lg) border bg-(--sc-elevated) transition-shadow duration-(--sc-duration-med)",
				flash ? "border-(--sc-accent) ring-2 ring-(--sc-accent-soft)" : "border-(--sc-border-subtle)",
				hiddenForFocus && "opacity-75",
			)}
			data-dock-focused={focused || undefined}
			data-dock-expanded={expanded || undefined}
		>
			<div className="sticky top-0 z-10 flex min-h-10 items-center gap-2 bg-(--sc-elevated) px-3 py-1">
				<button
					aria-describedby={showPeek ? peekId : undefined}
					aria-expanded={expanded}
					aria-label={expanded ? t("dock.collapse") : t("dock.expand")}
					className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-(--sc-radius-sm) text-left focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
					onClick={toggle}
					type="button"
				>
					<Icon aria-hidden="true" className="shrink-0 text-(--sc-text-muted)" size={16} />
					<span className="shrink-0 text-sc-md font-medium whitespace-nowrap text-(--sc-text)">{title}</span>
					{showPeek ? (
						<span
							className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-sc-sm text-(--sc-text-muted)"
							data-testid={`dock-peek-${id}`}
							id={peekId}
						>
							{peek}
						</span>
					) : (
						<>
							{badge && (
								<span className="flex min-w-0 items-center text-sc-sm text-(--sc-text-muted)">{badge}</span>
							)}
							<span className="min-w-1 flex-1" />
						</>
					)}
					<ChevronRight
						aria-hidden="true"
						className="omp-disclosure-chevron shrink-0 text-(--sc-text-subtle)"
						size={14}
						style={{ transform: expanded ? "rotate(90deg)" : undefined }}
					/>
				</button>
				{!hiddenForFocus && focused && (
					<Button icon={<ArrowLeft />} onClick={clearFocus} size="sm" variant="ghost">
						{t("dock.backToSummary")}
					</Button>
				)}
				{!hiddenForFocus && actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
			</div>
			{expanded && <div className="border-t border-(--sc-border-subtle)">{children}</div>}
		</section>
	);
}
