/**
 * An image in the transcript that opens full size on click. The thumbnail is a
 * button (keyboard reachable); the viewer is a chromeless Modal, so Escape, a
 * backdrop click and focus return come from the shared modal layer. The viewer
 * covers the chat pane the image sits in (sidebar and side panel stay visible),
 * or the window when the image is outside a pane. The picture fits that area;
 * a click toggles actual size (scrollable) for screenshots whose detail the
 * fit scale hides.
 */
import { X } from "lucide-react";
import { type ImgHTMLAttributes, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IconButton } from "./IconButton";
import { Modal } from "./Modal";

export interface ZoomableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onClick"> {
	src: string;
	alt: string;
}

export function ZoomableImage({ src, alt, className, ...imgProps }: ZoomableImageProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [actualSize, setActualSize] = useState(false);
	const thumbRef = useRef<HTMLButtonElement>(null);
	const [pane, setPane] = useState<HTMLElement | null>(null);
	const close = () => {
		setOpen(false);
		setActualSize(false);
	};
	return (
		<>
			<button
				aria-label={t("image.zoom", { name: alt })}
				className="inline-block max-w-full cursor-zoom-in rounded-(--sc-radius-md) p-0 align-top focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--sc-accent)"
				data-zoomable-image
				onClick={() => {
					setPane(thumbRef.current?.closest<HTMLElement>(".omp-session-pane") ?? null);
					setOpen(true);
				}}
				ref={thumbRef}
				type="button"
			>
				<img {...imgProps} alt={alt} className={className} src={src} />
			</button>
			<Modal
				ariaLabel={alt}
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
				<IconButton
					className="absolute top-2 right-2 z-10 bg-(--sc-elevated)"
					icon={<X />}
					label={t("common.close")}
					onClick={close}
					size="sm"
				/>
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
						alt={alt}
						// Fit fills the window (small pictures scale up: that is the point of
						// enlarging); actual size shows natural pixels and scrolls.
						className={actualSize ? "max-w-none" : "h-full w-full object-contain"}
						src={src}
					/>
				</button>
			</Modal>
		</>
	);
}
