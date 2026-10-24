/**
 * An image in the transcript that opens full size on click. The thumbnail is a
 * button (keyboard reachable); the viewer is a chromeless Modal, so Escape, a
 * backdrop click and focus return come from the shared modal layer. The viewer
 * covers the chat pane the image sits in (sidebar and side panel stay visible),
 * or the window when the image is outside a pane, under a bar of its own (name,
 * position, open in default app, close) that keeps clear of the window's own
 * controls. The picture fits that area;
 * a click toggles actual size (scrollable) for screenshots whose detail the
 * fit scale hides. On a touch screen, whose page never zooms, two fingers zoom
 * the picture, one finger moves it and a tap zooms in or back (`use-pinch-view`). With a `gallery` (every picture of one message or result),
 * the viewer steps through it with ←/→ and its buttons; a picture that is a
 * file (`path`) also opens in the system's default app. Right-click offers
 * open, copy, save as (and default app / remove when they apply).
 */
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Maximize2, Trash2, X } from "lucide-react";
import { type ImgHTMLAttributes, type KeyboardEvent, type Ref, useImperativeHandle, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { copyImage, saveImage } from "../../lib/image-actions";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast, toastError } from "../../stores/toast";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { IconButton } from "./IconButton";
import { Modal } from "./Modal";
import { usePinchView } from "./use-pinch-view";

export interface GalleryImage {
	src: string;
	alt: string;
	/** The file behind the picture, when there is one. */
	path?: string;
}

/** What a toolbar can ask of a picture it sits beside. */
export interface ZoomableImageHandle {
	/** Open the full-size viewer. */
	open: () => void;
}

export interface ZoomableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onClick"> {
	src: string;
	alt: string;
	/** The file behind the picture: the viewer offers "Open in default app". */
	path?: string;
	/** Every picture this one belongs with, in order (it is one of them, matched by `src`). */
	gallery?: readonly GalleryImage[];
	/** A picture the user can still take back (a composer attachment): the menu offers Remove. */
	onRemove?: () => void;
	/** Classes for the thumbnail button (the zoom target around the picture). */
	thumbClassName?: string;
	/** Lets a toolbar elsewhere (a figure's header) open the viewer. */
	handleRef?: Ref<ZoomableImageHandle>;
}

export function ZoomableImage({
	src,
	alt,
	path,
	gallery,
	onRemove,
	className,
	thumbClassName,
	handleRef,
	...imgProps
}: ZoomableImageProps) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const [open, setOpen] = useState(false);
	const [actualSize, setActualSize] = useState(false);
	const pinch = usePinchView();
	const [index, setIndex] = useState(0);
	const thumbRef = useRef<HTMLButtonElement>(null);
	const [pane, setPane] = useState<HTMLElement | null>(null);
	const items: readonly GalleryImage[] = gallery && gallery.length > 1 ? gallery : [{ src, alt, path }];
	const shown = items[Math.min(index, items.length - 1)] ?? { src, alt, path };
	// The bar names the file when there is one, else the picture's own description.
	const viewerName = shown.path ? (shown.path.split(/[\\/]/).pop() ?? shown.path) : shown.alt;
	const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
	const close = () => {
		setOpen(false);
		setActualSize(false);
		pinch.reset();
	};
	const openViewer = () => {
		setPane(thumbRef.current?.closest<HTMLElement>(".omp-session-pane") ?? null);
		setIndex(
			Math.max(
				0,
				items.findIndex(item => item.src === src),
			),
		);
		setOpen(true);
	};
	useImperativeHandle(handleRef, () => ({ open: openViewer }));
	const menuItems = (): ContextMenuItem[] => [
		{ id: "open", label: t("image.menu.open"), icon: Maximize2, onSelect: openViewer },
		...(path
			? [
					{
						id: "default-app",
						label: t("image.openDefault"),
						icon: ExternalLink,
						onSelect: () => void openInDefaultApp(path),
					},
				]
			: []),
		{
			id: "copy",
			label: t("image.menu.copy"),
			icon: Copy,
			separatorBefore: true,
			onSelect: () =>
				void copyImage(src).then(
					() => toast({ variant: "success", message: t("image.copied") }),
					cause => toastError({ title: t("image.copyFailed"), error: cause }),
				),
		},
		{
			id: "save",
			label: t("image.menu.save"),
			icon: Download,
			onSelect: () =>
				void saveImage(src, path ?? alt).then(
					result => {
						if (result.error) toastError({ title: t("image.saveFailed"), error: result.error });
					},
					cause => toastError({ title: t("image.saveFailed"), error: cause }),
				),
		},
		...(onRemove
			? [
					{
						id: "remove",
						label: t("image.menu.remove"),
						icon: Trash2,
						danger: true,
						separatorBefore: true,
						onSelect: onRemove,
					},
				]
			: []),
	];
	const step = (by: number) => {
		setIndex(current => (current + by + items.length) % items.length);
		setActualSize(false);
		pinch.reset();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (items.length < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
		event.preventDefault();
		step(event.key === "ArrowLeft" ? -1 : 1);
	};
	const openInDefaultApp = async (file: string) => {
		try {
			const result = await window.omp.system.openPath(file, tabId ?? undefined);
			if (!result.ok) toastError({ title: t("image.openFailed"), error: result.error });
		} catch (cause) {
			toastError({ title: t("image.openFailed"), error: cause });
		}
	};
	return (
		<>
			<button
				aria-label={t("image.zoom", { name: alt })}
				className={cx(
					"inline-block max-w-full cursor-zoom-in rounded-(--sc-radius-md) p-0 align-top focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--sc-accent)",
					thumbClassName,
				)}
				data-zoomable-image
				onClick={openViewer}
				onContextMenu={event => {
					event.preventDefault();
					setMenuAt({ x: event.clientX, y: event.clientY });
				}}
				ref={thumbRef}
				type="button"
			>
				<img {...imgProps} alt={alt} className={className} src={src} />
			</button>
			{menuAt && (
				<ContextMenu
					ariaLabel={t("image.menu.label")}
					// ContextMenu leaves closing to its owner: a choice closes the menu first.
					items={menuItems().map(item => ({
						...item,
						onSelect: () => {
							setMenuAt(null);
							item.onSelect();
						},
					}))}
					onClose={() => setMenuAt(null)}
					x={menuAt.x}
					y={menuAt.y}
				/>
			)}
			<Modal
				ariaLabel={shown.alt}
				bodyClassName="flex flex-col overflow-hidden p-0"
				chromeless
				container={pane}
				onClose={close}
				open={open}
				panelClassName={cx(
					"max-w-none bg-(--sc-bg)",
					// `!`: the full size's own rule (100dvh − 2rem, unlayered) would otherwise outgrow a pane under the title
					// bar and cut the viewer's bottom edge off.
					pane ? "h-full! w-full! max-h-full!" : "h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)]",
				)}
				size="full"
			>
				{/* ←/→ step the gallery from anywhere inside the viewer; the buttons stay the accessible path. */}
				<div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
					{/* The viewer's own bar, so its close never reads as the window's. A viewer over the window clears the
					    caption buttons (Windows, top right) and the traffic lights (macOS, top left) drawn over it. */}
					<div
						className="omp-image-viewer-head flex h-10 shrink-0 items-center gap-1 border-b border-(--sc-divider) bg-(--sc-elevated) px-2"
						data-image-viewer-head
						style={
							pane
								? undefined
								: {
										paddingLeft: "max(var(--sc-space-2), var(--sc-traffic-lights))",
										paddingRight: "calc(var(--sc-space-2) + var(--sc-caption-buttons))",
									}
						}
					>
						<span
							className="min-w-0 flex-1 truncate pl-1 text-sc-sm text-(--sc-text-secondary)"
							title={viewerName}
						>
							{viewerName}
						</span>
						{items.length > 1 && (
							<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)">
								{t("image.position", { index: index + 1, total: items.length })}
							</span>
						)}
						{shown.path && (
							<IconButton
								icon={<ExternalLink />}
								label={t("image.openDefault")}
								onClick={() => shown.path && void openInDefaultApp(shown.path)}
								size="sm"
							/>
						)}
						<IconButton icon={<X />} label={t("common.close")} onClick={close} size="sm" />
					</div>
					{/* Clear of a phone's or tablet's home bar. */}
					<div className="relative mb-(--safe-b,0px) min-h-0 flex-1">
						{/* A pinched picture overflows by its transform: clipped, never scrolled (its own pan moves it). */}
						<div className={cx("absolute inset-0 flex", pinch.zoomed ? "overflow-hidden" : "overflow-auto")}>
							<button
								aria-label={t(actualSize ? "image.fit" : "image.actualSize")}
								aria-pressed={actualSize}
								className={cx(
									"m-auto p-0",
									actualSize
										? "cursor-zoom-out"
										: "flex h-full w-full cursor-zoom-in items-center justify-center",
								)}
								data-image-viewer
								data-pinch-zoomed={pinch.zoomed || undefined}
								onClick={event => {
									if (!pinch.touchClick(event.currentTarget)) setActualSize(value => !value);
								}}
								// The fitted picture takes every finger itself (zoom, move); actual size scrolls natively.
								style={actualSize ? undefined : { touchAction: "none" }}
								type="button"
								{...(actualSize ? {} : pinch.handlers)}
							>
								<img
									alt={shown.alt}
									// Fit fills the window (small pictures scale up: that is the point of
									// enlarging); actual size shows natural pixels and scrolls.
									className={actualSize ? "max-w-none" : "h-full w-full object-contain"}
									src={shown.src}
									style={
										pinch.zoomed && !actualSize
											? {
													transform: `translate(${pinch.view.x}px, ${pinch.view.y}px) scale(${pinch.view.scale})`,
													transformOrigin: "0 0",
												}
											: undefined
									}
								/>
							</button>
						</div>
						{items.length > 1 && (
							<>
								<IconButton
									className="absolute top-1/2 left-2 z-10 -translate-y-1/2 bg-(--sc-elevated)"
									icon={<ChevronLeft />}
									label={t("image.previous")}
									onClick={() => step(-1)}
									size="sm"
								/>
								<IconButton
									className="absolute top-1/2 right-2 z-10 -translate-y-1/2 bg-(--sc-elevated)"
									icon={<ChevronRight />}
									label={t("image.next")}
									onClick={() => step(1)}
									size="sm"
								/>
							</>
						)}
					</div>
				</div>
			</Modal>
		</>
	);
}
