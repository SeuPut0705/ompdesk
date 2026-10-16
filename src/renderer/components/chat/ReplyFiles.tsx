/**
 * The files a reply names (chat-media.ts `referencedFiles`), under the reply:
 * players for audio and video, thumbnails for pictures and a PDF's first page,
 * a sandboxed preview for a page, a card for an Office or CSV document
 * (FileCard: first rows or slide, "type · rows/slides · size", "Deleted" once
 * it is gone). A picture a tool already showed in this tab
 * (the main agent's or a subagent's read, screenshot or capture of that path)
 * is not drawn a second time.
 */
import { useMemo } from "react";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { extractResultImages, resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import type { ToolEntry } from "../../stores/tools";
import { workFilePathKey } from "../tools/edit-args";
import { getToolHeader } from "../tools/index";
import type { ChatFileReference } from "../tools/media/chat-media";
import { FileCard } from "../tools/media/FileCard";
import { ChatMedia, HtmlPreview, ImageThumb, PdfThumb } from "../tools/media/ToolMedia";
import { useRunStores } from "./work/use-work-run";

/** Paths of the pictures finished tool calls showed, per entry map (maps are replaced, never mutated). */
const shownImages = new WeakMap<ReadonlyMap<string, ToolEntry>, readonly string[]>();

function toolImagePaths(entries: ReadonlyMap<string, ToolEntry>): readonly string[] {
	const cached = shownImages.get(entries);
	if (cached) return cached;
	const paths: string[] = [];
	for (const entry of entries.values()) {
		if (entry.isError || extractResultImages(entry.result).length === 0) continue;
		// The outcome row's own naming: stock read's mediaPath, else the call's path.
		const mediaPath = resultDetails(entry.result)?.mediaPath;
		const path = typeof mediaPath === "string" ? mediaPath : getToolHeader(entry.toolName, entry.args).path;
		if (path) paths.push(path);
	}
	shownImages.set(entries, paths);
	return paths;
}

function ReplyFileList({ references }: { references: readonly ChatFileReference[] }) {
	const t = useT();
	if (references.length === 0) return null;
	return (
		<div className="omp-chat-media-list" aria-label={t("chat.media.referenced")} role="group">
			{references.map(({ path, kind }) =>
				kind === "video" || kind === "audio" ? (
					<ChatMedia key={path} kind={kind} path={path} />
				) : kind === "image" ? (
					<ImageThumb key={path} path={path} />
				) : kind === "pdf" ? (
					<PdfThumb key={path} path={path} />
				) : kind === "document" ? (
					<FileCard key={path} path={path} />
				) : (
					<HtmlPreview key={path} path={path} />
				),
			)}
		</div>
	);
}

/** Pictures drop out when a tool of this tab already showed the same file. */
function ReplyFilesWithPictures({ references }: { references: readonly ChatFileReference[] }) {
	const { tools, subagents } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const toolsVersion = useFrameSelector(tools, state => state.finishedVersion);
	const surfacesKey = useFrameSelector(subagents, state =>
		[...state.surfaces.values()].map(surface => surface.getState().finishedVersion).join("|"),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the versions encode every entry map read here.
	const shown = useMemo(() => {
		const keys = new Set<string>();
		const maps = [
			tools.getState().finishedTools,
			...[...subagents.getState().surfaces.values()].map(s => s.getState().finishedTools),
		];
		for (const entries of maps) for (const path of toolImagePaths(entries)) keys.add(workFilePathKey(path, cwd));
		return keys;
	}, [toolsVersion, surfacesKey, cwd, tools, subagents]);
	const kept = references.filter(({ path, kind }) => kind !== "image" || !shown.has(workFilePathKey(path, cwd)));
	return <ReplyFileList references={kept} />;
}

export function ReplyFiles({ references }: { references: readonly ChatFileReference[] }) {
	return references.some(reference => reference.kind === "image") ? (
		<ReplyFilesWithPictures references={references} />
	) : (
		<ReplyFileList references={references} />
	);
}
