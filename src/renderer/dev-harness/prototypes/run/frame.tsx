/**
 * The fake chat pane the prototypes sit in: a 36/40 px header, a transcript pinned to its bottom the way the app's
 * tail follower pins it (so a composer that grows shows up as the transcript scrolling), the composer slot, and
 * `ComposerShell`, the real `omp-composer-*` markup with a slot for what each variant changes.
 */

import { type CSSProperties, type ReactNode, useLayoutEffect, useRef } from "react";
import { Button, Spinner } from "../../../components/common";
import { cx } from "../../../lib/format";
import type { Store, Variant } from "./model";
import { Field, LiveRegion, ToolbarLeft, useIsPhone } from "./parts";
import { useP } from "./strings";

export interface FrameSize {
	width: number;
	height: number;
}

function Header({ store }: { store: Store }) {
	const p = useP();
	const phone = useIsPhone();
	const { s } = store;
	let status = p("frame.ready");
	if (s.stopPending) status = p("frame.stopping");
	else if (s.running && s.ask !== "none") status = p("frame.needsInput");
	else if (s.running) status = p("frame.working");
	return (
		<>
			<header
				className={cx(
					"flex shrink-0 items-center gap-3 border-b border-(--sc-border-subtle) px-3",
					phone ? "h-9" : "h-10",
				)}
				data-proto-header
			>
				<span className="min-w-0 flex-1 truncate text-sc-md font-medium text-(--sc-text)">{p("frame.title")}</span>
				<span className="flex items-center gap-1.5 text-sc-xs text-(--sc-text-muted)" data-proto-status>
					<span
						aria-hidden
						className={cx(
							"size-1.5 rounded-full",
							s.running && s.ask === "none"
								? "bg-(--sc-accent)"
								: s.ask !== "none"
									? "bg-(--sc-warning)"
									: "bg-(--sc-text-subtle)",
						)}
					/>
					{status}
				</span>
			</header>
			{phone && (
				<div className="mx-3 mt-0.5 mb-1 flex h-7 shrink-0 items-center rounded-(--sc-radius-md) bg-(--sc-surface-2) px-2.5 text-sc-xs text-(--sc-text-muted)">
					{p("msg.tool")}
				</div>
			)}
		</>
	);
}

function Transcript({ store }: { store: Store }) {
	const p = useP();
	const ref = useRef<HTMLDivElement>(null);
	const { s } = store;
	// Pinned to the bottom like the real transcript: whenever the scroller changes size it follows the tail.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const pin = () => {
			el.scrollTop = el.scrollHeight;
		};
		pin();
		const observer = new ResizeObserver(pin);
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => observer.disconnect();
	}, []);
	return (
		<div className="omp-transcript-scroll min-h-0 flex-1 overflow-y-auto" data-proto-transcript ref={ref}>
			<div className="omp-column omp-column-reading flex flex-col gap-3 py-3">
				{[0, 1, 2, 3, 4, 5, 6, 7].map(turn => (
					<div className="flex flex-col gap-3" key={turn}>
						<div className="omp-user-bubble self-end rounded-(--sc-radius-lg) bg-(--sc-surface-2) px-3 py-2 text-sc-md text-(--sc-text)">
							{p("msg.user")}
						</div>
						<p className="text-sc-md text-(--sc-text)">{p("msg.assistant1")}</p>
						<div className="rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2 text-sc-sm text-(--sc-text-muted)">
							{p("msg.tool")}
						</div>
						<p className="text-sc-md text-(--sc-text)">{p("msg.assistant2")}</p>
					</div>
				))}
				<p className="flex items-center gap-2 text-sc-md text-(--sc-text-muted)" data-proto-last>
					{s.running && <Spinner size="sm" />}
					{s.running ? p("msg.working") : p("frame.ready")}
				</p>
			</div>
		</div>
	);
}

export function Frame({
	variant,
	size,
	store,
	children,
}: {
	variant: Variant;
	size: FrameSize;
	store: Store;
	children: ReactNode;
}) {
	const style: CSSProperties = { width: size.width, height: size.height };
	return (
		<div
			className="omp-workspace-main omp-session-pane relative flex shrink-0 flex-col overflow-hidden border border-(--sc-border-subtle) bg-(--sc-bg)"
			data-proto-frame={variant}
			style={style}
		>
			<Header store={store} />
			<Transcript store={store} />
			{children}
		</div>
	);
}

/** A question or approval waiting above the composer (the same card in every variant). */
function AskCard({ store }: { store: Store }) {
	const { s } = store;
	if (s.ask === "none") return null;
	return (
		<div
			className="omp-prompt-card mb-2 flex items-center gap-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-warning-soft) px-3 py-2 text-sc-sm text-(--sc-text)"
			data-proto-ask={s.ask}
		>
			<span className="min-w-0 flex-1">{s.ask === "question" ? "Which backoff cap?" : "Run `bun test sync`?"}</span>
			<Button size="sm" variant="secondary">
				{s.ask === "question" ? "30 s" : "Allow"}
			</Button>
			<Button size="sm" variant="ghost">
				{s.ask === "question" ? "60 s" : "Deny"}
			</Button>
		</div>
	);
}

export interface ShellSlots {
	store: Store;
	/** Above the box, attached to its top edge (A's tray). */
	tray?: ReactNode;
	/** Inside the box above the field (restored chips, banners). */
	aboveField?: ReactNode;
	/** Inside the box between field and toolbar (B's ghost rows). */
	belowField?: ReactNode;
	/** After the left toolbar controls, before the spacer (C's queue pill goes in the cluster instead). */
	toolbarExtra?: ReactNode;
	/** The right-hand cluster: Stop, Send and whatever the variant adds. */
	cluster: ReactNode;
	fieldEdits?: boolean;
}

export function ComposerShell({
	store,
	tray,
	aboveField,
	belowField,
	toolbarExtra,
	cluster,
	fieldEdits = false,
}: ShellSlots) {
	const { s } = store;
	return (
		<div className="omp-composer-region relative shrink-0 bg-transparent pt-1 pb-3" data-proto-composer>
			<div className="omp-composer-shell relative w-full">
				<AskCard store={store} />
				{tray}
				<div className="omp-composer-anchor relative">
					<div
						className="omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)"
						data-composer-draft={s.draft.trim() !== "" || undefined}
						data-proto-composer-box
					>
						{aboveField}
						<Field fieldEdits={fieldEdits} store={store} />
						{belowField}
						<div
							aria-label="Composer controls"
							className="omp-composer-toolbar flex min-h-11 flex-wrap items-center gap-1 pr-2.5 pb-2.5 pl-2"
							data-proto-toolbar
							role="toolbar"
						>
							<ToolbarLeft />
							{toolbarExtra}
							<div className="flex-1" />
							<div
								className="omp-composer-send-cluster flex shrink-0 items-center gap-1 [&>*]:!inline-flex"
								data-proto-cluster
							>
								{cluster}
							</div>
						</div>
					</div>
				</div>
				<LiveRegion store={store} />
			</div>
		</div>
	);
}
