/**
 * Audio, video and documents in the transcript. A player reads its file the
 * way the Files viewer does — `fs.readBinary` for the tab (a paired host's tab
 * reads on that host), bytes into a blob URL (CSP `media-src blob:`) — only
 * once it nears the viewport, and only under CHAT_MEDIA_MAX_BYTES. A file
 * that is missing, refused, too big or undecodable shows as its chip, the
 * same way a picture whose bytes are gone does.
 */
import { FileAudio, FileBadge, FileCode, FileImage, Files, FileVideo, type LucideIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { ipcErrorCode } from "../../../shared/ipc-error-codes";
import { basename, formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { CHAT_MEDIA_MAX_BYTES } from "../../lib/preview";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { IconButton } from "../common/IconButton";
import { type ChatFileReference, type ChatMediaKind, type ChatReferenceKind, toolResultMedia } from "./chat-media";
import { PathLink } from "./PathLink";

const KIND_ICONS: Record<ChatReferenceKind, LucideIcon> = {
	video: FileVideo,
	audio: FileAudio,
	pdf: FileBadge,
	html: FileCode,
	svg: FileImage,
};

/** Bytes the first read asks for: enough for main to sniff the type, and it reports the size. */
const PROBE_BYTES = 512;
/** Players start loading this far before they scroll into view. */
const NEAR_VIEWPORT = "600px 0px";

/**
 * A file the transcript names but does not draw: its icon and basename. The
 * name opens the file natively (falling back to revealing it; a remote tab's
 * file opens in the Files viewer) or, with `opensIn="viewer"`, in the Files
 * viewer. `note` says why there is no preview (missing, too large).
 */
export function FileChip({
	path,
	label,
	icon,
	note,
	opensIn = "native",
	...data
}: {
	path: string;
	label?: string;
	icon: ReactNode;
	note?: string;
	opensIn?: "native" | "viewer";
} & Record<`data-${string}`, string | boolean | undefined>) {
	const name = label || basename(path) || path;
	const content = (
		<>
			{note ? <span className="sr-only">{note}: </span> : null}
			{name}
		</>
	);
	return (
		<span {...data} className="omp-file-chip" title={[note, path].filter(Boolean).join(" · ") || undefined}>
			{icon}
			{opensIn === "viewer" ? (
				<button
					type="button"
					className="omp-file-chip-name font-mono"
					title={path}
					onClick={event => {
						event.stopPropagation();
						useUiStore.getState().openFilePreview(path);
					}}
				>
					{content}
				</button>
			) : (
				<PathLink path={path} className="omp-file-chip-name font-mono">
					{content}
				</PathLink>
			)}
		</span>
	);
}

type MediaLoad = { status: "ready"; url: string } | { status: "tooLarge"; size: number } | { status: "unavailable" };

interface CachedMedia {
	refs: number;
	load: Promise<MediaLoad>;
}

/**
 * One blob per tab and file, shared by every player showing it (a tool card,
 * the work outcome and the reply can all name the same file) and revoked
 * when the last one unmounts.
 */
const mediaCache = new Map<string, CachedMedia>();

async function readMedia(path: string, tabId: string | null, kind: ChatMediaKind): Promise<MediaLoad> {
	const read = (maxBytes?: number) =>
		tabId ? window.omp.fs.readBinary(path, maxBytes, tabId) : window.omp.fs.readBinary(path, maxBytes);
	try {
		const probe = await read(PROBE_BYTES);
		if (probe.ok && probe.size > CHAT_MEDIA_MAX_BYTES) return { status: "tooLarge", size: probe.size };
		// A file within the probe came back whole; anything bigger is read once more, entire.
		const result = probe.ok && probe.truncated ? await read() : probe;
		if (!result.ok) {
			return ipcErrorCode(result) === "file_too_large"
				? { status: "tooLarge", size: result.size }
				: { status: "unavailable" };
		}
		// IPC structured clone always backs the bytes with a plain ArrayBuffer, never a shared one.
		const bytes = result.data as Uint8Array<ArrayBuffer>;
		const type = /^(?:audio|video)\//.test(result.mime) ? result.mime : `${kind}/*`;
		return { status: "ready", url: URL.createObjectURL(new Blob([bytes], { type })) };
	} catch {
		return { status: "unavailable" };
	}
}

function acquireMedia(key: string, load: () => Promise<MediaLoad>): Promise<MediaLoad> {
	const cached = mediaCache.get(key);
	if (cached) {
		cached.refs += 1;
		return cached.load;
	}
	const entry = { refs: 1, load: load() };
	mediaCache.set(key, entry);
	return entry.load;
}

function releaseMedia(key: string): void {
	const cached = mediaCache.get(key);
	if (!cached) return;
	cached.refs -= 1;
	if (cached.refs > 0) return;
	mediaCache.delete(key);
	void cached.load.then(loaded => {
		if (loaded.status === "ready") URL.revokeObjectURL(loaded.url);
	});
}

/** True once the element has come within NEAR_VIEWPORT of the screen (always, without IntersectionObserver). */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
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

/**
 * An inline player for a local audio or video file: native controls, the
 * first frame as its poster (`preload="metadata"`), never autoplaying or
 * looping, video muted until the user unmutes it. The caption names the file
 * (opening it natively) and opens it in the Files viewer.
 */
export function ChatMedia({ path, kind, label }: { path: string; kind: ChatMediaKind; label?: string }) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const ref = useRef<HTMLSpanElement>(null);
	const near = useNearViewport(ref);
	const [state, setState] = useState<MediaLoad | { status: "idle" } | { status: "loading" }>({ status: "idle" });
	const [undecodable, setUndecodable] = useState(false);

	useEffect(() => {
		if (!near) return;
		let live = true;
		const key = `${tabId ?? ""}\0${path}`;
		setState({ status: "loading" });
		setUndecodable(false);
		void acquireMedia(key, () => readMedia(path, tabId, kind)).then(loaded => {
			if (live) setState(loaded);
		});
		return () => {
			live = false;
			releaseMedia(key);
		};
	}, [near, path, tabId, kind]);

	const name = label || basename(path) || path;
	const Icon = KIND_ICONS[kind];
	const chipIcon = <Icon aria-hidden className="omp-file-chip-icon" />;
	if (state.status === "unavailable" || undecodable) {
		return (
			<FileChip
				data-chat-media-unavailable={kind}
				icon={chipIcon}
				label={name}
				note={t(undecodable ? "chat.media.unplayable" : "chat.media.unavailable")}
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
	const url = state.status === "ready" ? state.url : undefined;
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
							onError={() => setUndecodable(true)}
							playsInline
							preload="metadata"
							src={url}
						/>
					) : (
						<Icon aria-hidden className="omp-chat-media-placeholder" />
					)}
				</span>
			) : url ? (
				<audio aria-label={name} controls onError={() => setUndecodable(true)} preload="metadata" src={url} />
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
			<span className="omp-chat-media-caption">
				<PathLink path={path} className="omp-chat-media-name font-mono">
					{name}
				</PathLink>
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
		</span>
	);
}

/** A document the transcript names (PDF, HTML, SVG): its chip, opening in the Files viewer. */
export function ViewerFileChip({ path, kind, label }: { path: string; kind: ChatReferenceKind; label?: string }) {
	const Icon = KIND_ICONS[kind];
	return (
		<FileChip
			data-chat-file={kind}
			icon={<Icon aria-hidden className="omp-file-chip-icon" />}
			label={label}
			opensIn="viewer"
			path={path}
		/>
	);
}

/** The players and chips for files a reply names, under the reply. */
export function ReferencedFiles({ references }: { references: readonly ChatFileReference[] }) {
	const t = useT();
	if (references.length === 0) return null;
	return (
		<div className="omp-chat-media-list" aria-label={t("chat.media.referenced")} role="group">
			{references.map(reference =>
				reference.kind === "video" || reference.kind === "audio" ? (
					<ChatMedia key={reference.path} kind={reference.kind} path={reference.path} />
				) : (
					<ViewerFileChip key={reference.path} kind={reference.kind} path={reference.path} />
				),
			)}
		</div>
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
