/**
 * An image in the transcript that opens full size on click. The thumbnail is a
 * button (keyboard reachable); the viewer is a chromeless Modal, so Escape, a
 * backdrop click and focus return come from the shared modal layer. The viewer
 * covers the chat pane the image sits in (sidebar and side panel stay visible),
 * or the window when the image is outside a pane. The picture fits that area;
 * a click toggles actual size (scrollable) for screenshots whose detail the
 * fit scale hides. With a `gallery` (every picture of one message or result),
 * the viewer steps through it with ←/→ and its buttons; a picture that is a
 * file (`path`) also opens in the system's default app.
 */
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { type ImgHTMLAttributes, type KeyboardEvent, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toastError } from "../../stores/toast";
import { IconButton } from "./IconButton";
import { Modal } from "./Modal";

export interface GalleryImage {
	src: string;
	alt: string;
	/** The file behind the picture, when there is one. */
	path?: string;
}

export interface ZoomableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onClick"> {
	src: string;
	alt: string;
	/** The file behind the picture: the viewer offers "Open in default app". */
	path?: string;
	/** Every picture this one belongs with, in order (it is one of them, matched by `src`). */
	gallery?: readonly GalleryImage[];
}

export function ZoomableImage({ src, alt, path, gallery, className, ...imgProps }: ZoomableImageProps) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const [open, setOpen] = useState(false);
	const [actualSize, setActualSize] = useState(false);
	const [index, setIndex] = useState(0);
	const thumbRef = useRef<HTMLButtonElement>(null);
	const [pane, setPane] = useState<HTMLElement | null>(null);
	const items: readonly GalleryImage[] = gallery && gallery.length > 1 ? gallery : [{ src, alt, path }];
	const shown = items[Math.min(index, items.length - 1)] ?? { src, alt, path };
	const close = () => {
		setOpen(false);
		setActualSize(false);
	};
	const step = (by: number) => {
		setIndex(current => (current + by + items.length) % items.length);
		setActualSize(false);
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
				className="inline-block max-w-full cursor-zoom-in rounded-(--sc-radius-md) p-0 align-top focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--sc-accent)"
				data-zoomable-image
				onClick={() => {
					setPane(thumbRef.current?.closest<HTMLElement>(".omp-session-pane") ?? null);
					setIndex(
						Math.max(
							0,
							items.findIndex(item => item.src === src),
						),
					);
					setOpen(true);
				}}
				ref={thumbRef}
				type="button"
			>
				<img {...imgProps} alt={alt} className={className} src={src} />
			</button>
			<Modal
				ariaLabel={shown.alt}
				bodyClassName="relative flex items-center justify-center overflow-auto p-0"
				chromeless
				container={pane}
				onClose={close}
				open={open}
				panelClassName={cx(
					"max-w-none bg-(--sc-bg)",
					pane ? "h-full w-full max-h-full" : "h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)]",
				)}
				size="full"
			>
				{/* ←/→ step the gallery from anywhere inside the viewer; the buttons stay the accessible path. */}
				<div className="contents" onKeyDown={onKeyDown}>
					<div className="absolute top-2 right-2 z-10 flex items-center gap-1">
						{items.length > 1 && (
							<span className="rounded-(--sc-radius-full) bg-(--sc-elevated) px-2 text-sc-xs tabular-nums text-(--sc-text-secondary)">
								{t("image.position", { index: index + 1, total: items.length })}
							</span>
						)}
						{shown.path && (
							<IconButton
								className="bg-(--sc-elevated)"
								icon={<ExternalLink />}
								label={t("image.openDefault")}
								onClick={() => shown.path && void openInDefaultApp(shown.path)}
								size="sm"
							/>
						)}
						<IconButton
							className="bg-(--sc-elevated)"
							icon={<X />}
							label={t("common.close")}
							onClick={close}
							size="sm"
						/>
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
					<button
						aria-label={t(actualSize ? "image.fit" : "image.actualSize")}
						aria-pressed={actualSize}
						className={cx(
							"m-auto p-0",
							actualSize ? "cursor-zoom-out" : "flex h-full w-full cursor-zoom-in items-center justify-center",
						)}
						data-image-viewer
						onClick={() => setActualSize(value => !value)}
						type="button"
					>
						<img
							alt={shown.alt}
							// Fit fills the window (small pictures scale up: that is the point of
							// enlarging); actual size shows natural pixels and scrolls.
							className={actualSize ? "max-w-none" : "h-full w-full object-contain"}
							src={shown.src}
						/>
					</button>
				</div>
			</Modal>
		</>
	);
}
