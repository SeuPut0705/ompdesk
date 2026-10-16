/**
 * Audio, video, pictures and documents in the transcript. Every preview reads
 * its file the way the Files viewer does, for the tab it belongs to (a paired
 * host's tab reads on that host), and only once it nears the viewport:
 * players through the shared media source (a seekable `omp-media://` stream,
 * or a host's bytes in a blob), pictures through `fs.readImage`, a PDF's first
 * page through `fs.readBinary` and pdf.js, a page through `fs.read` into an
 * empty-sandbox frame on request. A file that is missing, refused, too big or
 * undecodable shows as its chip, the way a picture whose bytes are gone does.
 */
import {
	Eye,
	EyeOff,
	FileAudio,
	FileBadge,
	FileCode,
	FileImage,
	Files,
	FileText,
	FileVideo,
	type LucideIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { basename, formatBytes } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useUiStore } from "../../../stores/ui";
import { IconButton } from "../../common/IconButton";
import { useMediaSource } from "../../panels/viewers/media-source";
import { type ChatMediaKind, type ChatReferenceKind, toolResultMedia } from "./chat-media";
import { FileChip } from "./FileChip";
import { PathLink } from "./PathLink";
import { ToolImage } from "./ToolImage";

const KIND_ICONS: Record<ChatReferenceKind, LucideIcon> = {
	video: FileVideo,
	audio: FileAudio,
	pdf: FileBadge,
	html: FileCode,
	image: FileImage,
	document: FileText,
};

/** Previews start loading this far before they scroll into view. */
const NEAR_VIEWPORT = "600px 0px";
/** A PDF thumbnail reads the whole file; past this it stays a chip. */
const PDF_THUMB_MAX_BYTES = 20 * 1024 * 1024;
/** CSS width of a PDF's first-page thumbnail. */
const PDF_THUMB_WIDTH = 176;
/** A page preview reads at most this much text (the Files viewer's first read). */
const HTML_PREVIEW_BYTES = 200_000;

/** True once the element has come within NEAR_VIEWPORT of the screen (always, without IntersectionObserver). */
export function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
	const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
	useEffect(() => {
		const element = ref.current;
		if (near || !element || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			entries => {
				if (!entries.some(entry => entry.isIntersecting)) return;
				setNear(true);
				observer.disconnect();
			},
			{ rootMargin: NEAR_VIEWPORT },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [near, ref]);
	return near;
}

/** Name (opening the file natively) and the Files viewer button, under a preview. */
function PreviewCaption({ path, name, children }: { path: string; name: string; children?: ReactNode }) {
	const t = useT();
	return (
		<span className="omp-chat-media-caption">
			<PathLink path={path} className="omp-chat-media-name font-mono">
				{name}
			</PathLink>
			{children}
			<IconButton
				icon={<Files />}
				label={t("chat.media.openInFiles")}
				onClick={event => {
					event.stopPropagation();
					useUiStore.getState().openFilePreview(path);
				}}
				size="sm"
			/>
		</span>
	);
}

/**
 * An inline player for a local audio or video file: native controls, the
 * first frame as its poster (`preload="metadata"`), never autoplaying or
 * looping, video muted until the user unmutes it.
 */
export function ChatMedia({ path, kind, label }: { path: string; kind: ChatMediaKind; label?: string }) {
	const t = useT();
	const tabId = useRuntimeTabId() ?? undefined;
	const ref = useRef<HTMLSpanElement>(null);
	const near = useNearViewport(ref);
	const state = useMediaSource(path, tabId, kind, near);
	const [failedUrl, setFailedUrl] = useState<string | null>(null);

	const name = label || basename(path) || path;
	const Icon = KIND_ICONS[kind];
	const chipIcon = <Icon aria-hidden className="omp-file-chip-icon" />;
	const url = state.status === "ready" ? state.url : undefined;
	if (state.status === "unavailable" || (url && failedUrl === url)) {
		return (
			<FileChip
				data-chat-media-unavailable={kind}
				icon={chipIcon}
				label={name}
				note={t(state.status === "unavailable" ? "chat.media.unavailable" : "chat.media.unplayable")}
				path={path}
			/>
		);
	}
	if (state.status === "tooLarge") {
		return (
			<FileChip
				data-chat-media-too-large={kind}
				icon={chipIcon}
				label={name}
				note={t("chat.media.tooLarge", { size: formatBytes(state.size) })}
				path={path}
			/>
		);
	}
	const loading = state.status === "loading";
	return (
		<span className="omp-chat-media" data-chat-media={kind} data-state={state.status} ref={ref}>
			{kind === "video" ? (
				<span className="omp-chat-media-frame" aria-busy={loading || undefined}>
					{url ? (
						<video
							aria-label={name}
							controls
							muted
							onError={() => setFailedUrl(url)}
							playsInline
							preload="metadata"
							src={url}
						/>
					) : (
						<Icon aria-hidden className="omp-chat-media-placeholder" />
					)}
				</span>
			) : url ? (
				<audio aria-label={name} controls onError={() => setFailedUrl(url)} preload="metadata" src={url} />
			) : (
				<span className="omp-chat-media-audio-slot" aria-busy={loading || undefined}>
					<Icon aria-hidden className="omp-chat-media-placeholder" />
				</span>
			)}
			{loading ? (
				<span className="sr-only" role="status">
					{t("chat.media.loading")}
				</span>
			) : null}
			<PreviewCaption name={name} path={path} />
		</span>
	);
}

/** A document the transcript names: its chip, opening in the Files viewer. */
export function ViewerFileChip({
	path,
	kind,
	label,
	note,
}: {
	path: string;
	kind: ChatReferenceKind;
	label?: string;
	note?: string;
}) {
	const Icon = KIND_ICONS[kind];
	return (
		<FileChip
			data-chat-file={kind}
			icon={<Icon aria-hidden className="omp-file-chip-icon" />}
			label={label}
			note={note}
			opensIn="viewer"
			path={path}
		/>
	);
}

/** A picture the reply names by path: its thumbnail (zooms on click), or its chip. */
export function ImageThumb({ path, label }: { path: string; label?: string }) {
	const tabId = useRuntimeTabId() ?? undefined;
	const ref = useRef<HTMLElement>(null);
	const near = useNearViewport(ref);
	const [src, setSrc] = useState<string | null | undefined>(undefined);
	useEffect(() => {
		if (!near) return;
		let live = true;
		void (tabId ? window.omp.fs.readImage(path, tabId) : window.omp.fs.readImage(path))
			.then(result => live && setSrc(result.ok && result.dataUrl ? result.dataUrl : null))
			.catch(() => live && setSrc(null));
		return () => {
			live = false;
		};
	}, [near, path, tabId]);
	const name = label || basename(path) || path;
	return (
		<span className="omp-work-image omp-chat-thumb" data-chat-file="image" ref={ref} title={path}>
			{src === undefined ? (
				<span aria-hidden className="omp-chat-thumb-slot">
					<FileImage className="omp-chat-media-placeholder" />
				</span>
			) : (
				<ToolImage decoding="async" label={name} path={path} src={src} />
			)}
			<span className="omp-chat-thumb-caption font-mono">{name}</span>
		</span>
	);
}

type PdfThumbState = { status: "idle" | "loading" | "ready" } | { status: "failed"; note?: string };

/** A PDF the reply names: its first page (opening the Files viewer on click), or its chip. */
export function PdfThumb({ path, label }: { path: string; label?: string }) {
	const t = useT();
	const tabId = useRuntimeTabId() ?? undefined;
	const ref = useRef<HTMLElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const near = useNearViewport(ref);
	const [state, setState] = useState<PdfThumbState>({ status: "idle" });
	useEffect(() => {
		if (!near) return;
		let live = true;
		let destroy: (() => Promise<void>) | undefined;
		setState({ status: "loading" });
		void (async () => {
			try {
				const read = (maxBytes?: number) =>
					tabId ? window.omp.fs.readBinary(path, maxBytes, tabId) : window.omp.fs.readBinary(path, maxBytes);
				const probe = await read(512);
				if (!probe.ok) throw probe;
				if (probe.size > PDF_THUMB_MAX_BYTES) {
					if (live)
						setState({
							status: "failed",
							note: t("chat.media.tooLargePreview", { size: formatBytes(probe.size) }),
						});
					return;
				}
				const file = probe.truncated ? await read() : probe;
				if (!file.ok) throw file;
				// Lazy chunk: pdf.js loads only when a PDF preview is on screen, like the Files viewer's.
				const { getDocument } = await import("../../panels/viewers/pdf-runtime");
				if (!live) return;
				const task = getDocument({ data: file.data });
				destroy = () => task.destroy();
				const doc = await task.promise;
				const page = await doc.getPage(1);
				const canvas = canvasRef.current;
				if (!live || !canvas) return;
				const natural = page.getViewport({ scale: 1 });
				const viewport = page.getViewport({
					scale: (PDF_THUMB_WIDTH / natural.width) * (window.devicePixelRatio || 1),
				});
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				canvas.style.aspectRatio = `${natural.width} / ${natural.height}`;
				await page.render({ canvas, viewport }).promise;
				if (live) setState({ status: "ready" });
			} catch {
				if (live) setState({ status: "failed" });
			}
		})();
		return () => {
			live = false;
			void destroy?.();
		};
	}, [near, path, tabId, t]);
	const name = label || basename(path) || path;
	if (state.status === "failed") return <ViewerFileChip kind="pdf" label={name} note={state.note} path={path} />;
	return (
		<span
			className="omp-work-image omp-chat-thumb"
			data-chat-file="pdf"
			data-state={state.status}
			ref={ref}
			title={path}
		>
			<button
				type="button"
				className="omp-chat-thumb-page"
				aria-label={t("chat.media.pdfPage", { name })}
				aria-busy={state.status !== "ready" || undefined}
				onClick={() => useUiStore.getState().openFilePreview(path)}
			>
				<canvas aria-hidden ref={canvasRef} hidden={state.status !== "ready"} />
				{state.status === "ready" ? null : <FileBadge aria-hidden className="omp-chat-media-placeholder" />}
			</button>
			<span className="omp-chat-thumb-caption font-mono">{name}</span>
		</span>
	);
}

type HtmlPreviewState = { status: "closed" | "loading" } | { status: "open"; content: string } | { status: "failed" };

/**
 * A page the reply names: its chip with a Preview toggle. Opening reads it
 * (`fs.read`) into an empty-sandbox frame — no scripts, same-origin, forms,
 * popups or navigation; as srcdoc it inherits this window's CSP, so it fetches
 * nothing off the app — the Files viewer's own HTML isolation.
 */
export function HtmlPreview({ path, label }: { path: string; label?: string }) {
	const t = useT();
	const tabId = useRuntimeTabId() ?? undefined;
	const [state, setState] = useState<HtmlPreviewState>({ status: "closed" });
	const name = label || basename(path) || path;
	useEffect(() => {
		if (state.status !== "loading") return;
		let live = true;
		void (tabId ? window.omp.fs.read(path, HTML_PREVIEW_BYTES, tabId) : window.omp.fs.read(path, HTML_PREVIEW_BYTES))
			.then(result => {
				if (!live) return;
				setState(
					result.ok && typeof result.content === "string"
						? { status: "open", content: result.content }
						: { status: "failed" },
				);
			})
			.catch(() => live && setState({ status: "failed" }));
		return () => {
			live = false;
		};
	}, [state.status, path, tabId]);
	if (state.status === "failed") {
		return <ViewerFileChip kind="html" label={name} note={t("chat.media.unavailable")} path={path} />;
	}
	const open = state.status === "open";
	return (
		<span className="omp-chat-html" data-chat-file="html" data-state={state.status}>
			{open ? (
				<iframe
					// White canvas like a browser tab (and the Files viewer's frame): pages assume it.
					className="omp-chat-html-frame bg-white"
					data-html-rendered
					sandbox=""
					srcDoc={state.content}
					title={t("chat.media.htmlFrame", { name })}
				/>
			) : null}
			<PreviewCaption name={name} path={path}>
				<IconButton
					aria-expanded={open}
					disabled={state.status === "loading"}
					icon={open ? <EyeOff /> : <Eye />}
					label={t(open ? "chat.media.closePreview" : "chat.media.preview")}
					onClick={event => {
						event.stopPropagation();
						setState(open ? { status: "closed" } : { status: "loading" });
					}}
					size="sm"
				/>
			</PreviewCaption>
		</span>
	);
}

/** Players for the audio and video files a finished tool call produced or showed. */
export function ToolResultMedia({
	toolName,
	args,
	result,
}: {
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
}) {
	const media = useMemo(() => toolResultMedia(toolName, args, result), [toolName, args, result]);
	if (media.length === 0) return null;
	return (
		<div className="omp-tool-media">
			{media.map(item => (
				<ChatMedia key={item.path} kind={item.kind} path={item.path} />
			))}
		</div>
	);
}
