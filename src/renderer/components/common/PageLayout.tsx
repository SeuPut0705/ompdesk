/**
 * PageLayout — the frame of a destination page in the main area (Agents,
 * Insights; design-spec §2.1/§3): page header (title, one-line description,
 * page actions), optional Tabs row, then the body. Gutters follow the spec
 * (24px, 40px from 1280px window width).
 *
 * - `body="scroll"` (default): the body scrolls inside the page and centers
 *   its content at a readable max width.
 * - `body="fill"`: the body is a full-height flex column for split views
 *   (list + detail) that manage their own scrolling.
 * The shell renders the back affordance; pages don't add one.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";

export interface PageLayoutProps {
	title: ReactNode;
	description?: ReactNode;
	/** Page-level actions, right-aligned in the header. */
	actions?: ReactNode;
	/** The page's Tabs (underline), rendered under the header. */
	tabs?: ReactNode;
	body?: "scroll" | "fill";
	/** Accessible name of the body when it is the active tab's panel (role="tabpanel"). */
	panelLabel?: string;
	className?: string;
	children: ReactNode;
}

const GUTTER = "px-6 min-[1280px]:px-10";

export function PageLayout({
	title,
	description,
	actions,
	tabs,
	body = "scroll",
	panelLabel,
	className,
	children,
}: PageLayoutProps) {
	return (
		<div className={cx("flex min-h-0 flex-1 flex-col bg-(--sc-bg)", className)}>
			<header className={cx("shrink-0 pt-6", GUTTER, !tabs && "pb-4")}>
				<div className="flex flex-wrap items-end gap-x-6 gap-y-3">
					<div className="min-w-0 flex-1">
						<h1 className="text-sc-2xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)">{title}</h1>
						{description && <p className="mt-1 text-sc-sm text-(--sc-text-muted)">{description}</p>}
					</div>
					{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
				</div>
				{tabs && <div className="mt-4">{tabs}</div>}
			</header>
			<div
				aria-label={panelLabel}
				className={cx("min-h-0 flex-1", body === "scroll" ? "overflow-y-auto" : "flex flex-col")}
				role={panelLabel ? "tabpanel" : undefined}
			>
				{body === "scroll" ? (
					<div className={cx("mx-auto w-full max-w-6xl py-6", GUTTER)}>{children}</div>
				) : (
					children
				)}
			</div>
		</div>
	);
}
