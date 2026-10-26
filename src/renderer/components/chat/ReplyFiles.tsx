/**
 * The files a reply names (chat-media.ts `referencedFiles`), under the reply:
 * players for audio and video, and a FileCard for everything else (a picture,
 * a PDF's first page, a page drawn in a sandbox, a document's first rows or
 * slide; a row for an archive or another file it hands over), each with its
 * preview, its place (Finder/Explorer here, saving it from a paired host or to
 * the phone) and its menu. A picture a tool already showed in this tab (the
 * main agent's or a subagent's read, screenshot or capture of that path) is not
 * drawn a second time; a text file it links by an absolute path inside the
 * tab's folder is a citation and stays in the text; a file it names that is
 * not there (moved, deleted, never written) draws nothing.
 */
import { useMemo } from "react";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { extractResultImages, resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import type { ToolEntry } from "../../stores/tools";
import { workFilePathKey } from "../tools/edit-args";
import { getToolHeader } from "../tools/index";
import { type ChatFileReference, chatReferenceKind } from "../tools/media/chat-media";
import { FileCard } from "../tools/media/FileCard";
import { ChatMedia } from "../tools/media/ToolMedia";
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
				) : (
					<FileCard hideMissing key={path} path={path} />
				),
			)}
		</div>
	);
}

/** `path` sits in the tab's folder `cwd` (both as the tab's machine spells them). */
function insideFolder(path: string, cwd: string): boolean {
	if (!cwd) return false;
	const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
	const spell = (value: string) => (windows ? value.replace(/\\/g, "/").toLowerCase() : value);
	return spell(path).startsWith(`${spell(cwd).replace(/[\\/]+$/, "")}/`);
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
	const cwd = useSessionStore(state => state.cwd);
	// A text file linked by its absolute path inside the project is code the reply cites.
	const handed = references.filter(
		({ path, kind }) => kind !== "file" || chatReferenceKind(path) !== null || !insideFolder(path, cwd),
	);
	return handed.some(reference => reference.kind === "image") ? (
		<ReplyFilesWithPictures references={handed} />
	) : (
		<ReplyFileList references={handed} />
	);
}

/** A file a prompt mentions: `inText` when its mention still reads in the prompt's text (a sentence names it). */
export interface PromptFile {
	path: string;
	inText: boolean;
}

/**
 * The files a prompt attached (its `@path` mentions, which omp reads as it sends), under the prompt as cards.
 * One whose line left the text shows even once it is gone ("Deleted"); one a sentence names shows only while
 * it is there (a `@word` that names no file is prose).
 */
export function PromptFiles({ files }: { files: readonly PromptFile[] }) {
	const t = useT();
	if (files.length === 0) return null;
	return (
		<div aria-label={t("chat.promptFiles")} className="omp-prompt-files" data-prompt-files="" role="group">
			{files.map(file => (
				<FileCard hideMissing={file.inText} key={file.path} path={file.path} />
			))}
		</div>
	);
}
