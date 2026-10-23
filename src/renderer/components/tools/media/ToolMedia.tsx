/**
 * Audio and video in the transcript (every other file a reply or prompt names is
 * a FileCard). A player reads its file the way the Files viewer does, for the
 * tab it belongs to (a paired host's tab reads on that host), and only once it
 * nears the viewport, through the shared media source (a seekable
 * `omp-media://` stream, or a host's bytes in a blob). A file that is missing,
 * refused, too big or undecodable shows as its chip.
 */
import { File, FileAudio, FileBadge, FileCode, FileImage, FileText, FileVideo, type LucideIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { basename, formatBytes } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useMediaSource } from "../../panels/viewers/media-source";
import { type ChatMediaKind, type ChatReferenceKind, toolResultMedia } from "./chat-media";
import { FileChip } from "./FileChip";
import { FileActions } from "./file-actions";
import { PathLink } from "./PathLink";

const KIND_ICONS: Record<ChatReferenceKind, LucideIcon> = {
	video: FileVideo,
	audio: FileAudio,
	pdf: FileBadge,
	html: FileCode,
	image: FileImage,
	document: FileText,
	file: File,
};

/** Previews start loading this far before they scroll into view. */
const NEAR_VIEWPORT = "600px 0px";

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

/** Name (opening the file natively) and the file's own buttons (file-actions.tsx), under a player. */
function PreviewCaption({ path, name, children }: { path: string; name: string; children?: ReactNode }) {
	return (
		<span className="omp-chat-media-caption">
			<PathLink path={path} className="omp-chat-media-name font-mono">
				{name}
			</PathLink>
			{children}
			<FileActions name={name} path={path} />
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
				actions={state.status !== "unavailable"}
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
				actions
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
